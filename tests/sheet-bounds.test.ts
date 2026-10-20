/**
 * Колонки без подписи и границы данных (D-26, Q30–Q32) — хотфикс («чинить хотфиксом и быстро» —
 * слова владельца) по находкам двух сессий на живых листах (профиль work):
 * - «Лист5»: данные в A1:C27, C1 пустая, в C9–C11 три подпункта. При `headerRow: 1` колонки C не
 *   было ни в `columns`, ни в строках, предупреждения тоже — подсказал только `usedRange`;
 * - «Лог проверок»: `usedRange` A1:Z46 при колонках A «Статус» и B «Задачи» — оформление до Z46
 *   карта выдавала за границы данных, и есть ли значения в C–Z, узнать было нечем.
 *
 * Карта, `values` и запись — через настоящий протокол (урок L26), разбор — через `buildSheetData`.
 * План удаления «Лист5» через протокол (Q37) — здесь же, остальное о Q37 — в structure-width.test.
 */

import { describe, expect, it } from 'vitest';

import { buildSheetData, buildSheetMap } from '../src/core/sheets/map.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';
import type {
  Cell,
  CellValue,
  SheetMap,
  SheetSnapshot,
  SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import { gcApply, gcRead, type ToolDeps } from '../src/mcp/tools.js';
import { FakeSheetsClient, instructionSheet, reportSheet, row } from './fixtures/sheet.js';
import { callMcp } from './fixtures/protocol.js';

const ID = '1BOUNDSsheetFFFFFFFFFFFFFFFFFFFFFFFF';

/** Подпункты «Лист5» — в C9–C11; у колонки C подписи нет. */
const SUBITEMS: Readonly<Record<number, string>> = {
  9: 'а) доступы',
  10: 'б) ключи',
  11: 'в) счета',
};

/** «Лист5»: шапка A1:B1, C1 пустая; строки 2–27 — пункты, в C9–C11 — подпункты. */
function sheet5(): SheetSnapshot {
  const rows = [row('Пункт', 'Описание')];
  for (let n = 2; n <= 27; n += 1) {
    const sub = SUBITEMS[n];
    rows.push(row(`п. ${n - 1}`, `описание ${n - 1}`, ...(sub === undefined ? [] : [sub])));
  }
  return { title: 'Лист5', sheetId: 5, rows };
}

/** Ячейка с заливкой; без значения — одно оформление. */
const shade = (value: CellValue = null): Cell => ({ value, format: { background: '#f3f3f3' } });

/** «Лог проверок»: данные — в A1:B12, а заливка — на всей сетке A1:Z46. */
function checkLog(): SheetSnapshot {
  const rows = Array.from({ length: 46 }, (_, i) => {
    const status = i % 3 === 0 ? 'готово' : 'в работе';
    const values: CellValue[] =
      i === 0 ? ['Статус', 'Задачи'] : i < 12 ? [status, `задача ${i}`] : [];
    return Array.from({ length: 26 }, (_, column) => shade(values[column]));
  });
  return { title: 'Лог проверок', sheetId: 6, rows };
}

const book = (...sheets: SheetSnapshot[]): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Книга',
  revisionId: '1',
  sheets,
});

/** Цель `sheet` — лист по имени из реестра; `auto` — конверт (D-18): запись с первой фразы. */
function depsOf(client: FakeSheetsClient, sheet: string, auto?: unknown): ToolDeps {
  const target = { alias: 'sheet', id: ID, type: 'sheet', allow: 'write', sheet } as const;
  return {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () =>
      Promise.resolve({ targets: [{ ...target, ...(auto === undefined ? {} : { auto }) }] }),
    journal: () => Promise.resolve(),
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => Promise.resolve('1'),
  };
}

interface ValuesAnswer {
  readonly columns: readonly string[];
  readonly rows: { readonly value: readonly Record<string, CellValue>[] };
  readonly warnings: readonly string[];
}

