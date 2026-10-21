/**
 * Выбор строк правки вида и вид дописанной строки (D-26, примеры Q13 и Q14).
 *
 * Владелец выравнивал шрифт и даты «Реестра инфраструктуры» на семи вкладках: строки, которые
 * G connect дописал ниже оформленных строк шаблона, получили шрифт листа по умолчанию
 * (`appendRow` писал только значения), а `formatCells` выбирал строки одним условием `where` —
 * выровнять лист целиком было нечем.
 *
 * Q13 судится через настоящий протокол MCP: граница ядра, схема `gc_apply` в `tools/list`,
 * конверт. Q14 — на фейке, вставляющем «только вид» как Google, и через внедрённый API Google
 * (урок L28): запрос копии виден в форме библиотеки — `copyPaste`, `PASTE_FORMAT`, индексы
 * сетки 0-based, — а порядок «вид, потом значения» — по журналу вызовов.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import type { WriteRecord } from '../src/core/journal.js';
import { formatCells } from '../src/core/sheets/format-op.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { appendRow } from '../src/core/sheets/rows.js';
import type {
  Cell,
  CellFormat,
  SheetSnapshot,
  SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import type { Registry } from '../src/core/targets.js';
import { undoLast } from '../src/core/undo.js';
import { gcApply, type ToolDeps } from '../src/mcp/tools.js';
import { FakeSheetsClient, MutableSheetsClient, appendConfirmed, row } from './fixtures/sheet.js';
import { callMcp, protocolSession } from './fixtures/protocol.js';

const ID = '1FORMATrowsDDDDDDDDDDDDDDDDDDDDDDDDD';
const TITLE = 'Реестр';

const book = (sheet: SheetSnapshot): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Реестр инфраструктуры ИИ-отдела',
  revisionId: 'rev-1',
  sheets: [sheet],
});

/** Цель реестра с конвертом правки вида и дозаписи; maxCells — по умолчанию, 50. */
const REGISTRY: Registry = {
  targets: [
    {
      alias: 'reg',
      id: ID,
      type: 'sheet',
      allow: 'write',
      sheet: TITLE,
      headerRow: 2,
      key: ['Сервис'],
      auto: { ops: ['formatCells', 'appendRow', 'upsertRow'] },
    },
  ],
};

/**
 * «Реестр»: баннер в строке 1, шапка во второй, `count` строк данных с третьей; `gaps` — номера
 * строк листа, оставленных пустыми внутри данных. Ниже данных — пустой хвост сетки: данными он
 * не считается.
 */
function registrySheet(count: number, gaps: readonly number[] = []): SheetSnapshot {
  const rows: Cell[][] = [
    row('Реестр инфраструктуры', null, null),
    row('Сервис', 'Статус', 'Владелец'),
  ];
  for (let n = 3; n < 3 + count; n += 1) {
    rows.push(gaps.includes(n) ? row(null, null, null) : row(`сервис ${n}`, 'в работе', 'Антон'));
  }
  rows.push(row(null, null, null), row(null, null, null));
  return { title: TITLE, sheetId: 3, rows };
}

function harness(sheet: SheetSnapshot) {
  const client = new FakeSheetsClient(book(sheet));
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () => Promise.resolve(REGISTRY),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('rev-1'),
  };
  return { client, deps, journalled };
}

/** Google недоступен: отказ обязан случиться на границе ядра, ДО чтения листа (урок L11). */
const withoutGoogle = (): ToolDeps => ({
  ...harness(registrySheet(5)).deps,
  sheets: () => Promise.reject(new TypeError('Google тронут: отказ опоздал до чтения листа')),
});

/** Правка вида «Статус» жирным; способ выбора строк и прочее — у каждого теста свои. */
const formatCall = (selection: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  op: 'formatCells',
  target: 'reg',
  columns: ['Статус'],
  format: { bold: true },
  ...selection,
  ...extra,
});

const addresses = (data: unknown): string[] =>
  (data as { changes: { a1: string }[] }).changes.map((change) => change.a1);

