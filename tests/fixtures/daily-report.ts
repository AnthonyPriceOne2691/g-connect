/**
 * Лист ежедневного отчёта — весть сессии соседнего проекта (D-26, Q39, Q41, Q42). Новые дни сверху,
 * шапка в строке 1 (A1 пуста, B1–F1 подписаны), строка 2 — объединённая A2:F2 с пометкой; строки
 * 3–4 агент вставил над днём 19.10, и они унаследовали его вид. Отдельным модулем: лист делят сьют
 * записи по номерам строк и сброса формата числа (`daily-report.test.ts`) и сьют правки вида по
 * образцу строки (`like-row.test.ts`), а у одного файла сьютов кончался предел длины.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';

import { toRequest } from '../../src/core/google/requests.js';
import { GoogleSheetsClient } from '../../src/core/google/sheets.js';
import type { WriteRecord } from '../../src/core/journal.js';
import type {
  Cell,
  CellFormat,
  SheetSnapshot,
  SheetsClient,
  SpreadsheetSnapshot,
} from '../../src/core/sheets/types.js';
import type { ToolDeps } from '../../src/mcp/tools.js';
import { MutableSheetsClient, row } from './sheet.js';

export const ID = '1DAILYreportGGGGGGGGGGGGGGGGGGGGGGGGG';
export const TITLE = 'Отчёт';
export const COLUMNS = ['Суть задачи', 'Время', 'Ссылка', 'Статус задачи', 'Проверка'] as const;

/** Вид строки дня — его и унаследовали вставленные строки. */
export const DAY: CellFormat = { numberFormat: { type: 'DATE', pattern: 'dd.mm' } };
export const SPENT: CellFormat = { numberFormat: { type: 'TIME', pattern: 'h:mm' } };

/** Строка дня: дата в «Сути задачи», итог времени — в «Времени». */
const dayRow = (date: string, total: string): Cell[] => [
  { value: null },
  { value: date, format: DAY },
  { value: total, format: SPENT },
  { value: null },
  { value: null },
  { value: null },
];

/** Строка, вставленная над днём: значений нет, вид — от строки дня. */
const insertedRow = (): Cell[] => dayRow('', '').map((cell) => ({ ...cell, value: null }));

/**
 * Лист как в вести: строки 3–4 пусты внутри данных, с пятой — дни и задачи; последняя строка
 * данных — девятая. Ниже — пустой хвост сетки: данными он не считается.
 */
export function dailySheet(): SheetSnapshot {
  return {
    title: TITLE,
    sheetId: 5,
    rows: [
      row(null, ...COLUMNS),
      row('Новые дни — сверху', null, null, null, null, null),
      insertedRow(),
      insertedRow(),
      dayRow('19.10', '2:15'),
      row(null, 'разбор входящих заявок', '1:30', 'https://example.com/task/1', 'готово', 'да'),
      row(null, 'созвон по отчёту', '0:45', 'https://example.com/task/2', 'в работе', 'нет'),
      dayRow('18.10', '2:00'),
      row(null, 'правка шаблона', '2:00', 'https://example.com/task/3', 'готово', 'да'),
      row(null, null, null, null, null, null),
    ],
    merges: [{ startRow: 2, endRow: 2, startColumn: 0, endColumn: 5 }],
  };
}

export const book = (sheet: SheetSnapshot = dailySheet()): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Дневник задач',
  revisionId: 'rev-1',
  sheets: [sheet],
});

/** Ячейка листа с другим значением или видом — «между превью и записью в B3 вписали своё». */
export function withCell(
  sheet: SheetSnapshot,
  rowNumber: number,
  column: number,
  patch: Partial<Cell>,
): SheetSnapshot {
  const rows = sheet.rows.map((cells) => [...cells]);
  const target = rows[rowNumber - 1]!;
  target[column] = { ...target[column]!, ...patch };
  return { ...sheet, rows };
}