/** `gc_read` листа книги через протокол: карта или окно строк. */
async function read<T = SheetMap>(sheet: SheetSnapshot, args: Record<string, unknown>): Promise<T> {
  const deps = depsOf(new FakeSheetsClient(book(sheet)), sheet.title);
  const result = await callMcp(gcRead, { target: 'sheet', ...args }, deps);
  expect(result.error).toBeUndefined();
  return result.data as T;
}

/** Предупреждение о колонках без подписи: что нашлось — и хвост, у карты и `values` свой. */
const unlabeledWarning = (found: string, tail: string): string =>
  `в колонках без подписи ${found} — ${tail}; писать в них нельзя, пока в шапке нет подписи`;
const mapTail = (keys: string): string =>
  `в данные не попали; прочитать — gc_read mode=values, там они ${keys}`;
const SHEET5_FOUND = '(C) есть значения: 3 ячейки в 3 строках';

describe('Q30 — колонки без подписи с данными видны', () => {
  it('Q30: «Лист5», headerRow 1 — C1 пустая, C9–C11 с текстом: поле unlabeled и предупреждение карты (воспроизведение)', async () => {
    const map = await read(sheet5(), { mode: 'map', headerRow: 1 });
    expect(map.columns.map((column) => column.name)).toEqual(['Пункт', 'Описание']);
    expect(map.unlabeled).toEqual([{ letter: 'C', index: 2, key: '(C)', filled: 3, rows: '9–11' }]);
    expect(map.warnings).toEqual([unlabeledWarning(SHEET5_FOUND, mapTail('под ключом «(C)»'))]);
  });

  it('Q30: «Лист5» в values — ячейки C под ключом «(C)» строка в строку, предупреждение — своё', async () => {
    const data = await read<ValuesAnswer>(sheet5(), { mode: 'values', headerRow: 1 });
    const rows = data.rows.value;
    // Строка ответа i — строка листа 2 + i: подпункты — в 7–9-й, в остальных ключ есть и пуст.
    expect(rows.map((record) => record['(C)'])).toEqual(
      Array.from({ length: 26 }, (_, i) => SUBITEMS[i + 2] ?? null),
    );
    expect(rows[7]).toEqual({ Пункт: 'п. 8', Описание: 'описание 8', '(C)': 'а) доступы' });
    // Имена для записи — прежние: ключ колонки без подписи в них не входит.
    expect(data.columns).toEqual(['Пункт', 'Описание']);
    expect(data.warnings).toEqual([unlabeledWarning(SHEET5_FOUND, 'в rows они под ключом «(C)»')]);
  });

  it.each([
    [
      'между подписями и правее последней — обе, по порядку листа',
      [
        row('Проект', 'Часы', null, 'Статус'),
        row('G connect', 2, null, 'в работе', null, 'см. письмо'),
        row('lash-try-on', 5, 'срочно', 'готово'),
        row('portfolio', 1, 'ждёт', 'пауза', null, 'перенесено'),
      ],
      ['C (C) 2 3–4', 'F (F) 2 2–4'],
      '(C, F) есть значения: 4 ячейки в 3 строках',
      'под ключами «(C)», «(F)»',
    ],
    [
      'подпись «(C)» в шапке уже есть — ключ колонки C без подписи «((C))»',
      [row('(C)', 'Описание'), row('копирайт', 'знак', 'продлён'), row('патент', 'номер', 'подан')],
      ['C ((C)) 2 2–3'],
      '(C) есть значения: 2 ячейки в 2 строках',
      'под ключом «((C))»',
    ],
    [
      'шесть колонок — в предупреждении пять и многоточие, в поле — все',
      [
        row('Ключ', 'Значение'),
        ...Array.from({ length: 6 }, (_, i) => row('a', i, ...Array<null>(i).fill(null), 'x')),
      ],
      ['C (C) 1 2', 'D (D) 1 3', 'E (E) 1 4', 'F (F) 1 5', 'G (G) 1 6', 'H (H) 1 7'],
      '(C, D, E, F, G, …) есть значения: 6 ячеек в 6 строках',
      'под ключами «(C)», «(D)», «(E)», «(F)», «(G)», …',
    ],
  ])('Q30: %s', (_name, rows, unlabeled, found, keys) => {
    const { map } = buildSheetData(book({ title: 'Лист', sheetId: 1, rows }), { headerRow: 1 });
    const brief = (map.unlabeled ?? []).map((u) => `${u.letter} ${u.key} ${u.filled} ${u.rows}`);
    expect(brief).toEqual(unlabeled);
    expect(map.warnings).toContain(unlabeledWarning(found, mapTail(keys)));
  });

  it('Q30: ключ не затирает подпись «(C)»: в values — и настоящая колонка, и «((C))»', async () => {
    const rows = [row('(C)', 'Описание'), row('патент', 'номер', 'заявка подана')];
    const data = await read<ValuesAnswer>({ title: 'Права', sheetId: 2, rows }, { mode: 'values' });
    expect(data.rows.value).toEqual([
      { '(C)': 'патент', Описание: 'номер', '((C))': 'заявка подана' },
    ]);
  });

  it('Q30: лист длиннее карты — колонку без подписи в строке 550 находит окно values, а не карта', async () => {
    const rows = [row('Компания', 'Статус')];
    for (let n = 2; n <= 600; n += 1) rows.push(row(`Компания ${n}`, 'новая'));
    rows[549] = row('Компания 550', 'новая', 'дубль 17');
    const sheet = { title: 'Агентства', sheetId: 3, rows };
    // Карта читает первые 500 строк — строки 550 в ней нет, и о колонке C она молчит.
    expect(await read(sheet, { mode: 'map' })).not.toHaveProperty('unlabeled');
    const data = await read<ValuesAnswer>(sheet, { mode: 'values', fromRow: 501 });
    expect(data.rows.value[49]).toEqual({
      Компания: 'Компания 550',
      Статус: 'новая',
      '(C)': 'дубль 17',
    });
    expect(data.warnings).toEqual([
      unlabeledWarning('(C) есть значения: 1 ячейка в 1 строке', 'в rows они под ключом «(C)»'),
    ]);
  });

  // Запись не открывается — это хотфикс чтения (п. 3): страховка, зелёная и до правки.
  it.each([
    ['appendRow', { op: 'appendRow', values: { Пункт: 'п. 27', '(C)': 'г) отчёт' } }],
    ['upsertRow', { op: 'upsertRow', key: { Пункт: 'п. 8' }, values: { '(C)': 'г) отчёт' } }],
    ['setCells', { op: 'setCells', where: { Пункт: 'п. 8' }, values: { '(C)': 'г) отчёт' } }],
    [
      'setCells, условием',
      { op: 'setCells', where: { '(C)': 'а) доступы' }, values: { Описание: 'новое' } },
    ],
  ])(
    'Q30: %s по ключу «(C)» в конверте — вопрос, как у незнакомой колонки, ни одной записи',
    async (_name, op) => {
      const client = new FakeSheetsClient(book(sheet5()));
      const auto = { ops: ['appendRow', 'upsertRow', 'setCells'], maxCells: 10 };
      const result = await callMcp(
        gcApply,
        { target: 'sheet', headerRow: 1, dryRun: false, ...op },
        depsOf(client, 'Лист5', auto),
      );
      const outcome = result.data as ApplyOutcome;
      expect(outcome.status).toBe('needs_clarification');
      expect(outcome.questions[0]).toMatchObject({ field: '(C)', reason: 'no_match' });
      expect(client.writes).toEqual([]);
      expect(client.batches).toEqual([]);
    },
  );
});

