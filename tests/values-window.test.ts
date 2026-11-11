/**
 * Окно строк `gc_read mode=values` называет конец ответа и не теряет оформленные пустые строки
 * (D-26, Q36, Q38) — вести двух сессий:
 * - Q36: `fromRow 8, limit 5` при пустой 12-й строке и данных с 13-й отдавал четыре строки и
 *   `nextFromRow: 13` — сдвига нет, но строк меньше `limit`, и что 12-я пуста, агент не видел;
 * - Q38: после `insertRows` две пустые, но оформленные строки 3–4 сверху листа — окно
 *   `fromRow 3, limit 2, withFormat` вернуло `[]`: пустой хвост срезался вместе с `formats`.
 *
 * Через настоящий протокол (урок L26), на фейке, который отдаёт окно как Google: строку хвоста
 * без значения, формулы, вида и заметки он не отдаёт, оформленную или с заметкой — отдаёт.
 */

import { describe, expect, it } from 'vitest';

import type { Cell, CellFormat, CellValue, SheetSnapshot } from '../src/core/sheets/types.js';
import { gcRead, type ToolDeps } from '../src/mcp/tools.js';
import { FakeSheetsClient, row } from './fixtures/sheet.js';
import { callMcp } from './fixtures/protocol.js';

const ID = '1WINDOWsheetHHHHHHHHHHHHHHHHHHHHHHHH';

const book = (sheet: SheetSnapshot) => ({
  id: ID,
  title: 'Книга',
  revisionId: '1',
  sheets: [sheet],
});

/** Цель — лист по имени из реестра, шапка в первой строке. */
function depsOf(sheet: SheetSnapshot): ToolDeps {
  const target = {
    alias: 'sheet',
    id: ID,
    type: 'sheet',
    sheet: sheet.title,
    headerRow: 1,
  } as const;
  return {
    account: 'default',
    sheets: () => Promise.resolve(new FakeSheetsClient(book(sheet))),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () => Promise.resolve({ targets: [target] }),
    journal: () => Promise.resolve(),
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => Promise.resolve('1'),
  };
}

interface ValuesAnswer {
  readonly fromRow: number;
  readonly toRow?: number;
  readonly rows: { readonly value: readonly Record<string, CellValue>[] };
  readonly formats?: { readonly value: readonly Record<string, CellFormat>[] };
  readonly notes?: { readonly value: readonly Record<string, string>[] };
  readonly truncated: boolean;
  readonly nextFromRow?: number;
  readonly warnings: readonly string[];
}

/** Окно строк листа через протокол. */
async function read(sheet: SheetSnapshot, args: Record<string, unknown>): Promise<ValuesAnswer> {
  const result = await callMcp(gcRead, { target: 'sheet', mode: 'values', ...args }, depsOf(sheet));
  expect(result.error).toBeUndefined();
  return result.data as ValuesAnswer;
}

/** Предупреждение о срезанном хвосте окна: какие строки — и куда идти дальше. */
const cut = (what: string): string => `${what} — продолжай с nextFromRow`;

/** «Проекты»: шапка, строки 2–11 с данными, 12–14 пусты, 15–20 — снова данные; сетка — 30 строк. */
function projects(): SheetSnapshot {
  const rows = [row('Проект', 'Статус')];
  for (let n = 2; n <= 20; n += 1) {
    rows.push(n >= 12 && n <= 14 ? row(null, null) : row(`проект ${n}`, 'в работе'));
  }
  return { title: 'Проекты', sheetId: 1, rows, gridRows: 30 };
}

/** Проекты строк ответа по порядку: пустая строка — `null`. */
const names = (answer: ValuesAnswer) => answer.rows.value.map((record) => record['Проект']);

