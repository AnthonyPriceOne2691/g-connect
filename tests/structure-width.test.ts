/**
 * Ширина строки у структурных правок (D-26, Q33–Q35): строку Google сортирует, удаляет и
 * перемещает целиком — с колонками без подписи и разрывом шапки, — и откат обязан вернуть её так
 * же, каждую ячейку в её колонку.
 *
 * Нашёл агент прошлого хотфикса (колонки без подписи, `bounds.ts`): сортировка брала от A столько
 * колонок, сколько подписей, а снимок — только колонки карты подряд от A. При шапке A, B, —, D
 * колонка D оставалась на месте, пока её строка уезжала, а откат писал значения D в C; на листе
 * вида «Лист5» откат удаления строки терял C3 «а) доступы». Фейк сортировал строки целиком и
 * соглашался сам с собой (урок L23) — теперь он двигает только ячейки диапазона, как Google.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import type { WriteRecord } from '../src/core/journal.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { moveRows, sortRange } from '../src/core/sheets/order-op.js';
import { deleteRows } from '../src/core/sheets/structure-op.js';
import {
  columnLetter,
  type Cell,
  type CellFormat,
  type SheetData,
  type SheetsClient,
  type SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import type { ApplyOutcome, RowOptions } from '../src/core/sheets/write-types.js';
import { undoLast } from '../src/core/undo.js';
import {
  FakeSheetsClient,
  MutableSheetsClient,
  reportSheet,
  row,
  snapshot,
} from './fixtures/sheet.js';

type Rows = readonly (readonly Cell[])[];
type Run = (client: SheetsClient, data: SheetData, options: RowOptions) => Promise<ApplyOutcome>;

/** Лист находки: ключ — в колонке A, `last` — последняя колонка строк данных. */
interface Sheet {
  readonly id: string;
  readonly key: string;
  readonly last: string;
  readonly rows: () => Cell[][];
}

const book = (rows: Rows): SpreadsheetSnapshot => ({
  id: 'SHEET',
  title: 'Книга',
  revisionId: '1',
  sheets: [{ title: 'Лист', sheetId: 5, rows }],
});

/**
 * Первая строка данных — с отмеченной ячейкой в последней колонке, у неё свой вид; сортировка по
 * ключу меняет местами первые две строки данных.
 */
const SHEETS: readonly Sheet[] = [
  {
    id: 'разрыв в шапке (A, B, —, D)',
    key: 'Проект',
    last: 'D',
    rows: () => [
      row('Проект', 'Часы', null, 'Статус'),
      row('b', 2, null, { value: 'x', format: { background: '#ffcc00' } }),
      row('a', 1, null, 'y'),
      row('c', 3, null, 'z'),
    ],
  },
  {
    id: 'колонка без подписи правее подписей (C на «Лист5»)',
    key: 'Пункт',
    last: 'C',
    rows: () => [
      row('Пункт', 'Описание'),
      row('п. 2', 'о 2', { value: 'а) доступы', format: { bold: true } }),
      row('п. 1', 'о 1'),
      row('п. 3', 'о 3'),
    ],
  },
];

/** Значения строк без хвоста пустых: Google хвост не отдаёт, а фейк дописывает пустые ячейки. */
const values = (rows: Rows) =>
  rows.map((cells) => {
    const out = cells.map((cell) => cell.value);
    while (out.length > 0 && out.at(-1) === null) out.pop();
    return out;
  });

/** Вид ячеек адресами: `D2` → вид; ячейки без вида не попадают. */
const formats = (rows: Rows): Record<string, CellFormat> =>
  Object.fromEntries(
    rows.flatMap((cells, r) =>
      cells.flatMap((cell, c) =>
        cell.format === undefined ? [] : [[`${columnLetter(c)}${r + 1}`, cell.format]],
      ),
    ),
  );