describe('Q31 — границы данных — по ячейкам со значением или формулой', () => {
  it('Q31: «Лог проверок» — заливка до Z46, данные в A–B: usedRange A1:B12, колонок без подписи нет (воспроизведение)', async () => {
    const map = await read(checkLog(), { mode: 'map' });
    // Размер сетки (Q7) — по-прежнему сетка: 46 строк, а не 12.
    expect(map).toMatchObject({
      usedRange: 'Лог проверок!A1:B12',
      dataRowCount: 11,
      sheetRows: 46,
    });
    // Пустые колонки без подписи — только оформление — не шум (Q30, п. 4): ни поля, ни слова.
    expect(map).not.toHaveProperty('unlabeled');
    expect(map.warnings).toEqual([]);
    const data = await read<ValuesAnswer>(checkLog(), { mode: 'values' });
    expect(data.rows.value.map((record) => Object.keys(record).join())).toEqual(
      Array.from({ length: 11 }, () => 'Статус,Задачи'),
    );
    expect(data.warnings).toEqual([]);
  });

  it.each([
    [
      'формула с пустым результатом — данные, строка с одним оформлением — нет',
      [
        row('Проект', 'Часы'),
        row('G connect', 2),
        row(null, null, { value: '', formula: '=IF(B2>8;"много";"")' }),
        [shade(), shade()],
      ],
      'Лист!A1:C3',
    ],
    [
      'на листе одно оформление и пробелы — как на пустом',
      [[shade(), shade(' '), shade()], [shade()]],
      'Лист!A1:A1',
    ],
    [
      'Q14: строка с копией вида без значений — не данные',
      [...reportSheet().rows, Array.from({ length: 4 }, () => shade())],
      'Лист!A1:D4',
    ],
  ])('Q31: %s', (_name, rows, usedRange) => {
    expect(buildSheetMap(book({ title: 'Лист', sheetId: 1, rows })).usedRange).toBe(usedRange);
  });

  it('Q31: высота других листов в карте — по данным, а не по оформлению', () => {
    expect(buildSheetMap(book(sheet5(), checkLog())).otherSheets).toEqual([
      { title: 'Лог проверок', rowCount: 12 },
    ]);
  });
});

