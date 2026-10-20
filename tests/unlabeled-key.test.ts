/**
 * Колонка без подписи — явным ключом (D-26, Q40). Весть соседней сессии: лист ежедневного
 * отчёта, A1 пуста, B1–F1 подписаны, даты дней и названия задач — в колонке A. Карта называла A
 * колонкой без подписи `(A)`, но записать в неё и поставить её в условие было нельзя (Q30): якорь
 * «строка, где A = 19.10.2026» агент взял обходом `headerRow: 2`, и шапкой стала строка-пометка.
 * Решение владельца — «Явный ключ «(A)»»: писать и искать по такой колонке — только точным ключом
 * из карты, превью называет её «без подписи», похожие имена не подбираются.
 *
 * Превью, запись и откат — через настоящий протокол (урок L26) на фейке, применяющем записи;
 * сверка «было» и вид дописанной строки — прямым вызовом ядра.
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { buildSheetData, buildSheetMap } from '../src/core/sheets/map.js';
import { appendRow, type ApplyOutcome } from '../src/core/sheets/rows.js';
import { setCells } from '../src/core/sheets/set-cells-op.js';
import type {
  Cell,
  CellValue,
  SheetSnapshot,
  SheetsClient,
  SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import type { Registry } from '../src/core/targets.js';
import { undoLast } from '../src/core/undo.js';
import { gcApply, gcRead, gcUndo, type ToolDeps } from '../src/mcp/tools.js';
import { FakeSheetsClient, MutableSheetsClient, row } from './fixtures/sheet.js';
import { callMcp } from './fixtures/protocol.js';

const ID = '1UNLABELEDkeyAAAAAAAAAAAAAAAAAAAAAAAA';
const SHEET = 'Отчёт';

/** Допущение превью — одно на ключ и операцию. */
const ASSUMED = '(A) — колонка без подписи в шапке: беру A по явному ключу';

/** Лист отчёта по дням: A1 пуста, B1–F1 подписаны; в A — даты дней (2, 5) и названия задач. */
function dailySheet(): SheetSnapshot {
  return {
    title: SHEET,
    sheetId: 4,
    rows: [
      row(null, 'Суть задачи', 'Статус', 'Часы', 'Ссылка', 'Комментарий'),
      row('19.10.2026'),
      row('Разбор писем', 'ответить на вопросы', 'готово', 2),
      row('Сбор данных', 'выгрузить таблицу', 'в работе', 3),
      row('20.10.2026'),
      row('Созвон', 'обсудить план', 'готово', 1),
    ],
  };
}

const book = (sheet: SheetSnapshot): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Книга',
  revisionId: '1',
  sheets: [sheet],
});

/** Цель реестра — лист с шапкой в первой строке; `auto` — конверт (D-18), по просьбе теста. */
function harness(sheet: SheetSnapshot = dailySheet(), auto?: { ops: string[] }) {
  const client = new MutableSheetsClient(book(sheet));
  const journalled: WriteRecord[] = [];
  const target = { alias: 'report', id: ID, type: 'sheet', allow: 'write', sheet: sheet.title };
  const registry = {
    targets: [{ ...target, headerRow: 1, ...(auto === undefined ? {} : { auto }) }],
  };
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () => Promise.resolve(registry as Registry),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('1'),
  };
  return { client, deps, journalled };
}

const apply = async (deps: ToolDeps, op: Record<string, unknown>): Promise<ApplyOutcome> => {
  const result = await callMcp(gcApply, { target: 'report', ...op }, deps);
  expect(result.error).toBeUndefined();
  return result.data as ApplyOutcome;
};

/** Превью → запись по коду плана (D-16; у разрушающей — и фразой, D-20) → журнал. */
async function written(deps: ToolDeps, op: Record<string, unknown>, phrase?: string) {
  const preview = await apply(deps, op);
  expect(preview.status).toBe('preview');
  const confirm = phrase ?? preview.planId;
  const outcome = await apply(deps, { ...op, dryRun: false, confirm, planId: preview.planId });
  expect(outcome.status).toBe('ok');
  return preview;
}

