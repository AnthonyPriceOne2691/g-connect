/**
 * Лист из gid ссылки (D-26, Q27–Q29): ссылка на вкладку читается и пишется В НЕЁ, а не в первый
 * лист книги.
 *
 * Живой прогон 2026-10-20 (профиль work): `gc_read mode=map` по «…/edit?gid=112806398#gid=…» без
 * `sheet` вернул первый лист «Вводная», хотя gid — «Лог проверок»; запись шла тем же путём. Шов
 * судится на форме ответа Google (урок L28): через заглушку API идут настоящий
 * `GoogleSheetsClient` и настоящие инструменты по протоколу.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import { parseTargetUrl, resolveTarget, type Registry } from '../src/core/targets.js';
import { gcApply, gcRead, type ToolDeps } from '../src/mcp/tools.js';
import { callMcp } from './fixtures/protocol.js';

const BOOK = '1GIDbookAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FIFTH = '1GIDfifthBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OTHER = '1GIDotherCCCCCCCCCCCCCCCCCCCCCCCCCC';
const FIRST = '1GIDfirstDDDDDDDDDDDDDDDDDDDDDDDDDD';
const LOG = 112806398;
const LIST5 = 615812025;

const url = (id: string, tail = '') => `https://docs.google.com/spreadsheets/d/${id}/edit${tail}`;
/** Ссылка на вкладку, как её копирует Google: gid и в запросе, и во фрагменте. */
const tab = (id: string, gid: number) => url(id, `?gid=${gid}#gid=${gid}`);

/**
 * Книга живого прогона. «Вводная» — первый лист той же формы, что «Лог проверок»: правка не туда
 * проходит молча. У «Лист5» эвристика берёт шапкой строку 1, реестр поправляет на 2.
 */
const SHEETS = [
  {
    title: 'Вводная',
    sheetId: 0,
    rows: [
      ['Проверка', 'Итог'],
      ['sitemap', 'пример'],
    ],
  },
  {
    title: 'Лог проверок',
    sheetId: LOG,
    rows: [
      ['Проверка', 'Итог'],
      ['robots.txt', 'ок'],
      ['sitemap', ''],
    ],
  },
  {
    title: 'Лист5',
    sheetId: LIST5,
    rows: [
      ['Неделя', 'Отдел'],
      ['Задача', 'Срок'],
      ['отчёт', 'пт'],
    ],
  },
];

const registry: Registry = {
  targets: [
    // Без листа по умолчанию: без gid правка шла бы в первый лист — ровно живой случай.
    {
      alias: 'checks',
      id: BOOK,
      type: 'sheet',
      allow: 'write',
      auto: { ops: ['appendRow', 'setCells'], maxCells: 4 },
    },
    { alias: 'fifth', id: FIFTH, type: 'sheet', allow: 'write', sheet: 'Лист5', headerRow: 2 },
    // Шапка без листа — шапка первого листа книги: так её читает и вызов без gid.
    { alias: 'first', id: FIRST, type: 'sheet', headerRow: 2 },
  ],
};

type Sheet = (typeof SHEETS)[number];

const properties = (sheet: Sheet) => ({
  sheetId: sheet.sheetId,
  title: sheet.title,
  gridProperties: { rowCount: 1000, columnCount: 26 },
});

/** Сетка листа со строки `from` по `to`, как её отдаёт Google. */
const grid = (sheet: Sheet, from = 1, to = Infinity) => ({
  properties: properties(sheet),
  data: [
    {
      startRow: from - 1,
      rowData: sheet.rows.slice(from - 1, to).map((row) => ({
        values: row.map((v) =>
          v === '' ? {} : { effectiveValue: { stringValue: v }, formattedValue: v },
        ),
      })),
    },
  ],
});

/** Диапазон чтения: «'Лист'» — весь лист, «'Лист'!A2:ZZ500» — со 2-й строки по 500-ю. */
function gridOf(range: string) {
  const match = /^'(.+)'(?:!A(\d+):[A-Z]+(\d+))?$/.exec(range);
  const sheet = SHEETS.find((s) => s.title === match?.[1]);
  if (sheet === undefined) throw new TypeError(`заглушка не знает диапазон ${range}`);
  return [grid(sheet, Number(match?.[2] ?? 1), Number(match?.[3] ?? Infinity))];
}

