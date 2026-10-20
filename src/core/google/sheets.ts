/**
 * `SheetsClient` над `googleapis`: перевод ответа Google в доменный снимок (§8.1).
 *
 * Здесь единственное место, где ядро видит форму библиотеки. Всё остальное работает
 * с нашими типами — поэтому 100 % логики карты, резолвера и записи проверяется без сети.
 */

import { google, type drive_v3, type sheets_v4 } from 'googleapis';

import { fromGoogleError, gcError } from '../errors.js';
import { toFormat, toHex } from './cell-format.js';
import { authorizedClient, makeRetry, type RetryReporter } from './support.js';
import { toRequest } from './requests.js';
import { rangesFor, withRowLimit } from './sheet-ranges.js';
import { denyByRule, limitOf } from '../policy.js';
import type {
  Cell,
  CellValue,
  GridRange,
  ReadOptions,
  RowWindow,
  SheetExtras,
  SheetProperties,
  SheetRequest,
  SheetSnapshot,
  SheetTitle,
  SheetsClient,
  SpreadsheetSnapshot,
  ValidationRule,
} from '../sheets/types.js';

/**
 * Предел листа, который запись читает целиком (D-26): больше строк сетки — отказ правилом
 * `write.full-sheet`, а не расчёт по части листа. Источник — правило `write.max-sheet-rows`.
 */
export const WRITE_MAX_SHEET_ROWS = limitOf('write.max-sheet-rows', 50_000);

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

/**
 * Заметка ячейки (Q23): `CellData.note` приходит в том же ответе `includeGridData`, отдельного
 * запроса не нужно. Пустая и из одних пробелов — не заметка: правила в ней нет.
 */
const noteOf = (note: string | null | undefined): string | undefined =>
  typeof note === 'string' && note.trim() !== '' ? note : undefined;