/** Значения листа без пустых хвостов: фейк дописывает пустые ячейки, Google их не отдаёт. */
async function grid(client: SheetsClient): Promise<CellValue[][]> {
  const rows = (await client.getSpreadsheet(ID)).sheets[0]!.rows.map((cells) => {
    const values = cells.map((cell) => cell.value);
    while (values.length > 0 && values.at(-1) === null) values.pop();
    return values;
  });
  while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
  return rows;
}

const cellAt = async (client: SheetsClient, rowNumber: number, column: number): Promise<Cell> =>
  (await client.getSpreadsheet(ID)).sheets[0]!.rows[rowNumber - 1]?.[column] ?? { value: null };

describe('Q40 — превью, запись и откат по точному ключу колонки без подписи', () => {
  it('Q40: setCells — условие (A) и значение в (A): одно допущение, запись в A4, откат по адресу (воспроизведение)', async () => {
    const { client, deps, journalled } = harness();
    const before = await grid(client);
    const op = {
      op: 'setCells',
      where: { '(A)': 'Сбор данных' },
      values: { '(A)': 'Сбор отзывов' },
    };
    const preview = await written(deps, op);
    expect(preview.assumptions).toEqual([ASSUMED]);
    expect(preview.changes).toEqual([
      { kind: 'set', a1: 'Отчёт!A4', column: '(A)', before: 'Сбор данных', after: 'Сбор отзывов' },
    ]);
    expect((await cellAt(client, 4, 0)).value).toBe('Сбор отзывов');
    expect(journalled[0]?.changes).toEqual([
      { a1: 'Отчёт!A4', column: '(A)', before: 'Сбор данных', after: 'Сбор отзывов' },
    ]);
    const undone = await callMcp(gcUndo, { target: 'report' }, deps);
    expect(undone.data).toMatchObject({
      status: 'ok',
      restored: [{ a1: 'Отчёт!A4', column: '(A)', kind: 'value', value: 'Сбор данных' }],
    });
    expect(await grid(client)).toEqual(before);
  });

  it('Q40: upsertRow с ключом {"(A)": "19.10.2026"} — строка дня по A, правка в ней, откат', async () => {
    const { client, deps } = harness();
    const before = await grid(client);
    const op = { op: 'upsertRow', key: { '(A)': '19.10.2026' }, values: { Комментарий: 'итог' } };
    const preview = await written(deps, op);
    expect(preview.assumptions).toEqual([ASSUMED]);
    expect(preview.changes).toEqual([
      { kind: 'set', a1: 'Отчёт!F2', column: 'Комментарий', before: null, after: 'итог' },
    ]);
    expect((await cellAt(client, 2, 5)).value).toBe('итог');
    expect((await callMcp(gcUndo, { target: 'report' }, deps)).data).toMatchObject({
      status: 'ok',
    });
    expect(await grid(client)).toEqual(before);
  });

  it('Q40: upsertRow — дня 21.10.2026 в A нет: строка дописана, ключ (A) записан в неё, откат', async () => {
    const { client, deps } = harness();
    const before = await grid(client);
    const op = { op: 'upsertRow', key: { '(A)': '21.10.2026' }, values: { Комментарий: 'новый' } };
    const preview = await written(deps, op);
    expect(preview.assumptions).toEqual([ASSUMED]);
    expect(preview.changes.map(({ a1, column, after }) => [a1, column, after])).toEqual([
      ['Отчёт!A7', '(A)', '21.10.2026'],
      ['Отчёт!F7', 'Комментарий', 'новый'],
    ]);
    expect((await grid(client))[6]).toEqual(['21.10.2026', null, null, null, null, 'новый']);
    await callMcp(gcUndo, { target: 'report' }, deps);
    expect(await grid(client)).toEqual(before);
  });

  it('Q40: appendRow с (A) — ячейка A новой строки, свободным текстом, откат', async () => {
    const { client, deps } = harness();
    const before = await grid(client);
    const values = { '(A)': 'Новая задача', 'Суть задачи': 'описать шаги' };
    const preview = await written(deps, { op: 'appendRow', values });
    expect(preview.assumptions).toEqual([ASSUMED]);
    expect(preview.changes.map(({ kind, a1, after }) => [kind, a1, after])).toEqual([
      ['addRow', 'Отчёт!A7', 'Новая задача'],
      ['addRow', 'Отчёт!B7', 'описать шаги'],
    ]);
    expect((await grid(client))[6]).toEqual(['Новая задача', 'описать шаги']);
    await callMcp(gcUndo, { target: 'report' }, deps);
    expect(await grid(client)).toEqual(before);
  });

  it('Q40: formatCells columns ["(A)"] по условию (A) — вид ячейки A2, одно допущение, откат', async () => {
    const { client, deps } = harness();
    const op = {
      op: 'formatCells',
      where: { '(A)': '19.10.2026' },
      columns: ['(A)'],
      format: { bold: true },
    };
    const preview = await written(deps, op);
    expect(preview.assumptions).toEqual([ASSUMED]);
    expect(preview.changes).toEqual([
      {
        kind: 'format',
        a1: 'Отчёт!A2',
        column: '(A)',
        before: '19.10.2026',
        after: '19.10.2026',
        afterFormat: { bold: true },
      },
    ]);
    expect((await cellAt(client, 2, 0)).format).toEqual({ bold: true });
    expect((await callMcp(gcUndo, { target: 'report' }, deps)).data).toMatchObject({
      status: 'ok',
      restored: [{ a1: 'Отчёт!A2', column: '(A)', kind: 'format' }],
    });
    expect((await cellAt(client, 2, 0)).format?.bold ?? false).toBe(false);
  });

  it('Q40: formatCells — (A) только в условии: допущение есть; headerOnly с (A): шапка A1 в плане пуста', async () => {
    const { deps } = harness();
    const byCondition = await apply(deps, {
      op: 'formatCells',
      where: { '(A)': '20.10.2026' },
      columns: ['Суть задачи'],
      format: { italic: true },
    });
    expect(byCondition.assumptions).toEqual([ASSUMED]);
    expect(byCondition.changes.map((change) => change.a1)).toEqual(['Отчёт!B5']);
    const header = await apply(deps, {
      op: 'formatCells',
      headerOnly: true,
      columns: ['(A)', 'Суть задачи'],
      format: { bold: true },
    });
    expect(header.changes.map(({ a1, before, after }) => [a1, before, after])).toEqual([
      ['Отчёт!A1', null, null],
      ['Отчёт!B1', 'Суть задачи', 'Суть задачи'],
    ]);
  });

  it('Q40: deleteRows по условию (A) — день 20.10.2026: план с допущением, запись фразой, откат с A5', async () => {
    const { client, deps } = harness();
    const before = await grid(client);
    const op = { op: 'deleteRows', where: { '(A)': '20.10.2026' } };
    const preview = await written(deps, op, 'да, удаляю строку 20.10.2026');
    expect(preview.assumptions).toEqual([ASSUMED]);
    expect(preview.notes).toEqual([]);
    expect(preview.structural).toMatchObject({ kind: 'deleteRows', at: 5, count: 1 });
    expect((await grid(client))[4]).toEqual(['Созвон', 'обсудить план', 'готово', 1]);
    await callMcp(gcUndo, { target: 'report' }, deps);
    expect(await grid(client)).toEqual(before);
  });

  it('Q40: insertRows по якорю (A) — допущение и позиция по A; без условия — ни допущения, ни заметки', async () => {
    const { deps } = harness();
    const inserted = await apply(deps, { op: 'insertRows', where: { '(A)': '20.10.2026' } });
    expect(inserted).toMatchObject({ assumptions: [ASSUMED], notes: [] });
    expect(inserted.structural).toMatchObject({ kind: 'insertRows', at: 5, count: 1 });
    const added = await apply(deps, { op: 'addSheet', title: 'Ноябрь' });
    expect(added).toMatchObject({ status: 'preview', assumptions: [], notes: [] });
  });

  it.each([
    ['оба якоря', { '(A)': 'Созвон' }, { '(A)': '19.10.2026' }],
    ['только переносимая строка', { '(A)': 'Созвон' }, { 'Суть задачи': 'ответить на вопросы' }],
    ['только ориентир', { 'Суть задачи': 'обсудить план' }, { '(A)': 'Разбор писем' }],
  ])('Q40: moveRows, (A) — %s: допущение одно на операцию', async (_name, where, before) => {
    const { deps } = harness();
    const moved = await apply(deps, { op: 'moveRows', where, before });
    expect(moved.assumptions).toEqual([ASSUMED]);
    expect(moved.structural).toMatchObject({ kind: 'moveRows', at: 6, count: 1 });
  });

  it('Q40: ключи — по листу, который читает запись, а не по лёгкой карте: C только в строке 550', async () => {
    const rows = [row('Компания', 'Статус')];
    for (let n = 2; n <= 600; n += 1) rows.push(row(`Компания ${n}`, 'новая'));
    rows[549] = row('Компания 550', 'новая', 'дубль 17');
    const { client, deps } = harness({ title: SHEET, sheetId: 4, rows });
    // Карта читает первые 500 строк и колонку C не видит; запись читает лист целиком (D-26).
    expect((await callMcp(gcRead, { target: 'report' }, deps)).data).not.toHaveProperty(
      'unlabeled',
    );
    const where = { Компания: 'Компания 550' };
    await written(deps, { op: 'setCells', where, values: { '(C)': 'дубль 18' } });
    expect((await cellAt(client, 550, 2)).value).toBe('дубль 18');
  });

  it('Q40: оговорка условия видна в превью — нечёткое имя в where больше не теряется', async () => {
    const { deps } = harness();
    const outcome = await apply(deps, {
      op: 'setCells',
      where: { 'Суть задач': 'обсудить план' },
      values: { Комментарий: 'перенесён' },
    });
    expect(outcome.assumptions).toEqual(['«Суть задач» → колонка «Суть задачи»']);
    expect(outcome.changes.map((change) => change.a1)).toEqual(['Отчёт!F6']);
  });
});