/** Google, отвечающий как настоящий; запросы — в журнал: метаданные, сетка, записи. */
function google() {
  const calls = { meta: [] as string[], grid: [] as string[], writes: [] as string[] };
  const write = (ranges: readonly string[]) => {
    calls.writes.push(...ranges);
    return Promise.resolve({ data: {} });
  };
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean; ranges?: string[]; fields?: string }) => {
        if (params.includeGridData !== true) {
          calls.meta.push(params.fields ?? '');
          return Promise.resolve({
            data: { sheets: SHEETS.map((s) => ({ properties: properties(s) })) },
          });
        }
        const range = params.ranges?.[0];
        calls.grid.push(range ?? '(вся книга)');
        const picked = range === undefined ? SHEETS.map((s) => grid(s)) : gridOf(range);
        return Promise.resolve({ data: { properties: { title: 'Проверки' }, sheets: picked } });
      },
      values: {
        update: (params: { range: string }) => write([params.range]),
        batchUpdate: (params: { requestBody: { data: { range: string }[] } }) =>
          write(params.requestBody.data.map((d) => d.range)),
      },
      batchUpdate: () => Promise.resolve({ data: {} }),
    },
  } as unknown as sheets_v4.Sheets;
  const drive = {
    files: { get: () => Promise.resolve({ data: { version: '1' } }) },
  } as unknown as drive_v3.Drive;
  return { api: { sheets, drive }, calls };
}

/** Вызов инструмента по протоколу на свежей заглушке: ответ и журнал запросов к Google. */
async function run(tool: typeof gcRead, args: Record<string, unknown>) {
  const { api, calls } = google();
  const client = new GoogleSheetsClient({ accessToken: 'нет', api });
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () => Promise.resolve(registry),
    journal: () => Promise.resolve(),
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => Promise.resolve('1'),
  };
  return { result: await callMcp(tool, args, deps), ...calls };
}

describe('разбор ссылки: лист из gid (Q27)', () => {
  it.each([
    ['и в запросе, и во фрагменте', `?gid=${LOG}#gid=${LOG}`, LOG],
    ['только во фрагменте', `#gid=${LIST5}`, LIST5],
    ['только в запросе', `?gid=${LOG}`, LOG],
    ['0 — тоже лист, а не «нет gid»', '#gid=0', 0],
    ['среди других параметров', `?usp=sharing#gid=${LOG}&range=A1:B2`, LOG],
    ['мусор рядом с числом не мешает', `?gid=abc#gid=${LOG}`, LOG],
  ])('Q27: gid ссылки — %s', (_name, tail, gid) => {
    expect(parseTargetUrl(url(BOOK, tail))).toStrictEqual({ id: BOOK, type: 'sheet', gid });
  });

  it.each([
    ['без gid', ''],
    ['пустой', '#gid='],
    ['не число', '#gid=abc'],
    ['число с хвостом', '?gid=12abc'],
    ['отрицательный', '#gid=-1'],
  ])('Q27: мусор — как нет gid: %s', (_name, tail) => {
    expect(parseTargetUrl(url(BOOK, tail))).toStrictEqual({ id: BOOK, type: 'sheet' });
  });

  it('Q27: два разных gid в одной ссылке — отказ до Google, а не выбор вкладки', async () => {
    const { result, meta, grid } = await run(gcRead, { target: url(BOOK, `?gid=1#gid=${LOG}`) });
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'sheet_gid_conflict' });
    expect(result.error?.detail).toContain(`gid 1 и ${LOG}`);
    expect(result.error?.detail).toContain('спроси человека');
    expect({ meta, grid }).toEqual({ meta: [], grid: [] });
  });

  it('Q27: цель по ссылке несёт gid и права реестра; алиас и голый ID gid не несут', () => {
    expect(resolveTarget(tab(BOOK, LOG), registry)).toMatchObject({ alias: 'checks', gid: LOG });
    expect(resolveTarget('checks', registry)).not.toHaveProperty('gid');
    expect(resolveTarget(BOOK, registry)).not.toHaveProperty('gid');
  });
});