describe('Q32 — без колонок без подписи — как раньше', () => {
  it.each([
    ['название отчёта над шапкой', reportSheet()],
    ['пустая колонка между двумя блоками («Инструкция»)', instructionSheet()],
  ])(
    'Q32: %s — ни поля unlabeled, ни нового предупреждения; в values — только колонки карты',
    async (_name, sheet) => {
      const map = await read(sheet, { mode: 'map' });
      expect(map).not.toHaveProperty('unlabeled');
      expect(map.warnings.filter((w) => w.includes('без подписи'))).toEqual([]);
      const data = await read<ValuesAnswer>(sheet, { mode: 'values' });
      for (const record of data.rows.value) expect(Object.keys(record)).toEqual(data.columns);
      expect(data.warnings).toEqual(map.warnings);
    },
  );
});

describe('Q37 — план удаления называет колонки без подписи', () => {
  it('Q37: «Лист5» через протокол — превью deleteRows строки 9: C9 «а) доступы» под ключом «(C)», как в values', async () => {
    const client = new FakeSheetsClient(book(sheet5()));
    const op = { target: 'sheet', headerRow: 1, op: 'deleteRows', where: { Пункт: 'п. 8' } };
    const result = await callMcp(gcApply, op, depsOf(client, 'Лист5'));
    const outcome = result.data as ApplyOutcome;
    expect(outcome.status).toBe('preview');
    const gone = (a1: string, column: string, before: CellValue) => ({
      kind: 'set',
      a1: `Лист5!${a1}`,
      column,
      before,
      after: null,
    });
    expect(outcome.changes).toEqual([
      gone('A9', 'Пункт', 'п. 8'),
      gone('B9', 'Описание', 'описание 8'),
      gone('C9', '(C)', 'а) доступы'),
    ]);
    // Превью — не запись: ни одной правки в книге.
    expect(client.formatWrites).toEqual([]);
  });
});