describe('Q13 — строки правки вида: ровно один способ (D-26)', () => {
  it('Q13: allRows — все строки данных: от строки после шапки до последней с данными, пустые внутри — тоже', async () => {
    const { deps, client } = harness(registrySheet(6, [5]));
    const result = await callMcp(gcApply, formatCall({ allRows: true }), deps);
    expect(result.data).toMatchObject({ status: 'preview' });
    // Строки 3–8: пятая пуста, но лежит внутри данных; шапка и хвост сетки (9, 10) — нет.
    expect(addresses(result.data)).toEqual([
      'Реестр!B3',
      'Реестр!B4',
      'Реестр!B5',
      'Реестр!B6',
      'Реестр!B7',
      'Реестр!B8',
    ]);
    expect(client.formatWrites).toHaveLength(0);
  });

  it('Q13: rows {from, to} — номера строк листа, включительно', async () => {
    const { deps } = harness(registrySheet(10));
    const result = await callMcp(gcApply, formatCall({ rows: { from: 4, to: 6 } }), deps);
    expect(result.data).toMatchObject({ status: 'preview' });
    expect(addresses(result.data)).toEqual(['Реестр!B4', 'Реестр!B5', 'Реестр!B6']);
  });

  it('Q13: rows вне строк данных — отказ называет границы данных («данные — строки 3–64»)', async () => {
    const { deps, client } = harness(registrySheet(62));
    const above = await callMcp(gcApply, formatCall({ rows: { from: 2, to: 70 } }), deps);
    expect(above.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
    expect(above.error?.detail).toContain('данные — строки 3–64');
    // Строка шапки — не данные: её оформляет includeHeader, и отказ говорит об этом.
    expect(above.error?.detail).toContain('includeHeader');
    const below = await callMcp(gcApply, formatCall({ rows: { from: 60, to: 65 } }), deps);
    expect(below.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
    expect(below.error?.detail).toContain('данные — строки 3–64');
    expect(client.formatWrites).toHaveLength(0);
  });

  it('Q13: from больше to — bad_request до обращения к Google', async () => {
    const result = await callMcp(
      gcApply,
      formatCall({ rows: { from: 10, to: 5 } }),
      withoutGoogle(),
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'rows_reversed' });
    expect(result.error?.detail).toContain('{from: 5, to: 10}');
  });

  it('Q13: ни одного способа — bad_request с тремя способами, а не молчаливое «все строки»', async () => {
    for (const selection of [{}, { allRows: false }]) {
      const result = await callMcp(gcApply, formatCall(selection), withoutGoogle());
      expect(result.error, JSON.stringify(selection)).toMatchObject({
        code: 'bad_request',
        cause: 'row_selection',
      });
      for (const way of ['where', 'allRows: true', 'rows: {from, to}']) {
        expect(result.error?.detail).toContain(way);
      }
    }
  });

  it('Q13: два способа сразу — bad_request, оба названы', async () => {
    const result = await callMcp(
      gcApply,
      formatCall({ where: { Сервис: 'сервис 3' }, allRows: true }),
      withoutGoogle(),
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
    expect(result.error?.detail).toContain('(where, allRows)');
  });

  it('Q13: пустое where: {} — отказ и на границе, и в ядре: все строки — только явным allRows', async () => {
    const boundary = await callMcp(gcApply, formatCall({ where: {} }), withoutGoogle());
    expect(boundary.error).toMatchObject({ code: 'bad_request', cause: 'empty_condition' });
    expect(boundary.error?.detail).toContain('allRows: true');
    // Прямой вызов ядра — тот же отказ: раньше пустой `every` молча выбирал все строки.
    const sheet = book(registrySheet(5));
    const data = buildSheetData(sheet, { sheet: TITLE, headerRow: 2 });
    await expect(
      formatCells(new FakeSheetsClient(sheet), data, {}, ['Статус'], { bold: true }),
    ).rejects.toMatchObject({ payload: { code: 'bad_request', cause: 'empty_condition' } });
  });

  it('Q13: конверт не обходится — allRows на 30 строках × 2 колонки = 60 ячеек > 50: confirm_required', async () => {
    const { deps, client, journalled } = harness(registrySheet(30));
    const result = await callMcp(
      gcApply,
      formatCall({ allRows: true }, { columns: ['Статус', 'Владелец'], dryRun: false }),
      deps,
    );
    const data = result.data as { status: string; changes: unknown[]; planId: string | null };
    expect(data.status).toBe('confirm_required');
    expect(data.changes).toHaveLength(60);
    expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(JSON.stringify(result.data)).toContain(
      'Правка трогает 60 ячеек, конверт цели разрешает 50',
    );
    expect(client.formatWrites).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });

  it('Q13: пачка rows под конверт — 25 строк × 2 колонки = 50 ячеек пишутся с первой фразы', async () => {
    const { deps, client, journalled } = harness(registrySheet(30));
    const result = await callMcp(
      gcApply,
      formatCall({ rows: { from: 3, to: 27 } }, { columns: ['Статус', 'Владелец'], dryRun: false }),
      deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(client.formatWrites).toHaveLength(50);
    expect(client.writes).toHaveLength(0);
    expect(journalled.map((record) => record.changes.length)).toEqual([50]);
  });

  it('Q13: includeHeader работает с любым способом выбора', async () => {
    const { deps } = harness(registrySheet(4));
    const all = await callMcp(
      gcApply,
      formatCall({ allRows: true }, { includeHeader: true }),
      deps,
    );
    expect(addresses(all.data)).toEqual([
      'Реестр!B2',
      'Реестр!B3',
      'Реестр!B4',
      'Реестр!B5',
      'Реестр!B6',
    ]);
    const span = await callMcp(
      gcApply,
      formatCall({ rows: { from: 4, to: 5 } }, { includeHeader: true }),
      deps,
    );
    expect(addresses(span.data)).toEqual(['Реестр!B2', 'Реестр!B4', 'Реестр!B5']);
    const where = await callMcp(
      gcApply,
      formatCall({ where: { Сервис: 'сервис 3' } }, { includeHeader: true }),
      deps,
    );
    expect(addresses(where.data)).toEqual(['Реестр!B2', 'Реестр!B3']);
  });

  it('Q13: на листе без строк данных — вопрос, а не «вид уже такой»', async () => {
    const { deps } = harness(registrySheet(0));
    for (const selection of [{ allRows: true }, { rows: { from: 3, to: 4 } }]) {
      const result = await callMcp(gcApply, formatCall(selection), deps);
      expect(result.data, JSON.stringify(selection)).toMatchObject({
        status: 'needs_clarification',
      });
      expect(JSON.stringify(result.data)).toContain('нет строк данных');
    }
  });

  it('Q13: tools/list — gc_apply объявляет allRows и rows {from, to} с описанием formatCells', async () => {
    const session = await protocolSession(harness(registrySheet(1)).deps);
    try {
      const { tools } = await session.client.listTools();
      type Field = {
        type?: string;
        description?: string;
        anyOf?: { type?: string; properties?: Record<string, unknown> }[];
      };
      const schema = tools.find((tool) => tool.name === 'gc_apply')?.inputSchema as {
        properties: Record<string, Field | undefined>;
      };
      expect(schema.properties['allRows']).toMatchObject({ type: 'boolean' });
      expect(schema.properties['allRows']?.description).toContain('formatCells');
      const rows = schema.properties['rows'];
      const span = rows?.anyOf?.find((form) => form.type === 'object');
      expect(Object.keys(span?.properties ?? {})).toEqual(['from', 'to']);
      expect(rows?.description).toContain('formatCells: {from, to}');
    } finally {
      await session.close();
    }
  });
});

/** Шапка и `count` строк данных реестра — как отдаёт их Google: строки без пустого хвоста. */
function registryRows(count: number): string[][] {
  const rows = [['Сервис', 'Статус', 'Владелец']];
  for (let n = 1; n <= count; n += 1) rows.push([`сервис ${n}`, 'в работе', 'Антон']);
  return rows;
}

/**
 * Google, отвечающий как настоящий (форма ответа — как в long-sheets.test.ts). Пишущие вызовы —
 * в `calls` по порядку: `batchUpdate` — вид, `values.batchUpdate` — значения.
 */
function google(rows: string[][], failCopy = false) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const written: string[] = [];
  const properties = {
    sheetId: 7,
    title: TITLE,
    gridProperties: { rowCount: 1000, columnCount: 26 },
  };
  const rowData = rows.map((values) => ({
    values: values.map((v) => ({ effectiveValue: { stringValue: v }, formattedValue: v })),
  }));
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean }) =>
        Promise.resolve({
          data: {
            properties: { title: 'Реестр инфраструктуры' },
            sheets: [
              params.includeGridData === true
                ? { properties, data: [{ startRow: 0, rowData }] }
                : { properties },
            ],
          },
        }),
      values: {
        batchUpdate: (params: { requestBody: { data: { range: string }[] } }) => {
          calls.push('values.batchUpdate');
          written.push(...params.requestBody.data.map((d) => d.range));
          return Promise.resolve({ data: {} });
        },
      },
      batchUpdate: (params: { requestBody: { requests: unknown[] } }) => {
        calls.push('batchUpdate');
        requests.push(...params.requestBody.requests);
        // Отказ не повторяемым кодом: копия не прошла, повторять её ядро не будет.
        return failCopy
          ? Promise.reject(
              Object.assign(new Error('The caller does not have permission'), { code: 403 }),
            )
          : Promise.resolve({ data: {} });
      },
    },
  } as unknown as sheets_v4.Sheets;
  const drive = {
    files: { get: () => Promise.resolve({ data: { version: '1' } }) },
  } as unknown as drive_v3.Drive;
  return { api: { sheets, drive }, calls, requests, written };
}