describe('Q40 — только точный ключ: похожее не подбирается', () => {
  it.each([
    ['буква без скобок', 'A'],
    ['другой регистр', '(a)'],
    ['словами', 'колонка A'],
    ['кириллица в скобках', '(А)'],
    ['колонка без значений', '(G)'],
  ])('Q40: %s («%s») в values — вопрос, ни одной записи', async (_name, requested) => {
    const { client, deps } = harness(dailySheet(), { ops: ['appendRow'] });
    const before = await grid(client);
    const outcome = await apply(deps, {
      op: 'appendRow',
      dryRun: false,
      values: { [requested]: 'x' },
    });
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]).toMatchObject({ field: requested, reason: 'no_match' });
    expect(outcome.questions[0]?.available).toContain('(A)');
    expect(await grid(client)).toEqual(before);
  });

  it.each([['A'], ['колонка A'], ['колонка (A)'], ['(A) итог'], ['(А)']])(
    'Q40: «%s» — не ключ по виду: обычный вопрос «колонки нет», без подбора',
    async (requested) => {
      const { deps } = harness();
      const outcome = await apply(deps, { op: 'appendRow', values: { [requested]: 'x' } });
      expect(outcome.questions).toEqual([
        {
          field: requested,
          reason: 'no_match',
          detail: `Колонки «${requested}» в листе «Отчёт» нет. Создавать её сама не буду.`,
          candidates: [],
          available: ['Суть задачи', 'Статус', 'Часы', 'Ссылка', 'Комментарий', '(A)'],
        },
      ]);
    },
  );

  it.each([['A'], ['(a)'], ['колонка A']])(
    'Q40: «%s» в условии where — вопрос, строка не выбрана',
    async (requested) => {
      const { deps } = harness();
      const outcome = await apply(deps, {
        op: 'setCells',
        where: { [requested]: '19.10.2026' },
        values: { Комментарий: 'итог' },
      });
      expect(outcome.status).toBe('needs_clarification');
      expect(outcome.questions[0]).toMatchObject({ field: requested, reason: 'no_match' });
    },
  );

  it.each([['(G)'], ['(a)'], ['(AB)'], [' (G) ']])(
    'Q40: «%s» — ключ по виду, но такой колонки без подписи со значениями нет: список ключей и «подпиши шапку»',
    async (requested) => {
      const { deps } = harness();
      const outcome = await apply(deps, { op: 'appendRow', values: { [requested]: 'x' } });
      expect(outcome.questions).toMatchObject([
        {
          field: requested,
          detail:
            `Ключа «${requested}» среди колонок без подписи со значениями нет — есть «(A)». Ключ ` +
            'пишется точно, как в карте; в колонку без подписи и без значений не пишу — подпиши шапку.',
          candidates: [],
        },
      ]);
    },
  );

  it('Q40: две колонки без подписи — отказ называет оба ключа', async () => {
    const rows = [
      row('Проект', 'Часы', null, 'Статус'),
      row('первый', 2, 'срочно', 'готово', null, 'x'),
    ];
    const { deps } = harness({ title: SHEET, sheetId: 4, rows });
    const outcome = await apply(deps, { op: 'appendRow', values: { '(E)': 'x' } });
    expect(outcome.questions[0]?.detail).toContain('нет — есть «(C)», «(F)». Ключ');
  });

  it.each([['((B))'], ['(b)']])(
    'Q40: «%s» у подписанной колонки B — отказ с её подписью, а не запись в B',
    async (requested) => {
      const { deps } = harness();
      const outcome = await apply(deps, { op: 'appendRow', values: { [requested]: 'x' } });
      expect(outcome.questions).toEqual([
        {
          field: requested,
          reason: 'no_match',
          detail:
            'У B есть подпись «Суть задачи» — пиши по ней: ключ в скобках бывает только у колонки ' +
            'без подписи в шапке.',
          candidates: ['Суть задачи'],
          available: ['Суть задачи', 'Статус', 'Часы', 'Ссылка', 'Комментарий', '(A)'],
        },
      ]);
    },
  );

  it('Q40: ключ в скобках не сводится нечётко и к подписанной: «(B)» при «Итог (B)» — отказ', async () => {
    const rows = [row('Итог (B)', 'Описание'), row('план', 'первый')];
    const { deps } = harness({ title: SHEET, sheetId: 4, rows });
    const outcome = await apply(deps, { op: 'appendRow', values: { '(B)': 'x' } });
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]).toMatchObject({ field: '(B)', candidates: ['Описание'] });
  });

  it('Q40: на листе без колонок без подписи «(C)» — отказ «таких колонок нет»', async () => {
    const sheet = { title: SHEET, sheetId: 4, rows: [row('Задача', 'Часы'), row('первая', 1)] };
    const { deps } = harness(sheet);
    const outcome = await apply(deps, { op: 'appendRow', values: { '(C)': 'x' } });
    expect(outcome.questions[0]?.detail).toContain(
      'нет — на листе «Отчёт» таких колонок нет. Ключ пишется точно',
    );
    expect(outcome.questions[0]?.available).toEqual(['Задача', 'Часы']);
  });

  it('Q40: подпись «(C)» в шапке — «(C)» пишет в подписанную A, «((C))» — в колонку C без подписи', async () => {
    const rows = [row('(C)', 'Описание'), row('патент', 'номер', 'заявка подана')];
    const { deps } = harness({ title: 'Права', sheetId: 2, rows });
    const outcome = await apply(deps, {
      op: 'setCells',
      where: { '(C)': 'патент' },
      values: { '((C))': 'заявка принята', '(C)': 'полезная модель' },
    });
    expect(outcome.assumptions).toEqual([
      '((C)) — колонка без подписи в шапке: беру C по явному ключу',
    ]);
    expect(outcome.changes.map(({ a1, column }) => [a1, column])).toEqual([
      ['Права!C2', '((C))'],
      ['Права!A2', '(C)'],
    ]);
  });
});