/** Цель реестра с конвертом записи значений и вида; шапка — строка 1. */
export function depsOf(client: SheetsClient, journalled: WriteRecord[], maxCells = 50): ToolDeps {
  return {
    account: 'work',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () =>
      Promise.resolve({
        targets: [
          {
            alias: 'daily',
            id: ID,
            type: 'sheet',
            allow: 'write',
            sheet: TITLE,
            headerRow: 1,
            auto: { ops: ['setCells', 'formatCells'], maxCells },
          },
        ],
      }),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('rev-1'),
  };
}

export function harness(maxCells?: number, sheet: SheetSnapshot = dailySheet()) {
  const client = new MutableSheetsClient(book(sheet));
  const journalled: WriteRecord[] = [];
  return { client, journalled, deps: depsOf(client, journalled, maxCells) };
}

/** Google недоступен: отказ обязан случиться на границе ядра, ДО чтения листа (урок L11). */
export const withoutGoogle = (): ToolDeps => ({
  ...harness().deps,
  sheets: () => Promise.reject(new TypeError('Google тронут: отказ опоздал до чтения листа')),
});

/** Ячейки строки листа — колонки A–F, как их прочтёт Google. */
export async function cellsOf(
  client: SheetsClient,
  rowNumber: number,
): Promise<(Cell | undefined)[]> {
  const sheet = (await client.getSpreadsheet(ID)).sheets[0]!;
  const cells = sheet.rows[rowNumber - 1] ?? [];
  return Array.from({ length: 6 }, (_, column) => cells[column]);
}

/** Значения строки листа — колонки A–F. */
export const valuesOf = async (client: SheetsClient, rowNumber: number): Promise<unknown[]> =>
  (await cellsOf(client, rowNumber)).map((cell) => cell?.value ?? null);

/**
 * Ячейка, как её отдаёт Google: видимый текст и явный вид. `userEnteredFormat` ответа — та же
 * схема `CellFormat`, что принимает `repeatCell`, поэтому форму вида фикстура берёт у переводчика
 * шва; запрос записи оракулы судят литералом, а не им же.
 */
function googleCell(cell: Cell): sheets_v4.Schema$CellData {
  const shown = cell.value === null ? null : String(cell.value);
  const format = cell.format;
  return {
    ...(shown === null ? {} : { effectiveValue: { stringValue: shown }, formattedValue: shown }),
    ...(format === undefined
      ? {}
      : toRequest({ kind: 'format', sheetId: 5, row: 1, column: 0, format }).repeatCell?.cell),
  };
}

/**
 * Google, отвечающий формой документации; правки вида — в `requests`, как их получил бы он, и
 * сколько их пришло каждым вызовом `batchUpdate` — в `batches`.
 */
export function google(sheet: SheetSnapshot = dailySheet()) {
  const requests: sheets_v4.Schema$Request[] = [];
  const batches: number[] = [];
  const properties = {
    sheetId: 5,
    title: TITLE,
    gridProperties: { rowCount: 1000, columnCount: 26 },
  };
  const rowData = sheet.rows.map((cells) => ({ values: cells.map(googleCell) }));
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean }) =>
        Promise.resolve({
          data: {
            properties: { title: 'Дневник задач' },
            sheets: [
              params.includeGridData === true
                ? { properties, data: [{ startRow: 0, rowData }] }
                : { properties },
            ],
          },
        }),
      batchUpdate: (params: { requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
        requests.push(...params.requestBody.requests);
        batches.push(params.requestBody.requests.length);
        return Promise.resolve({ data: {} });
      },
    },
  } as unknown as sheets_v4.Sheets;
  const drive = {
    files: { get: () => Promise.resolve({ data: { version: '1' } }) },
  } as unknown as drive_v3.Drive;
  return {
    client: new GoogleSheetsClient({ accessToken: 'нет', api: { sheets, drive } }),
    requests,
    batches,
  };
}