describe('Q36 — окно строк называет конец ответа', () => {
  it('Q36: fromRow 8, limit 5, 12-я пуста, данные с 13-й — четыре строки, toRow 11, nextFromRow 13 и слово о 12-й (воспроизведение)', async () => {
    const answer = await read(projects(), { fromRow: 8, limit: 5 });
    expect(names(answer)).toEqual(['проект 8', 'проект 9', 'проект 10', 'проект 11']);
    expect(answer).toMatchObject({ fromRow: 8, toRow: 11, truncated: true, nextFromRow: 13 });
    expect(answer.warnings).toEqual([cut('строка 12 окна пуста и в ответ не вошла')]);
  });

  it.each([
    [
      'три пустые строки в хвосте окна — «строки 12–14», первая срезанная и конец окна',
      { fromRow: 8, limit: 7 },
      { count: 4, toRow: 11, nextFromRow: 15 },
      [cut('строки 12–14 окна пусты и в ответ не вошли')],
    ],
    [
      'без среза — toRow = fromRow + limit − 1, предупреждения нет',
      { fromRow: 8, limit: 4 },
      { count: 4, toRow: 11, nextFromRow: 12 },
      [],
    ],
    [
      'пустые строки в середине окна — строки ответа, а не срез',
      { fromRow: 10, limit: 8 },
      { count: 8, toRow: 17, nextFromRow: 18 },
      [],
    ],
    [
      'окно целиком пусто, а строки дальше есть — поля toRow нет, предупреждение — обо всём окне',
      { fromRow: 21, limit: 5 },
      { count: 0, toRow: undefined, nextFromRow: 26 },
      [cut('строки 21–25 окна пусты и в ответ не вошли')],
    ],
  ])('Q36: %s', async (_name, args, end, warnings) => {
    const answer = await read(projects(), args);
    expect(answer.rows.value).toHaveLength(end.count);
    expect(answer.toRow).toBe(end.toRow);
    if (end.toRow === undefined) expect(answer).not.toHaveProperty('toRow');
    expect(answer).toMatchObject({ truncated: true, nextFromRow: end.nextFromRow });
    expect(answer.warnings).toEqual(warnings);
  });

  it.each([
    ['окно дошло до конца сетки — toRow у последней строки с данными', { fromRow: 15 }, 6, 20],
    ['за данными до конца сетки — пустой ответ без toRow', { fromRow: 25, limit: 6 }, 0, undefined],
  ])('Q36: %s, предупреждения нет: дальше строк нет', async (_name, args, count, toRow) => {
    const answer = await read(projects(), args);
    expect(answer.rows.value).toHaveLength(count);
    expect(answer.toRow).toBe(toRow);
    expect(answer).toMatchObject({ truncated: false });
    expect(answer).not.toHaveProperty('nextFromRow');
    expect(answer.warnings).toEqual([]);
  });

  it('Q36: описание gc_read называет toRow — агент читает описание, а не спеку', () => {
    expect(gcRead.description).toContain('toRow');
  });
});

const GREEN: CellFormat = { background: '#d9ead3' };

/** Ячейка с видом соседней строки: так вставленная строка наследует оформление. */
const look = (value: CellValue): Cell => ({ value, format: GREEN });

/** Пустая строка ответа — все ключи окна, все `null`: так выглядит и пропуск в середине окна. */
const EMPTY = { Проект: null, Статус: null };

/**
 * Как после `insertRows`: строки 3–4 вставлены пустыми и унаследовали вид соседней строки; 5-я
 * пуста и без вида, с 6-й — снова данные.
 */
function inserted(): SheetSnapshot {
  return {
    title: 'Проекты',
    sheetId: 1,
    rows: [
      row('Проект', 'Статус'),
      [look('G connect'), look('в работе')],
      [look(null), look(null)],
      [look(null), look(null)],
      row(null, null),
      [look('lash-try-on'), look('готово')],
    ],
  };
}

/** Строка 3 пуста, но у её статуса заметка — договорённость, записанная до значения. */
function noted(): SheetSnapshot {
  return {
    title: 'Проекты',
    sheetId: 1,
    rows: [
      row('Проект', 'Статус'),
      row('G connect', 'в работе'),
      [{ value: null }, { value: null, note: 'заполнить после созвона' }],
      row('lash-try-on', 'готово'),
    ],
  };
}