/** Превью → запись по коду плана (D-16; разрушающая правка принимает и его, D-20) → журнал. */
async function written(client: SheetsClient, run: Run, headerRow = 1): Promise<WriteRecord[]> {
  const journalled: WriteRecord[] = [];
  const data = buildSheetData(await client.getSpreadsheet('SHEET'), { headerRow });
  const preview = await run(client, data, {});
  const outcome = await run(client, data, {
    dryRun: false,
    confirm: preview.planId!,
    planId: preview.planId!,
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
  });
  expect(outcome.status).toBe('ok');
  return journalled;
}

const undo = (client: SheetsClient, journalled: WriteRecord[]) =>
  undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });

const sheetRows = async (client: SheetsClient): Promise<Rows> =>
  (await client.getSpreadsheet('SHEET')).sheets[0]!.rows;

describe('Q33: сортировка двигает строку целиком', () => {
  it('Q33: фейк Google сортирует только колонки диапазона — ячейки правее его края на месте', async () => {
    const client = new MutableSheetsClient(
      book([row('К', 'Ч', 'С'), row('b', 2, 'x'), row('a', 1, 'y')]),
    );
    const range = { row: 2, column: 0, rowCount: 2, columnCount: 2 };
    await client.batchUpdate('SHEET', [{ kind: 'sortRange', sheetId: 5, range, column: 0 }]);
    expect(values(await sheetRows(client))).toEqual([
      ['К', 'Ч', 'С'],
      ['a', 1, 'x'],
      ['b', 2, 'y'],
    ]);
  });

  it.each(SHEETS.map((sheet): [string, Sheet] => [sheet.id, sheet]))(
    'Q33: %s — строка едет целиком, снимок до последней колонки, откат — ячейки по своим колонкам',
    async (_id, sheet) => {
      const rows = sheet.rows();
      const client = new MutableSheetsClient(book(rows));
      const journalled = await written(client, (c, d, o) => sortRange(c, d, sheet.key, o));
      const [header, first, second, third] = rows;
      expect(values(await sheetRows(client))).toEqual(values([header!, second!, first!, third!]));
      expect(journalled[0]?.snapshots?.[0]?.a1Range).toBe(`Лист!A2:${sheet.last}4`);

      await undo(client, journalled);
      const after = await sheetRows(client);
      expect(values(after)).toEqual(values(rows));
      // Вид — на своём месте. Лишний вид, приехавший сортировкой туда, где его не было, откат
      // не снимает: снимок возвращает только заданный вид — прежняя непокрытость, не Q33.
      expect(formats(after)).toMatchObject(formats(rows));
    },
  );
});

describe('Q34: откат удаления и перемещения строк возвращает всю строку', () => {
  /** Строка листа `n` (1 — шапка) — условием по ключу. */
  const at = (sheet: Sheet, rows: Rows, n: number) => ({
    [sheet.key]: String(rows[n - 1]![0]!.value),
  });
  const OPS = {
    deleteRows: (sheet: Sheet, rows: Rows): Run => {
      return (c, d, o) => deleteRows(c, d, at(sheet, rows, 2), o);
    },
    moveRows: (sheet: Sheet, rows: Rows): Run => {
      return (c, d, o) => moveRows(c, d, at(sheet, rows, 2), at(sheet, rows, 4), o);
    },
  };
  const cases = SHEETS.flatMap((sheet) =>
    (['deleteRows', 'moveRows'] as const).map((op): [keyof typeof OPS, string, Sheet] => [
      op,
      sheet.id,
      sheet,
    ]),
  );

  it.each(cases)(
    'Q34: %s, %s — снимок строки до последней колонки, откат возвращает значения и вид',
    async (op, _id, sheet) => {
      const rows = sheet.rows();
      const client = new MutableSheetsClient(book(rows));
      const journalled = await written(client, OPS[op](sheet, rows));
      expect(journalled[0]?.snapshots?.[0]?.a1Range).toBe(`Лист!A2:${sheet.last}2`);

      const undone = await undo(client, journalled);
      expect(undone.status).toBe('ok');
      const after = await sheetRows(client);
      expect(values(after)).toEqual(values(rows));
      expect(formats(after)).toEqual(formats(rows));
    },
  );
});