function toCell(cell: sheets_v4.Schema$CellData): Cell {
  const formula = cell.userEnteredValue?.formulaValue;
  const value = cellValue(cell);
  const format = toFormat(cell);
  const note = noteOf(cell.note);
  return {
    value,
    ...(formula === undefined || formula === null ? {} : { formula }),
    ...(format === undefined ? {} : { format }),
    ...(note === undefined ? {} : { note }),
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

  const gridRows = properties.gridProperties?.rowCount;
  return {
    title: properties.title ?? 'Лист',
    sheetId: properties.sheetId ?? 0,
    rows: rowData.map((row) => (row.values ?? []).map(toCell)),
    ...(gridRows === undefined || gridRows === null ? {} : { gridRows }),
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
 * Заметки к ячейкам здесь НЕ считаются, и это названная непокрытость: с Q23 ядро их читает
 * (`toCell`), но откат их не пишет — лист или строки с заметками вернутся без них, а план
 * удаления этого пока не называет.
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
  partial = false,
): SpreadsheetSnapshot {
  const sheets = (data.sheets ?? []).map(toSheetSnapshot);
  if (sheets.length === 0) {
    throw gcError('not_found', { detail: `В таблице ${id} нет листов или нет доступа к сетке.` });
  }
  return {
    id,
    title: data.properties?.title ?? 'Таблица',
    ...(revisionId === undefined ? {} : { revisionId }),
    // Локаль книги — вид дат для колонки без своих дат (Q15): «ru_RU» — 19.10.2026, а не ISO.
    ...(data.properties?.locale ? { locale: data.properties.locale } : {}),
    ...(partial ? { partial: true } : {}),
    sheets,
  };
}

/** Окно строк из ответа Google: строки подряд от начала диапазона и размер сетки листа. */
function toRowWindow(data: sheets_v4.Schema$Spreadsheet): RowWindow {
  const found = data.sheets?.[0];
  const rowData = found?.data?.[0]?.rowData ?? [];
  return {
    rows: rowData.map((row) => (row.values ?? []).map(toCell)),
    gridRows: found?.properties?.gridProperties?.rowCount ?? 0,
  };
}

export interface GoogleSheetsClientOptions {
  readonly accessToken: string;
  /** Сообщает о повторе, чтобы наверху можно было показать «попытка 2 из 3». */
  readonly onRetry?: RetryReporter;
  /**
   * Внедрённый API — шов судится на живой форме ответа Google, как у Docs (урок L28): фейк
   * клиента целиком потолка чтения не видел, и запись по обрезанному листу жила незамеченной.
   */
  readonly api?: { readonly sheets: sheets_v4.Sheets; readonly drive: drive_v3.Drive };
}

export class GoogleSheetsClient implements SheetsClient {
  private readonly sheets: sheets_v4.Sheets;
  private readonly drive: drive_v3.Drive;
  private readonly retry: ReturnType<typeof makeRetry>;

  constructor(options: GoogleSheetsClientOptions) {
    if (options.api === undefined) {
      const auth = authorizedClient(options.accessToken);
      this.sheets = google.sheets({ version: 'v4', auth });
      this.drive = google.drive({ version: 'v3', auth });
    } else {
      this.sheets = options.api.sheets;
      this.drive = options.api.drive;
    }
    this.retry = makeRetry(options.onRetry);
  }

  async getSpreadsheet(id: string, options: ReadOptions = {}): Promise<SpreadsheetSnapshot> {
    try {
      // Названный лист без `maxRows` — ЦЕЛИКОМ (D-26): по этому снимку считаются запись,
      // превью, предусловие и откат. Раньше здесь стояло `A1:ZZ500` для всех, и на листе в
      // 1630 строк `appendRow` писал в занятую 501-ю: предусловие видело её пустой.
      if (options.sheet !== undefined && options.maxRows === undefined) {
        await this.assertWholeSheetFits(id, options.sheet);
      }
      const ranges = rangesFor(options);
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

      return withRowLimit(
        toSpreadsheetSnapshot(response.data, id, revisionId, ranges !== undefined),
        options.maxRows,
      );
    } catch (error) {
      throw fromGoogleError(error, `Не удалось прочитать таблицу ${id}.`);
    }
  }

  /**
   * Размер листа — до чтения сетки (урок L11: дорогой отказ — тоже дефект): лист, который
   * запись не может прочитать целиком, отказывает сразу, а не после минуты чтения.
   */
  private async assertWholeSheetFits(id: string, sheet: string): Promise<void> {
    const meta = await this.retry(() =>
      this.sheets.spreadsheets.get({
        spreadsheetId: id,
        fields: 'sheets.properties(title,gridProperties.rowCount)',
      }),
    );
    const found = meta.data.sheets?.find((s) => s.properties?.title === sheet);
    const rows = found?.properties?.gridProperties?.rowCount ?? 0;
    if (rows <= WRITE_MAX_SHEET_ROWS) return;
    denyByRule(
      'write.full-sheet',
      `Лист «${sheet}» — ${rows} строк сетки, больше предела ${WRITE_MAX_SHEET_ROWS}: правку по ` +
        'нему пришлось бы считать по части листа, а это затирает чужие строки. Запись не ' +
        'выполнена; читать лист можно окнами (gc_read mode=values с fromRow).',
    );
  }

  async readRows(id: string, sheet: string, fromRow: number, count: number): Promise<RowWindow> {
    try {
      const response = await this.retry(() =>
        this.sheets.spreadsheets.get({
          spreadsheetId: id,
          includeGridData: true,
          ranges: [`'${sheet}'!A${fromRow}:ZZ${fromRow + count - 1}`],
        }),
      );
      return toRowWindow(response.data);
    } catch (error) {
      throw fromGoogleError(error, `Не удалось прочитать строки таблицы ${id}.`);
    }
  }

  async batchUpdateValues(
    id: string,
    cells: readonly { readonly range: string; readonly value: CellValue }[],
  ): Promise<void> {
    try {
      await this.retry(() =>
        this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: cells.map((cell) => ({ range: cell.range, values: [[cell.value]] })),
          },
        }),
      );
    } catch (error) {
      throw fromGoogleError(error, `Не удалось записать в таблицу ${id}.`);
    }
  }

  async updateValues(
    id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
    input: 'user' | 'raw' = 'user',
  ): Promise<void> {
    try {
      await this.retry(() =>
        this.sheets.spreadsheets.values.update({
          spreadsheetId: id,
          range,
          // USER_ENTERED: значение попадает так, как если бы его набрал человек —
          // дата остаётся датой, а не строкой. RAW — текстом, как есть: для данных,
          // которые человек продиктовал (шапка и строки новой таблицы, D-23).
          valueInputOption: input === 'raw' ? 'RAW' : 'USER_ENTERED',
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
  /**
   * Листы книги одним дешёвым вызовом: `fields` без сетки — имя и `sheetId` (он же `gid` в
   * ссылке на вкладку, Q27).
   *
   * Цена названа: это дополнительный запрос там, где раньше врала карта. Полное чтение
   * книги ради имён стоило бы у владельца ~28 000 ячеек за проверку одного имени.
   */
  async sheetTitles(id: string): Promise<readonly SheetTitle[]> {
    try {
      const response = await this.retry(() =>
        this.sheets.spreadsheets.get({
          spreadsheetId: id,
          fields: 'sheets.properties(sheetId,title)',
        }),
      );
      return (response.data.sheets ?? []).flatMap(({ properties }) => {
        const title = properties?.title;
        // Нет `sheetId` — 0, как в `toSheetSnapshot`: один лист не должен читаться двумя номерами.
        const sheetId = properties?.sheetId ?? 0;
        return title === undefined || title === null ? [] : [{ title, sheetId }];
      });
    } catch (error) {
      throw fromGoogleError(error, `Не удалось прочитать список листов ${id}.`);
    }
  }

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