describe('Q38 — окно с withFormat и withNotes не теряет оформленные пустые строки', () => {
  it('Q38: после insertRows — fromRow 3, limit 2, withFormat: две пустые строки и их вид строка в строку (воспроизведение)', async () => {
    const answer = await read(inserted(), { fromRow: 3, limit: 2, withFormat: true });
    expect(answer.rows.value).toEqual([EMPTY, EMPTY]);
    const both = { Проект: GREEN, Статус: GREEN };
    expect(answer.formats?.value).toEqual([both, both]);
    // Строки ответа, а не срез: toRow их включает, и о них Q36 не говорит.
    expect(answer).toMatchObject({ toRow: 4, truncated: true, nextFromRow: 5 });
    expect(answer.warnings).toEqual([]);
  });

  it('Q38: такая строка — той же формы, что пустая строка в середине окна', async () => {
    const middle = (await read(inserted(), { fromRow: 2, limit: 5 })).rows.value;
    expect(middle.map((record) => record['Проект'])).toEqual([
      'G connect',
      null,
      null,
      null,
      'lash-try-on',
    ]);
    expect(middle[1]).toEqual(EMPTY);
    const tail = await read(inserted(), { fromRow: 3, limit: 2, withFormat: true });
    expect(tail.rows.value).toEqual([middle[1], middle[2]]);
  });

  it('Q38: за оформленными строками пустая без вида — срез, и Q36 называет только её', async () => {
    const answer = await read(inserted(), { fromRow: 3, limit: 3, withFormat: true });
    expect(answer.rows.value).toEqual([EMPTY, EMPTY]);
    expect(answer).toMatchObject({ toRow: 4, truncated: true, nextFromRow: 6 });
    expect(answer.warnings).toEqual([cut('строка 5 окна пуста и в ответ не вошла')]);
  });

  it('Q38: без флагов — как раньше: оформленные пустые строки срезаны, Q36 называет их', async () => {
    const answer = await read(inserted(), { fromRow: 3, limit: 2 });
    expect(answer.rows.value).toEqual([]);
    expect(answer).not.toHaveProperty('toRow');
    expect(answer).not.toHaveProperty('formats');
    expect(answer).toMatchObject({ truncated: true, nextFromRow: 5 });
    expect(answer.warnings).toEqual([cut('строки 3–4 окна пусты и в ответ не вошли')]);
  });

  // Окно — только пустые строки листа: 3–4 у `inserted`, 3-я у `noted`.
  it.each([
    ['вид держит строку при withFormat', inserted(), 2, { withFormat: true }, 2],
    ['вид не держит строку, когда просили только заметки', inserted(), 2, { withNotes: true }, 0],
    ['заметка держит строку при withNotes', noted(), 1, { withNotes: true }, 1],
    ['заметка не держит строку, когда просили только вид', noted(), 1, { withFormat: true }, 0],
    ['оба флага — держит то, что есть', noted(), 1, { withFormat: true, withNotes: true }, 1],
  ])('Q38: %s', async (_name, sheet, limit, flags, count) => {
    const answer = await read(sheet, { fromRow: 3, limit, ...flags });
    expect(answer.rows.value).toEqual(Array.from({ length: count }, () => EMPTY));
  });

  it('Q38: withNotes — пустая строка с заметкой и её заметка строка в строку', async () => {
    const answer = await read(noted(), { fromRow: 3, limit: 1, withNotes: true });
    expect(answer.rows.value).toEqual([EMPTY]);
    expect(answer.notes?.value).toEqual([{ Статус: 'заполнить после созвона' }]);
    expect(answer).toMatchObject({ toRow: 3, truncated: true, nextFromRow: 4 });
    expect(answer.warnings).toEqual([]);
  });

  it('Q38: вид за краем колонок окна строку не держит — в formats его не видно', async () => {
    const blank = { value: null };
    const sheet: SheetSnapshot = {
      title: 'Проекты',
      sheetId: 1,
      rows: [
        row('Проект', 'Статус'),
        row('G connect', 'в работе'),
        [blank, blank, blank, blank, look(null)],
        row('lash-try-on', 'готово'),
      ],
    };
    const answer = await read(sheet, { fromRow: 3, limit: 1, withFormat: true });
    expect(answer.rows.value).toEqual([]);
    expect(answer.warnings).toEqual([cut('строка 3 окна пуста и в ответ не вошла')]);
  });

  it('Q38: колонка без подписи — тем же путём: со значениями в окне её вид держит строку под ключом «(C)»', async () => {
    const blank = { value: null };
    const sheet: SheetSnapshot = {
      title: 'Лист5',
      sheetId: 5,
      rows: [
        row('Пункт', 'Описание'),
        row('п. 1', 'описание 1', 'а) доступы'),
        [blank, blank, look(null)],
        row('п. 2', 'описание 2'),
      ],
    };
    const answer = await read(sheet, { fromRow: 2, limit: 2, withFormat: true });
    expect(answer.rows.value).toEqual([
      { Пункт: 'п. 1', Описание: 'описание 1', '(C)': 'а) доступы' },
      { Пункт: null, Описание: null, '(C)': null },
    ]);
    expect(answer.formats?.value).toEqual([{}, { '(C)': GREEN }]);
    expect(answer.toRow).toBe(3);
    // Без значений в окне колонка C — не колонка окна (Q30), и один её вид строку не держит.
    expect((await read(sheet, { fromRow: 3, limit: 1, withFormat: true })).rows.value).toEqual([]);
  });

  it('Q38: фейк отдаёт окно как Google — строки хвоста с видом, заметкой и формулой приходят, совсем пустая — нет', async () => {
    const rows = [
      row('Проект'),
      [look(null)],
      [{ value: null, note: 'заполнить после созвона' }],
      [{ value: '', formula: '=IF(A1="";"";A1)' }],
      row(null),
    ];
    const client = new FakeSheetsClient(book({ title: 'Лист', sheetId: 1, rows }));
    const window = await client.readRows(ID, 'Лист', 2, 4);
    expect(window.rows).toEqual(rows.slice(1, 4));
    expect(window.gridRows).toBe(5);
  });
});