/** Настоящий `GoogleSheetsClient` на заглушке Google; реестр — шапка в первой строке. */
function seam(api: { sheets: sheets_v4.Sheets; drive: drive_v3.Drive }) {
  const journalled: WriteRecord[] = [];
  const client = new GoogleSheetsClient({ accessToken: 'нет', api });
  const entry = REGISTRY.targets[0]!;
  const deps: ToolDeps = {
    ...harness(registrySheet(1)).deps,
    sheets: () => Promise.resolve(client),
    registry: () => Promise.resolve({ targets: [{ ...entry, headerRow: 1 }] }),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => Promise.resolve('1'),
  };
  return { deps, journalled };
}

const NEW_ROW = { Сервис: 'новый сервис', Статус: 'в работе', Владелец: 'Антон' };

/** Одна строка сетки Google: 0-based полуинтервал, колонки — ширина таблицы A…C. */
const gridRow = (index: number) => ({
  sheetId: 7,
  startRowIndex: index,
  endRowIndex: index + 1,
  startColumnIndex: 0,
  endColumnIndex: 3,
});

/** Шапка — строка 1, данные — 2–21, новая — 22: копия из 21-й (индекс 20) в 22-ю (21). */
const COPY_ABOVE = {
  copyPaste: { source: gridRow(20), destination: gridRow(21), pasteType: 'PASTE_FORMAT' },
};
/** Список строки над новой — вторым запросом: `PASTE_FORMAT` проверку данных не переносит (Q44). */
const LIST_ABOVE = {
  copyPaste: { source: gridRow(20), destination: gridRow(21), pasteType: 'PASTE_DATA_VALIDATION' },
};