describe('Q27 — лист из gid ссылки: чтение и запись', () => {
  it.each([
    [
      'живой случай: вкладка по ссылке, а не первый лист',
      { target: tab(BOOK, LOG) },
      'Лог проверок',
      1,
    ],
    [
      'gid сильнее листа реестра, шапка реестра к чужой вкладке не прилипает',
      { target: tab(FIFTH, LOG) },
      'Лог проверок',
      1,
    ],
    ['gid листа реестра — с шапкой реестра', { target: tab(FIFTH, LIST5) }, 'Лист5', 2],
    [
      'реестр без листа — его шапка у первого листа',
      { target: url(FIRST, '#gid=0') },
      'Вводная',
      2,
    ],
    ['gid книги вне реестра — второй живой случай', { target: tab(OTHER, LIST5) }, 'Лист5', 1],
    ['gid=0 — первый лист, хоть в реестре другой', { target: url(FIFTH, '#gid=0') }, 'Вводная', 1],
    [
      'явный sheet и gid об одном листе',
      { target: tab(BOOK, LOG), sheet: 'Лог проверок' },
      'Лог проверок',
      1,
    ],
  ])(
    'Q27: старшинство «sheet → gid → реестр → первый лист» — %s',
    async (_name, args, sheet, headerRow) => {
      const { result } = await run(gcRead, { mode: 'map', ...args });
      expect(result.data).toMatchObject({ sheet, headerRow });
    },
  );

  it('Q27: mode=values по ссылке на вкладку — её строки, а не первого листа', async () => {
    const { result } = await run(gcRead, { mode: 'values', target: tab(BOOK, LOG) });
    expect(result.data).toMatchObject({ sheet: 'Лог проверок' });
    expect((result.data as { rows: { value: unknown[] } }).rows.value).toEqual([
      { Проверка: 'robots.txt', Итог: 'ок' },
      { Проверка: 'sitemap', Итог: null },
    ]);
  });

  it.each([
    ['setCells', { where: { Проверка: 'sitemap' }, values: { Итог: 'ок' } }, ['Лог проверок!B3']],
    [
      'appendRow',
      { values: { Проверка: 'canonical', Итог: 'ок' } },
      ['Лог проверок!A4', 'Лог проверок!B4'],
    ],
  ])(
    'Q27: %s в конверте по ссылке на вкладку пишет в неё, а не в первый лист',
    async (op, fields, ranges) => {
      const { result, writes } = await run(gcApply, {
        op,
        target: tab(BOOK, LOG),
        dryRun: false,
        ...fields,
      });
      expect(result.data).toMatchObject({ status: 'ok', target: { sheet: 'Лог проверок' } });
      expect(writes).toEqual(ranges);
    },
  );
});

describe('Q28 — расхождение и ненайденный gid — отказ до чтения сетки и до записи', () => {
  const calls = [
    ['gc_read map', gcRead, { mode: 'map' }],
    ['gc_read values', gcRead, { mode: 'values' }],
    [
      'gc_apply setCells',
      gcApply,
      { op: 'setCells', where: { Проверка: 'sitemap' }, values: { Итог: 'ок' }, dryRun: false },
    ],
  ] as const;

  it.each(calls)(
    'Q28: %s — sheet и gid о разных листах: отказ с обоими названиями',
    async (_name, tool, args) => {
      const { result, meta, grid, writes } = await run(tool, {
        ...args,
        target: tab(BOOK, LOG),
        sheet: 'Вводная',
      });
      expect(result.error).toMatchObject({ code: 'bad_request', cause: 'sheet_gid_mismatch' });
      expect(result.error?.detail).toContain(
        'лист «Лог проверок» (gid 112806398), в sheet — «Вводная»',
      );
      // Отказ ведёт к человеку, а не к догадке: какой из листов нужен, решает он.
      expect(result.error?.detail).toContain('спроси человека');
      expect({ meta, grid, writes }).toEqual({
        meta: ['sheets.properties(sheetId,title)'],
        grid: [],
        writes: [],
      });
    },
  );

  it.each(calls)(
    'Q28: %s — gid, которого в книге нет: отказ со списком листов, а не первый лист',
    async (_name, tool, args) => {
      const { result, grid, writes } = await run(tool, { ...args, target: tab(BOOK, 999) });
      expect(result.error).toMatchObject({ code: 'bad_request', cause: 'sheet_gid_unknown' });
      expect(result.error?.detail).toContain(
        'Листы книги: «Вводная» (gid 0), «Лог проверок» (gid 112806398), «Лист5» (gid 615812025)',
      );
      expect(result.error?.detail).toContain('спроси человека');
      expect({ grid, writes }).toEqual({ grid: [], writes: [] });
    },
  );
});

describe('Q29 — без gid — как раньше', () => {
  it.each([
    ['алиас реестра — его лист и шапка', { target: 'fifth' }, { sheet: 'Лист5', headerRow: 2 }],
    ['ссылка без gid на книгу реестра', { target: url(FIFTH) }, { sheet: 'Лист5', headerRow: 2 }],
    ['голый ID книги реестра', { target: FIFTH }, { sheet: 'Лист5', headerRow: 2 }],
    [
      'явный sheet сильнее листа реестра',
      { target: 'fifth', sheet: 'Вводная' },
      { sheet: 'Вводная' },
    ],
    ['книга вне реестра — первый лист', { target: url(OTHER) }, { sheet: 'Вводная', headerRow: 1 }],
  ])('Q29: %s', async (_name, args, expected) => {
    const { result, meta } = await run(gcRead, { mode: 'map', ...args });
    expect(result.data).toMatchObject(expected);
    // Без gid выбор листа не стоит ни одного запроса: метаданные книги не читаются.
    expect(meta).toEqual([]);
  });
});
