/**
 * `SheetsClient` над `googleapis`: перевод ответа Google в доменный снимок (§8.1).
 *
 * Здесь единственное место, где ядро видит форму библиотеки. Всё остальное работает
 * с нашими типами — поэтому 100 % логики карты, резолвера и записи проверяется без сети.
 */

import { google, type sheets_v4 } from 'googleapis';

import { fromGoogleError, gcError } from '../errors.ts';
import { withRetry } from '../retry.ts';
import type {
  Cell,
  CellValue,
  ReadOptions,
  SheetSnapshot,
  SheetsClient,
  SpreadsheetSnapshot,
  ValidationRule,
} from '../sheets/types.ts';

const DEFAULT_MAX_ROWS = 500;

/**
 * Форматы, при которых значение ячейки для человека — СТРОКА, а не число.
 * Дата в Sheets API приходит двумя видами сразу: `effectiveValue.numberValue` = 46266
 * (серийный номер) и `formattedValue` = «2026-09-01». Брать первое — значит положить в
 * карту 46266, потерять тип «дата» и формат колонки, а потом записать дату числом.
 * Поймано тестом шва, живое чтение это пропустило: в той таблице не было колонки с датами.
 */
const TEXTUAL_FORMATS = new Set(['DATE', 'DATE_TIME', 'TIME']);

/** `null` в ответе Google значит «поля нет», а не «значение null». */
const some = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

function cellValue(cell: sheets_v4.Schema$CellData): CellValue {
  const formatType = some(cell.effectiveFormat?.numberFormat?.type);
  if (formatType !== undefined && TEXTUAL_FORMATS.has(formatType)) {
    return some(cell.formattedValue) ?? null;
  }
  const effective = cell.effectiveValue;
  return (
    some(effective?.numberValue) ??
    some(effective?.boolValue) ??
    some(effective?.stringValue) ??
    // formattedValue — то, что человек видит в ячейке.
    some(cell.formattedValue) ??
    null
  );
}

function toCell(cell: sheets_v4.Schema$CellData): Cell {
  const formula = cell.userEnteredValue?.formulaValue;
  const value = cellValue(cell);
  return formula === undefined || formula === null ? { value } : { value, formula };
}

/**
 * Список допустимых значений приходит в Google на КАЖДУЮ ячейку, а карте нужен на колонку.
 * Берём правило с первой строки данных — ровно то, что проверяет `buildSheetMap`.
 */
function oneOfListValues(cell: sheets_v4.Schema$CellData | undefined): string[] {
  const condition = cell?.dataValidation?.condition;
  if (condition?.type !== 'ONE_OF_LIST') return [];
  return (condition.values ?? [])
    .map((v) => v.userEnteredValue)
    .filter((v): v is string => typeof v === 'string');
}

function validationsOf(sheet: sheets_v4.Schema$Sheet): ValidationRule[] {
  const rows = sheet.data?.[0]?.rowData ?? [];
  const out: ValidationRule[] = [];
  rows.forEach((rowData, rowIndex) => {
    (rowData.values ?? []).forEach((cell, columnIndex) => {
      const values = oneOfListValues(cell);
      if (values.length === 0) return;
      const row = rowIndex + 1;
      out.push({
        range: { startRow: row, endRow: row, startColumn: columnIndex, endColumn: columnIndex },
        values,
      });
    });
  });
  return out;
}

export function toSheetSnapshot(sheet: sheets_v4.Schema$Sheet): SheetSnapshot {
  const properties = sheet.properties ?? {};
  const rowData = sheet.data?.[0]?.rowData ?? [];
  const frozen = properties.gridProperties?.frozenRowCount;
  const protectedRanges = (sheet.protectedRanges ?? []).flatMap((range) => {
    const r = range.range;
    if (r === undefined || r === null) return [];
    return [
      {
        startRow: (r.startRowIndex ?? 0) + 1,
        endRow: r.endRowIndex ?? 100_000,
        startColumn: r.startColumnIndex ?? 0,
        endColumn: (r.endColumnIndex ?? 1000) - 1,
      },
    ];
  });

  return {
    title: properties.title ?? 'Лист',
    sheetId: properties.sheetId ?? 0,
    rows: rowData.map((row) => (row.values ?? []).map(toCell)),
    ...(frozen === undefined || frozen === null ? {} : { frozenRows: frozen }),
    validations: validationsOf(sheet),
    protectedRanges,
  };
}