describe('Q14 — дописанная строка берёт оформление строки над ней: шов Google (D-26)', () => {
  it('Q14, Q44: appendRow — ДО значений copyPaste PASTE_FORMAT и PASTE_DATA_VALIDATION из строки над новой, по ширине таблицы', async () => {
    const g = google(registryRows(20));
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'reg', values: NEW_ROW, dryRun: false },
      seam(g.api).deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.calls).toEqual(['batchUpdate', 'values.batchUpdate']);
    expect(g.requests).toEqual([COPY_ABOVE, LIST_ABOVE]);
    // Значения — по-прежнему одним запросом и в новую строку (Q10).
    expect(g.written).toHaveLength(3);
    for (const range of g.written) expect(range).toMatch(/22$/);
  });

  it('Q14: upsertRow без найденного ключа уходит в дозапись — с той же копией вида', async () => {
    const g = google(registryRows(20));
    const result = await callMcp(
      gcApply,
      {
        op: 'upsertRow',
        target: 'reg',
        key: { Сервис: 'новый сервис' },
        values: { Статус: 'в работе' },
        dryRun: false,
      },
      seam(g.api).deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.calls).toEqual(['batchUpdate', 'values.batchUpdate']);
    expect(g.requests).toEqual([COPY_ABOVE, LIST_ABOVE]);
  });

  it('Q14: лист из одной шапки — копии нет: шапка оформлена иначе', async () => {
    const g = google(registryRows(0));
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'reg', values: NEW_ROW, dryRun: false },
      seam(g.api).deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.calls).toEqual(['values.batchUpdate']);
    expect(JSON.stringify(result.data)).not.toContain('оформление строки');
  });

  it('Q14: превью называет копию в заметках — «оформление строки 22 — как у строки 21»; записи нет', async () => {
    const g = google(registryRows(20));
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'reg', values: NEW_ROW },
      seam(g.api).deps,
    );
    expect(result.data).toMatchObject({ status: 'preview' });
    expect((result.data as { notes: string[] }).notes).toContain(
      'оформление строки 22 — как у строки 21, с проверкой данных',
    );
    expect(g.calls).toEqual([]);
  });

  it('Q14: копия вида отказала — значения не пишутся, в листе нет строки с данными без вида', async () => {
    const g = google(registryRows(20), true);
    const { deps, journalled } = seam(g.api);
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'reg', values: NEW_ROW, dryRun: false },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(g.calls).toEqual(['batchUpdate']);
    expect(g.written).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });
});

/** Шрифт шаблона реестра — его и теряли дописанные строки. */
const TEMPLATE: CellFormat = { fontFamily: 'Carlito', fontSize: 10 };
const CENTERED: CellFormat = { ...TEMPLATE, align: 'center' };