describe('Q40 — значение в колонку без подписи — свободный текст, охранники — как у подписанной', () => {
  /** Двенадцать строк: в A и B одно и то же; B подписана и выводит из него тип или список. */
  const twin = (values: readonly CellValue[]): SheetSnapshot => ({
    title: SHEET,
    sheetId: 4,
    rows: [row(null, 'Метка', 'Задача'), ...values.map((v, i) => row(v, v, `задача ${i}`))],
  });

  it.each([
    ['числа — тип «число»', Array.from({ length: 12 }, (_, i) => i + 1), 'not_a_number'],
    [
      'три метки по четыре раза — список',
      ['план', 'факт', 'итог'].flatMap((v) => [v, v, v, v]),
      'not_in_enum',
    ],
  ])(
    'Q40: %s — у B вопрос, в (A) пишется «почти готово» как есть',
    async (_name, values, reason) => {
      const { deps } = harness(twin(values));
      const labeled = await apply(deps, { op: 'appendRow', values: { Метка: 'почти готово' } });
      expect(labeled.questions[0]).toMatchObject({ field: 'Метка', reason });
      const unlabeled = await apply(deps, { op: 'appendRow', values: { '(A)': 'почти готово' } });
      expect(unlabeled.status).toBe('preview');
      expect(unlabeled.changes).toMatchObject([{ a1: 'Отчёт!A14', after: 'почти готово' }]);
      // Ни приведения, ни разбора значения — только копия вида строки выше (Q14).
      expect(unlabeled.notes).toEqual(['оформление строки 14 — как у строки 13']);
    },
  );

  it('Q40: формулы в A без подписи — без force запись не идёт, как в подписанную', async () => {
    const formula = (n: number): Cell => ({ value: n, formula: '=ROW()-1' });
    const sheet = {
      title: SHEET,
      sheetId: 4,
      rows: [row(null, 'Задача'), row(formula(1), 'первая')],
    };
    const data = buildSheetData(book(sheet), { headerRow: 1 });
    await expect(
      setCells(new FakeSheetsClient(book(sheet)), data, { Задача: 'первая' }, { '(A)': 7 }),
    ).rejects.toMatchObject({ payload: { code: 'write_blocked', cause: 'formula_column' } });
  });

  it('Q40: A без подписи в защищённом диапазоне — без force запись не идёт', async () => {
    const sheet = {
      ...dailySheet(),
      protectedRanges: [{ startRow: 2, endRow: 100, startColumn: 0, endColumn: 0 }],
    };
    const data = buildSheetData(book(sheet), { headerRow: 1 });
    await expect(
      appendRow(new FakeSheetsClient(book(sheet)), data, { '(A)': 'x' }),
    ).rejects.toMatchObject({ payload: { code: 'write_blocked', cause: 'protected_range' } });
  });

  it('Q40: профиль записи колонки без подписи — ключ, свободный текст, формулы и защита; карта — прежняя', () => {
    // Различных — два: регистр и пробелы по краям не различают, пустая ячейка — не значение.
    const cells = [
      row(null, 'Задача'),
      row('План', 'а'),
      row({ value: 'план', formula: '=B1' }, 'б'),
      row(' факт ', 'в'),
      row('факт', 'г'),
      row(null, 'д'),
    ];
    const sheet = {
      title: SHEET,
      sheetId: 4,
      rows: cells,
      protectedRanges: [{ startRow: 2, endRow: 9, startColumn: 0, endColumn: 0 }],
    };
    const data = buildSheetData(book(sheet), { headerRow: 1 });
    expect(data.unlabeled).toEqual([
      {
        name: '(A)',
        letter: 'A',
        index: 0,
        type: 'string',
        dateFormat: null,
        enumValues: null,
        enumSource: null,
        filled: 4,
        unique: 2,
        hasFormula: true,
        protected: true,
      },
    ]);
    expect(data.rows[0]).toEqual({ Задача: 'а', '(A)': 'План' });
    expect(buildSheetData(book(dailySheet()), { headerRow: 1 }).unlabeled[0]).toMatchObject({
      hasFormula: false,
      protected: false,
    });
    // Страховка, зелёная и до правки: карта — без ключа в колонках и образцах строк (Q30–Q32).
    const map = buildSheetMap(book(sheet), { headerRow: 1 });
    expect(map.columns.map((column) => column.name)).toEqual(['Задача']);
    expect(map.sampleRows[0]).toEqual({ Задача: 'а' });
  });
});