describe('Q35: без разрывов и колонок без подписи — запросы и снимки прежние', () => {
  const lash = { Проект: 'lash-try-on' };
  const runs: Record<'sortRange' | 'deleteRows' | 'moveRows', Run> = {
    sortRange: (c, d, o) => sortRange(c, d, 'Проект', o),
    deleteRows: (c, d, o) => deleteRows(c, d, lash, o),
    moveRows: (c, d, o) => moveRows(c, d, lash, { Проект: 'G connect' }, o),
  };

  it.each([
    ['sortRange', 'Лист1!A3:D4', 3],
    ['deleteRows', 'Лист1!A4:D4', 4],
    ['moveRows', 'Лист1!A4:D4', 4],
  ] as const)('Q35: %s — снимок %s по четырём колонкам карты', async (op, range, from) => {
    const journalled = await written(new FakeSheetsClient(snapshot([reportSheet()])), runs[op], 2);
    // Ровно тот снимок, что брал прежний код: строки `reportSheet` значениями, без вида.
    const rows = reportSheet()
      .rows.slice(from - 1, 4)
      .map((cells) => cells.map(({ value }) => ({ value })));
    expect(journalled[0]?.snapshots).toEqual([{ a1Range: range, rows }]);
  });

  it('Q35: запрос сортировки прежний — от A на четыре колонки карты', async () => {
    const client = new FakeSheetsClient(snapshot([reportSheet()]));
    await written(client, runs.sortRange, 2);
    const range = { row: 3, column: 0, rowCount: 2, columnCount: 4 };
    expect(client.formatWrites).toEqual([{ kind: 'sortRange', sheetId: 0, range, column: 1 }]);
  });
});

/** Ячейка в ответе Google: значение и то, что видит человек; пустая — пустой объект. */
const cellData = ({ value }: Cell): sheets_v4.Schema$CellData =>
  value === null
    ? {}
    : {
        effectiveValue:
          typeof value === 'number' ? { numberValue: value } : { stringValue: String(value) },
        formattedValue: String(value),
      };

/** Google, отвечающий как настоящий (урок L28): сетка листа и журнал запросов `batchUpdate`. */
function google(rows: Rows) {
  const requests: sheets_v4.Schema$Request[] = [];
  const properties = { sheetId: 5, title: 'Лист', gridProperties: { rowCount: 1000 } };
  const grid = [{ startRow: 0, rowData: rows.map((cells) => ({ values: cells.map(cellData) })) }];
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean }) =>
        Promise.resolve({
          data: {
            properties: { title: 'Книга' },
            sheets: [{ properties, ...(params.includeGridData === true ? { data: grid } : {}) }],
          },
        }),
      batchUpdate: (params: { requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
        requests.push(...params.requestBody.requests);
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
  };
}

describe('Q33, Q35: шов — запрос сортировки Google по ширине строк данных', () => {
  const plain: Sheet = {
    id: 'подписи подряд, без колонок без подписи',
    key: 'Проект',
    last: 'C',
    rows: () => [row('Проект', 'Часы', 'Статус'), row('b', 2, 'x'), row('a', 1, 'y')],
  };

  it.each([
    ['Q33', SHEETS[0]!.id, 4, SHEETS[0]!],
    ['Q33', SHEETS[1]!.id, 3, SHEETS[1]!],
    ['Q35', plain.id, 3, plain],
  ] as const)('%s: %s — sortRange.range от колонки A до %s-й', async (_q, _id, end, sheet) => {
    const rows = sheet.rows();
    const g = google(rows);
    await written(g.client, (c, d, o) => sortRange(c, d, sheet.key, o));
    expect(g.requests).toEqual([
      {
        sortRange: {
          range: {
            sheetId: 5,
            startRowIndex: 1,
            endRowIndex: rows.length,
            startColumnIndex: 0,
            endColumnIndex: end,
          },
          sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }],
        },
      },
    ]);
  });
});