/**
 * Ответ Google → доменный снимок. Вынесено отдельно и экспортировано ради тестов:
 * это единственное место, где ядро зависит от формы библиотеки, и именно оно ломается
 * при смене версии — значит проверяться должно без сети.
 */
export function toSpreadsheetSnapshot(
  data: sheets_v4.Schema$Spreadsheet,
  id: string,
  revisionId?: string,
): SpreadsheetSnapshot {
  const sheets = (data.sheets ?? []).map(toSheetSnapshot);
  if (sheets.length === 0) {
    throw gcError('not_found', { detail: `В таблице ${id} нет листов или нет доступа к сетке.` });
  }
  return {
    id,
    title: data.properties?.title ?? 'Таблица',
    ...(revisionId === undefined ? {} : { revisionId }),
    sheets,
  };
}

export interface GoogleSheetsClientOptions {
  readonly accessToken: string;
  readonly maxRows?: number;
  /** Сообщает о повторе, чтобы наверху можно было показать «попытка 2 из 3». */
  readonly onRetry?: (attempt: number, total: number, delayMs: number) => void;
}

export class GoogleSheetsClient implements SheetsClient {
  private readonly sheets: sheets_v4.Sheets;
  private readonly drive;
  private readonly maxRows: number;
  private readonly onRetry: GoogleSheetsClientOptions['onRetry'];

  constructor(options: GoogleSheetsClientOptions) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: options.accessToken });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.drive = google.drive({ version: 'v3', auth });
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.onRetry = options.onRetry;
  }

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.onRetry === undefined ? {} : { onRetry: this.onRetry });
  }

  async getSpreadsheet(id: string, options: ReadOptions = {}): Promise<SpreadsheetSnapshot> {
    const maxRows = options.maxRows ?? this.maxRows;
    try {
      // Один запрос: метаданные всех листов + сетка только нужного диапазона.
      const ranges =
        options.sheet === undefined ? undefined : [`'${options.sheet}'!A1:ZZ${maxRows}`];
      const response = await this.retry(() =>
        this.sheets.spreadsheets.get({
          spreadsheetId: id,
          includeGridData: true,
          ...(ranges === undefined ? {} : { ranges }),
        }),
      );

      // Ревизия для защиты от гонки: у Docs-файлов её роль играет `version` из Drive.
      let revisionId: string | undefined;
      try {
        const file = await this.retry(() =>
          this.drive.files.get({ fileId: id, fields: 'version' }),
        );
        const version = file.data.version;
        if (version !== undefined && version !== null) revisionId = String(version);
      } catch {
        revisionId = undefined;
      }

      return toSpreadsheetSnapshot(response.data, id, revisionId);
    } catch (error) {
      throw fromGoogleError(error, `Не удалось прочитать таблицу ${id}.`);
    }
  }

  async updateValues(
    id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
  ): Promise<void> {
    try {
      await this.retry(() =>
        this.sheets.spreadsheets.values.update({
          spreadsheetId: id,
          range,
          // USER_ENTERED: значение попадает так, как если бы его набрал человек —
          // дата остаётся датой, а не строкой.
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: values.map((row) => [...row]) },
        }),
      );
    } catch (error) {
      throw fromGoogleError(error, `Не удалось записать в ${range}.`);
    }
  }

  async appendValues(
    id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
  ): Promise<void> {
    try {
      await this.retry(() =>
        this.sheets.spreadsheets.values.append({
          spreadsheetId: id,
          range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: values.map((row) => [...row]) },
        }),
      );
    } catch (error) {
      throw fromGoogleError(error, `Не удалось дописать в ${range}.`);
    }
  }
}