describe('Q40 — сверка «было», дубль дозаписи и вид строки — по ячейкам (A)', () => {
  it('Q40: A4 правили после превью — stale_value, ни одной записи; правили после записи — откат отказан', async () => {
    const client = new MutableSheetsClient(book(dailySheet()));
    const data = buildSheetData(await client.getSpreadsheet(ID), { headerRow: 1 });
    const where = { '(A)': 'Сбор данных' };
    const preview = await setCells(client, data, where, { '(A)': 'Сбор отзывов' });
    await client.updateValues(ID, 'Отчёт!A4', [['Сбор данных и отчёт']]);
    await expect(
      setCells(
        client,
        data,
        where,
        { '(A)': 'Сбор отзывов' },
        {
          dryRun: false,
          confirm: preview.planId!,
        },
      ),
    ).rejects.toMatchObject({ payload: { code: 'stale_value' } });
    expect((await cellAt(client, 4, 0)).value).toBe('Сбор данных и отчёт');

    const { deps, client: other } = harness();
    await written(deps, { op: 'setCells', where, values: { '(A)': 'Сбор отзывов' } });
    await other.updateValues(ID, 'Отчёт!A4', [['правка человека']]);
    const undone = await callMcp(gcUndo, { target: 'report' }, deps);
    expect(undone.error).toMatchObject({
      code: 'revision_conflict',
      cause: 'cell_changed_after_write',
    });
  });

  it('Q40: дубль appendRow в конверте учитывает (A) — та же строка: no_change, другой день в A: запись', async () => {
    const { client, deps } = harness(dailySheet(), { ops: ['appendRow'] });
    const append = (day: string) =>
      apply(deps, {
        op: 'appendRow',
        dryRun: false,
        values: { '(A)': day, 'Суть задачи': 'итог' },
      });
    expect((await append('21.10.2026')).status).toBe('ok');
    const again = await append('21.10.2026');
    expect(again.status).toBe('no_change');
    expect(again.notes.at(-1)).toContain('Такая строка уже дописана');
    expect((await append('22.10.2026')).status).toBe('ok');
    expect((await grid(client)).slice(6)).toEqual([
      ['21.10.2026', 'итог'],
      ['22.10.2026', 'итог'],
    ]);
  });

  it('Q40: вид дописанной строки копируется от A, когда дозапись пишет в (A); без (A) — от B, как раньше', async () => {
    const copied = async (values: Record<string, string>) => {
      const client = new FakeSheetsClient(book(dailySheet()));
      const data = buildSheetData(await client.getSpreadsheet(ID), { headerRow: 1 });
      await appendRow(client, data, values, {
        dryRun: false,
        authorize: () => ({ authorized: true }),
      });
      return client.formatWrites[0];
    };
    expect(await copied({ '(A)': 'Задача', Статус: 'новая' })).toMatchObject({
      kind: 'copyPaste',
      source: { row: 6, column: 0, columnCount: 6 },
      destination: { row: 7, column: 0, columnCount: 6 },
    });
    expect(await copied({ Статус: 'новая' })).toMatchObject({
      source: { row: 6, column: 1, columnCount: 5 },
    });
  });

  it('Q40: откат записи в (A) из журнала — по адресу, а не по имени колонки', async () => {
    const client = new MutableSheetsClient(book(dailySheet()));
    const journalled: WriteRecord[] = [];
    const data = buildSheetData(await client.getSpreadsheet(ID), { headerRow: 1 });
    await appendRow(
      client,
      data,
      { '(A)': '21.10.2026' },
      {
        dryRun: false,
        authorize: () => ({ authorized: true }),
        journal: async (record) => {
          journalled.push(record);
        },
      },
    );
    const outcome = await undoLast(client, ID, { recent: () => Promise.resolve(journalled) });
    expect(outcome).toMatchObject({ status: 'ok', restored: [{ a1: 'Отчёт!A7', value: null }] });
    expect((await cellAt(client, 7, 0)).value).toBeNull();
  });
});
