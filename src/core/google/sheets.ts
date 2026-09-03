/**
 * `SheetsClient` над `googleapis`: перевод ответа Google в доменный снимок (§8.1).
 *
 * Здесь единственное место, где ядро видит форму библиотеки. Всё остальное работает
 * с нашими типами — поэтому 100 % логики карты, резолвера и записи проверяется без сети.
 */

import { google, type sheets_v4 } from 'googleapis';

import { fromGoogleError, gcError } from '../errors.js';
import { toRequest } from './requests.js';
import { limitOf } from '../policy.js';
import { withRetry } from '../retry.js';
import type {
  Cell,
  CellFormat,
  CellValue,
  GridRange,
  ReadOptions,
  SheetExtras,
  SheetProperties,
  SheetRequest,
  SheetSnapshot,
  SheetsClient,
  SpreadsheetSnapshot,
  ValidationRule,
} from '../sheets/types.js';

/** Источник истины — правило `read.max-rows` в rules.json; число здесь только страховка. */
export const DEFAULT_MAX_ROWS = limitOf('read.max-rows', 500);

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

/** `{red: 1, green: 0.5}` → `#ff8000`. Google отдаёт доли, человек вводит hex. */
function toHex(color: sheets_v4.Schema$Color | undefined): string | undefined {
  if (color === undefined || color === null) return undefined;
  const part = (v: number | null | undefined): string =>
    Math.round((v ?? 0) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(color.red)}${part(color.green)}${part(color.blue)}`;
}

/** `LEFT|CENTER|RIGHT` из ответа → доменное выравнивание; всё остальное игнорируем. */
function toAlign(value: string | null | undefined): CellFormat['align'] | undefined {
  if (value === 'LEFT' || value === 'CENTER' || value === 'RIGHT') {
    return value.toLowerCase() as CellFormat['align'];
  }
  return undefined;
}

/** Поле вида попадает в домен только когда задано явно: `undefined` и `false` — разное. */
function flag(value: boolean | null | undefined): boolean | undefined {
  return value === undefined || value === null ? undefined : value;
}

/**
 * Явный вид ячейки. Берётся `userEnteredFormat`, а НЕ `effectiveFormat`: второй показывает
 * и то, что пришло от темы или условного форматирования, — откатывать такое ядру нечем, а
 * показать в превью «было → станет» значило бы обещать правку чужого механизма.
 */
function toFormat(cell: sheets_v4.Schema$CellData): CellFormat | undefined {
  const format = cell.userEnteredFormat;
  if (format === undefined || format === null) return undefined;
  const text = format.textFormat ?? {};
  const fields = {
    bold: flag(text.bold),
    italic: flag(text.italic),
    underline: flag(text.underline),
    align: toAlign(format.horizontalAlignment),
    background: toHex(format.backgroundColor ?? undefined),
  };
  const out = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as CellFormat;
  return Object.keys(out).length === 0 ? undefined : out;
}

function toCell(cell: sheets_v4.Schema$CellData): Cell {
  const formula = cell.userEnteredValue?.formulaValue;
  const value = cellValue(cell);
  const format = toFormat(cell);
  return {
    value,
    ...(formula === undefined || formula === null ? {} : { formula }),
    ...(format === undefined ? {} : { format }),
  };
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

/** Защищённые диапазоны в домен: 1-based строки, включительные колонки. */
function protectedRangesOf(sheet: sheets_v4.Schema$Sheet): GridRange[] {
  return (sheet.protectedRanges ?? []).flatMap((range) => {
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
}

function mergesOf(sheet: sheets_v4.Schema$Sheet): GridRange[] {
  return (sheet.merges ?? []).map((r) => ({
    startRow: (r.startRowIndex ?? 0) + 1,
    endRow: r.endRowIndex ?? 0,
    startColumn: r.startColumnIndex ?? 0,
    endColumn: (r.endColumnIndex ?? 1) - 1,
  }));
}

export function toSheetSnapshot(sheet: sheets_v4.Schema$Sheet): SheetSnapshot {
  const properties = sheet.properties ?? {};
  const rowData = sheet.data?.[0]?.rowData ?? [];
  const frozen = properties.gridProperties?.frozenRowCount;
  const protectedRanges = protectedRangesOf(sheet);
  const merges = mergesOf(sheet);

  return {
    title: properties.title ?? 'Лист',
    sheetId: properties.sheetId ?? 0,
    rows: rowData.map((row) => (row.values ?? []).map(toCell)),
    merges,
    ...(frozen === undefined || frozen === null ? {} : { frozenRows: frozen }),
    validations: validationsOf(sheet),
    protectedRanges,
    properties: sheetPropertiesOf(sheet),
    extras: extrasOf(sheet, rowData),
  };
}

/**
 * Свойства листа, которые откат умеет вернуть (D-19). Больше здесь не нужно: всё, чего
 * в этом наборе нет, план обязан назвать потерей — см. `extrasOf`.
 */
function sheetPropertiesOf(sheet: sheets_v4.Schema$Sheet): SheetProperties {
  const properties = sheet.properties ?? {};
  const grid = properties.gridProperties ?? {};
  return definedOnly<SheetProperties>({
    frozenRows: grid.frozenRowCount,
    frozenColumns: grid.frozenColumnCount,
    tabColor: toHex(properties.tabColorStyle?.rgbColor ?? properties.tabColor ?? undefined),
    hidden: properties.hidden,
  });
}

/**
 * Убрать поля со значением `null` или `undefined`.
 *
 * При `exactOptionalPropertyTypes` «поля нет» и «поле undefined» — разные типы, и чистка
 * обязана быть в ОДНОМ месте: гейт сложности отклонил четыре тернарника подряд, и он прав,
 * потому что читать их приходится по одному, а ошибка в любом даёт лишнее поле в домене.
 */
function definedOnly<T extends object>(value: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  ) as T;
}

/**
 * Сколько на листе того, чего откат не вернёт. Числа, а не признаки: человеку перед
 * удалением листа нужно «3 правила условного форматирования», а не «есть форматирование».
 *
 * Заметки к ячейкам здесь НЕ считаются, и это названная непокрытость: ядро их не читает
 * вовсе (`toCell` их не переносит), поэтому и обещать их подсчёт нельзя.
 */
function extrasOf(
  sheet: sheets_v4.Schema$Sheet,
  rowData: readonly sheets_v4.Schema$RowData[],
): SheetExtras {
  return {
    conditionalFormats: countOf(sheet.conditionalFormats),
    dataValidations: rowData.reduce((sum, row) => sum + countOf(withValidation(row)), 0),
    protectedRanges: countOf(sheet.protectedRanges),
    charts: countOf(sheet.charts),
    filters: countOf(sheet.filterViews) + (present(sheet.basicFilter) ? 1 : 0),
  };
}

const countOf = (list: readonly unknown[] | null | undefined): number => list?.length ?? 0;
const present = (value: unknown): boolean => value !== undefined && value !== null;
const withValidation = (row: sheets_v4.Schema$RowData): sheets_v4.Schema$CellData[] =>
  (row.values ?? []).filter((cell) => present(cell.dataValidation));

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

  /**
   * Правки вне values-API. Доменный запрос переводится в `repeatCell` здесь и только здесь.
   *
   * `fields` собирается из ЗАДАННЫХ полей: без маски Google затирает весь формат ячейки, и
   * `{ bold: true }` снял бы и выравнивание, и фон. Маска — не оптимизация, а разница между
   * «сделать жирным» и «сделать жирным, стереть остальное».
   */
  async batchUpdate(id: string, requests: readonly SheetRequest[]): Promise<void> {
    if (requests.length === 0) return;
    const body = requests.map((request) => toRequest(request));
    try {
      await this.retry(() =>
        this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: { requests: body },
        }),
      );
    } catch (error) {
      throw fromGoogleError(error, `Не удалось применить ${requests.length} правк(и).`);
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