/** Лист шаблона: шапка жирная, строки данных — шрифтом шаблона, «Статус» — по центру. */
function templateSheet(): SheetSnapshot {
  const header = (value: string): Cell => ({ value, format: { bold: true } });
  const data = (service: string, status: string): Cell[] => [
    { value: service, format: TEMPLATE },
    { value: status, format: CENTERED },
    { value: 'Антон', format: TEMPLATE },
  ];
  return {
    title: TITLE,
    sheetId: 3,
    rows: [
      [header('Сервис'), header('Статус'), header('Владелец')],
      data('сервис 1', 'в работе'),
      data('сервис 2', 'пауза'),
    ],
  };
}

const templateData = () => buildSheetData(book(templateSheet()), { sheet: TITLE, headerRow: 1 });

describe('Q14 — дописанная строка берёт оформление строки над ней: лист (D-26)', () => {
  it('Q14: вид новой строки — как у строки над ней, а значения — свои, не строки выше', async () => {
    const client = new MutableSheetsClient(book(templateSheet()));
    const outcome = await appendConfirmed(client, templateData(), {
      Сервис: 'новый сервис',
      Статус: 'готово',
    });
    expect(outcome.status).toBe('ok');
    const added = (await client.getSpreadsheet()).sheets[0]?.rows[3];
    expect(added?.map((cell) => cell.format)).toEqual([TEMPLATE, CENTERED, TEMPLATE]);
    // «Владелец» пуст: вставка «только вид» не тащит в новую строку «Антон» из строки выше.
    expect(added?.map((cell) => cell.value)).toEqual(['новый сервис', 'готово', null]);
  });

  it('Q14: ширина копии — от первой до последней колонки карты, безымянная внутри — тоже', async () => {
    const sheet: SheetSnapshot = {
      title: TITLE,
      sheetId: 3,
      rows: [
        row(null, 'Сервис', 'Статус', null, 'Владелец'),
        row(null, 'сервис 1', 'в работе', null, 'Антон'),
      ],
    };
    const client = new FakeSheetsClient(book(sheet));
    const data = buildSheetData(book(sheet), { sheet: TITLE, headerRow: 1 });
    const outcome = await appendConfirmed(client, data, { Сервис: 'новый' });
    expect(outcome.status).toBe('ok');
    const line = (at: number) => ({ row: at, column: 1, rowCount: 1, columnCount: 4 });
    expect(client.formatWrites).toEqual([
      { kind: 'copyPaste', sheetId: 3, source: line(2), destination: line(3), paste: 'format' },
      { kind: 'copyPaste', sheetId: 3, source: line(2), destination: line(3), paste: 'validation' },
    ]);
  });

  it('Q14: превью строилось на пустой строке, а её заняли — ни копии вида, ни значений', async () => {
    const before = book(templateSheet());
    const taken = book({
      ...templateSheet(),
      rows: [...templateSheet().rows, row('чужой сервис', 'в работе', 'Ира')],
    });
    const client = new FakeSheetsClient(taken);
    const data = buildSheetData(before, { sheet: TITLE, headerRow: 1 });
    const values = { Сервис: 'новый сервис' };
    const preview = await appendRow(client, data, values);
    await expect(
      appendRow(client, data, values, { dryRun: false, confirm: preview.planId ?? '' }),
    ).rejects.toMatchObject({ payload: { code: 'stale_value' } });
    expect(client.formatWrites).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('Q14: откат дозаписи возвращает значения, а скопированный вид остаётся на пустой строке — названная непокрытость', async () => {
    const client = new MutableSheetsClient(book(templateSheet()));
    const journalled: WriteRecord[] = [];
    await appendConfirmed(
      client,
      templateData(),
      { Сервис: 'новый сервис', Статус: 'готово' },
      {
        journal: async (record) => {
          journalled.push(record);
        },
      },
    );
    const undone = await undoLast(client, ID, { recent: () => Promise.resolve([...journalled]) });
    expect(undone.status).toBe('ok');
    const sheet = (await client.getSpreadsheet()).sheets[0];
    expect(sheet?.rows[3]?.map((cell) => cell.value)).toEqual([null, null, null]);
    // Вид остался: журнал хранит ячейки правки, а не прежний вид строки (rows.ts, layoutFromAbove).
    expect(sheet?.rows[3]?.map((cell) => cell.format)).toEqual([TEMPLATE, CENTERED, TEMPLATE]);
    // Строка без значений — не данные: следующая дозапись встанет в неё же.
    const again = await appendRow(
      client,
      buildSheetData(await client.getSpreadsheet(), { sheet: TITLE, headerRow: 1 }),
      { Сервис: 'ещё один' },
    );
    expect(again.changes.map((change) => change.a1)).toEqual(['Реестр!A4']);
  });
});
