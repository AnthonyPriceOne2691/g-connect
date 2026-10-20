/**
 * Ежедневный отчёт (D-26, Q39, Q41) — весть сессии соседнего проекта (профиль work). Лист: новые
 * дни сверху, шапка в строке 1 (A1 пуста, B1–F1 подписаны), строка 2 — объединённая A2:F2 с
 * пометкой. Агент вставил `insertRows` две строки над днём 19.10 (строки 3–4, вид унаследован) — и
 * не смог вписать в них задачу: `setCells` выбирал строки только `where` и писал во все подошедшие,
 * а пустых по B–F строк на листе много — уникального условия у новой строки нет (Q39). Вставленная
 * строка унаследовала от строки дня формат DATE и TIME, а вернуть «автоматический» было нечем
 * (Q41).
 *
 * Инструменты — через настоящий протокол (урок L26); маска сброса — на форме запроса Google
 * (урок L28); запись, откат и чтение после сброса — на фейке с семантикой Google
 * (`fixtures/sheet.ts`). Лист — `fixtures/daily-report.ts`: его делит сьют правки вида по образцу
 * строки (Q42).
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { parseOperation } from '../src/core/ops.js';
import { formatRows } from '../src/core/sheets/format-op.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import type { RowSelection } from '../src/core/sheets/row-selection.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';
import { setRows } from '../src/core/sheets/set-cells-op.js';
import type { CellFormat } from '../src/core/sheets/types.js';
import { gcApply, gcRead, gcUndo } from '../src/mcp/tools.js';
import {
  COLUMNS,
  DAY,
  ID,
  SPENT,
  TITLE,
  book,
  dailySheet,
  depsOf,
  google,
  harness,
  valuesOf,
  withCell,
  withoutGoogle,
} from './fixtures/daily-report.js';
import { FakeSheetsClient, MutableSheetsClient, row } from './fixtures/sheet.js';
import { callMcp, protocolSession } from './fixtures/protocol.js';

/** Задача, которую агент вписывал в первую вставленную строку. */
const TASK = { 'Суть задачи': 'сверка отчёта за день', Время: '0:30' };

const setCall = (selection: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  op: 'setCells',
  target: 'daily',
  values: TASK,
  ...selection,
  ...extra,
});

const planOf = (data: unknown) =>
  (data as ApplyOutcome).changes.map(({ a1, before, after }) => ({ a1, before, after }));

describe('Q39 — setCells по номерам строк: пустая вставленная строка пишется', () => {
  it('Q39: rows {from: 3, to: 3} — план B3, C3 «пусто → значение», запись в конверте, откат возвращает пусто', async () => {
    const { client, deps, journalled } = harness();
    const preview = await callMcp(gcApply, setCall({ rows: { from: 3, to: 3 } }), deps);
    expect(preview.data).toMatchObject({ status: 'preview' });
    expect(planOf(preview.data)).toEqual([
      { a1: 'Отчёт!B3', before: null, after: 'сверка отчёта за день' },
      { a1: 'Отчёт!C3', before: null, after: '0:30' },
    ]);
    // Запись значений, а не правка вида: тот же вид плана, что у условия.
    expect((preview.data as ApplyOutcome).changes.map((change) => change.kind)).toEqual([
      'set',
      'set',
    ]);
    expect(journalled).toHaveLength(0);

    const written = await callMcp(
      gcApply,
      setCall({ rows: { from: 3, to: 3 } }, { dryRun: false }),
      deps,
    );
    expect(written.data).toMatchObject({ status: 'ok' });
    expect(await valuesOf(client, 3)).toEqual([
      null,
      'сверка отчёта за день',
      '0:30',
      null,
      null,
      null,
    ]);
    // Вторая вставленная строка и строка дня — нетронуты: пишется ровно названная строка.
    expect(await valuesOf(client, 4)).toEqual([null, null, null, null, null, null]);
    expect(await valuesOf(client, 5)).toEqual([null, '19.10', '2:15', null, null, null]);
    expect(journalled.map((record) => record.changes.map((change) => change.a1))).toEqual([
      ['Отчёт!B3', 'Отчёт!C3'],
    ]);

    const undone = await callMcp(gcUndo, { target: 'daily' }, deps);
    expect(undone.data).toMatchObject({ status: 'ok' });
    expect(await valuesOf(client, 3)).toEqual([null, null, null, null, null, null]);
    expect(journalled.map((record) => record.op)).toEqual(['setCells', 'undo']);
  });

  it('Q39: rows строкой JSON — тот же план, что объектом; не та форма — отказ с ожидаемой формой', async () => {
    const { deps } = harness();
    const asText = await callMcp(gcApply, setCall({ rows: '{"from": 3, "to": 4}' }), deps);
    const asObject = await callMcp(gcApply, setCall({ rows: { from: 3, to: 4 } }), deps);
    expect(planOf(asText.data)).toEqual(planOf(asObject.data));
    expect(planOf(asText.data).map((change) => change.a1)).toEqual([
      'Отчёт!B3',
      'Отчёт!C3',
      'Отчёт!B4',
      'Отчёт!C4',
    ]);
    const wrong = await callMcp(gcApply, setCall({ rows: '[3, 4]' }), withoutGoogle());
    expect(wrong.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(wrong.error?.detail).toContain('rows у setCells — {from, to}: номера строк листа');
  });

  it('Q39: конверт судит ячейки плана — строки × колонки: 2 × 2 = 4 при maxCells 3 — код плана, записи нет', async () => {
    const { client, deps, journalled } = harness(3);
    const result = await callMcp(
      gcApply,
      setCall({ rows: { from: 3, to: 4 } }, { dryRun: false }),
      deps,
    );
    const data = result.data as { status: string; changes: unknown[]; planId: string | null };
    expect(data.status).toBe('confirm_required');
    expect(data.changes).toHaveLength(4);
    expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(await valuesOf(client, 3)).toEqual([null, null, null, null, null, null]);
    expect(journalled).toHaveLength(0);
  });

  it('Q39: пустое значение в пустую строку — no_change, а не пустая запись', async () => {
    const { client, deps, journalled } = harness();
    const result = await callMcp(
      gcApply,
      setCall({ rows: { from: 3, to: 3 } }, { values: { 'Суть задачи': '' }, dryRun: false }),
      deps,
    );
    expect(result.data).toMatchObject({ status: 'no_change', changes: [] });
    expect(await valuesOf(client, 3)).toEqual([null, null, null, null, null, null]);
    expect(journalled).toHaveLength(0);
  });

  it('Q39: пустое where — у правки вида отказ прежним текстом, у setCells все строки данных, как прежде (K3)', async () => {
    const { deps } = harness();
    const format = await callMcp(
      gcApply,
      { op: 'formatCells', target: 'daily', where: {}, columns: ['Время'], format: { bold: true } },
      withoutGoogle(),
    );
    expect(format.error?.detail).toBe(
      'Пустое условие where выбрало бы все строки молча. Нужны все строки данных — скажи это ' +
        'явно: allRows: true. Ни одной правки не сделано.',
    );
    const values = await callMcp(gcApply, setCall({ where: {} }), deps);
    expect(values.data).toMatchObject({ status: 'preview' });
    const rows = planOf(values.data).map((change) => Number(/\d+$/.exec(change.a1)?.[0]));
    expect([...new Set(rows)]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('Q39: rows вместе с where — отказ row_selection до обращения к Google, оба способа названы', async () => {
    const result = await callMcp(
      gcApply,
      setCall({ rows: { from: 3, to: 3 }, where: { 'Суть задачи': 'правка шаблона' } }),
      withoutGoogle(),
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
    expect(result.error?.detail).toContain('(where, rows)');
  });

  it.each([
    [{ allRows: true }, 'allRows'],
    [{ headerOnly: true }, 'headerOnly'],
    [{ allRows: true, headerOnly: true }, 'allRows и headerOnly'],
    [{ allRows: true, rows: { from: 3, to: 3 } }, 'allRows'],
  ])(
    'Q39: %j у setCells — отказ row_selection со способами setCells, а не «незнакомое поле»',
    async (selection, named) => {
      const result = await callMcp(gcApply, setCall(selection), withoutGoogle());
      expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
      expect(result.error?.detail).toBe(
        `setCells: здесь нет ${named} — так строки выбирает только правка вида (formatCells). ` +
          'Нужен ровно один: where — условие на строки, rows: {from, to} — номера строк листа ' +
          '(включительно). Ни одной правки не сделано.',
      );
    },
  );

  it('Q39: ни where, ни rows — отказ row_selection с двумя способами; allRows: false — не способ', async () => {
    for (const selection of [{}, { allRows: false, headerOnly: false }]) {
      const result = await callMcp(gcApply, setCall(selection), withoutGoogle());
      expect(result.error, JSON.stringify(selection)).toMatchObject({
        code: 'bad_request',
        cause: 'row_selection',
      });
      expect(result.error?.detail).toContain('setCells: не выбраны строки');
      expect(result.error?.detail).not.toContain('allRows: true —');
    }
  });

  it('Q39: from больше to — rows_reversed до обращения к Google', async () => {
    const result = await callMcp(gcApply, setCall({ rows: { from: 4, to: 3 } }), withoutGoogle());
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'rows_reversed' });
    expect(result.error?.detail).toBe(
      'rows: from 4 больше to 3 — в таком диапазоне нет ни одной строки. Номера — строки листа ' +
        'включительно: {from: 3, to: 4}. Ни одной правки не сделано.',
    );
  });

  it('Q39: from — строка шапки: отказ называет границы данных и не советует headerOnly', async () => {
    const { client, deps } = harness();
    for (const rows of [
      { from: 1, to: 3 },
      { from: 1, to: 9 },
    ]) {
      const result = await callMcp(gcApply, setCall({ rows }), deps);
      expect(result.error, JSON.stringify(rows)).toMatchObject({
        code: 'bad_request',
        cause: 'rows_outside_data',
      });
      expect(result.error?.detail).toContain('данные — строки 2–9');
      expect(result.error?.detail).toContain(
        'Шапка — подписи колонок, а не данные: setCells её не пишет.',
      );
      expect(result.error?.detail).not.toContain('headerOnly');
      // Последняя строка данных — в пределах: подсказки про строки ниже данных здесь нет.
      expect(result.error?.detail).not.toContain('appendRow');
    }
    const whole = await callMcp(gcApply, setCall({ rows: { from: 1, to: 9 } }), deps);
    expect(whole.error?.detail).toBe(
      'rows: строки 1–9 — за пределами строк данных листа «Отчёт»: данные — строки 2–9. Ни одной ' +
        'правки не сделано. Шапка — подписи колонок, а не данные: setCells её не пишет.',
    );
    expect(await valuesOf(client, 1)).toEqual([null, ...COLUMNS]);
  });

  it('Q39: строки ниже последней строки данных — отказ с подсказкой «новая строка — appendRow»', async () => {
    const { client, deps } = harness();
    for (const rows of [
      { from: 9, to: 10 },
      { from: 12, to: 12 },
    ]) {
      const result = await callMcp(gcApply, setCall({ rows }), deps);
      expect(result.error, JSON.stringify(rows)).toMatchObject({
        code: 'bad_request',
        cause: 'rows_outside_data',
      });
      expect(result.error?.detail).toContain('данные — строки 2–9');
      expect(result.error?.detail).toContain(
        'Строки ниже данных setCells не пишет: новая строка — appendRow.',
      );
      expect(result.error?.detail).not.toContain('Шапка');
    }
    const single = await callMcp(gcApply, setCall({ rows: { from: 12, to: 12 } }), deps);
    expect(single.error?.detail).toContain('rows: строка 12 — за пределами');
    // Последняя строка данных — ещё данные: строки 8–9 пишутся.
    const last = await callMcp(gcApply, setCall({ rows: { from: 8, to: 9 } }), deps);
    expect(planOf(last.data).map((change) => change.a1)).toEqual([
      'Отчёт!B8',
      'Отчёт!C8',
      'Отчёт!B9',
      'Отчёт!C9',
    ]);
    expect(await valuesOf(client, 10)).toEqual([null, null, null, null, null, null]);
  });

  it('Q39: подсказки setCells не текут в правку вида — её отказы вне данных прежним текстом', async () => {
    const { deps } = harness();
    const formatSpan = (rows: Record<string, number>) =>
      callMcp(
        gcApply,
        { op: 'formatCells', target: 'daily', rows, columns: ['Время'], format: { bold: true } },
        deps,
      );
    const below = await formatSpan({ from: 9, to: 12 });
    expect(below.error?.detail).toBe(
      'rows: строки 9–12 — за пределами строк данных листа «Отчёт»: данные — строки 2–9. ' +
        'Ни одной правки не сделано.',
    );
    const header = await formatSpan({ from: 1, to: 2 });
    expect(header.error?.detail).toBe(
      'rows: строки 1–2 — за пределами строк данных листа «Отчёт»: данные — строки 2–9. ' +
        'Ни одной правки не сделано. Шапку оформляет headerOnly: true — одну, без строк данных — ' +
        'или includeHeader: true вместе со строками.',
    );
  });

  it('Q39: условие по-прежнему пишет по where; ничего не подошло — прежний вопрос «править нечего»', async () => {
    const { deps } = harness();
    const found = await callMcp(
      gcApply,
      setCall({ where: { 'Суть задачи': 'правка шаблона' } }, { values: { Время: '2:10' } }),
      deps,
    );
    expect(planOf(found.data)).toEqual([{ a1: 'Отчёт!C9', before: '2:00', after: '2:10' }]);
    const none = await callMcp(
      gcApply,
      setCall({ where: { 'Суть задачи': 'нет такой задачи' } }),
      deps,
    );
    expect(none.data).toMatchObject({ status: 'needs_clarification' });
    expect(JSON.stringify(none.data)).toContain(
      'Под условие не подошла ни одна строка — править нечего.',
    );
    // У правки вида — свой текст той же функции выбора.
    const unformatted = await callMcp(
      gcApply,
      {
        op: 'formatCells',
        target: 'daily',
        where: { 'Суть задачи': 'нет такой задачи' },
        columns: ['Время'],
        format: { bold: true },
      },
      deps,
    );
    expect(JSON.stringify(unformatted.data)).toContain(
      'Под условие не подошла ни одна строка — оформлять нечего.',
    );
  });

  it('Q39: лист из одной шапки — вопрос «нет строк данных» с той же подсказкой, а не запись', async () => {
    const header = { ...dailySheet(), rows: [row(null, ...COLUMNS)] };
    const client = new MutableSheetsClient(book(header));
    const result = await callMcp(
      gcApply,
      setCall({ rows: { from: 2, to: 2 } }),
      depsOf(client, []),
    );
    expect(result.data).toMatchObject({
      status: 'needs_clarification',
      questions: [
        {
          field: 'rows',
          reason: 'key_not_found',
          detail:
            'На листе «Отчёт» нет строк данных ниже шапки (строка 1). Строки ниже данных ' +
            'setCells не пишет: новая строка — appendRow.',
          candidates: [],
        },
      ],
    });
  });

  it('Q39: сверка «было» — в B3 вписали своё между превью и записью: stale_value, ни одной записи', async () => {
    const data = buildSheetData(book(), { sheet: TITLE, headerRow: 1 });
    const client = new FakeSheetsClient(
      book(withCell(dailySheet(), 3, 1, { value: 'чужая задача' })),
    );
    const selection = { rows: { from: 3, to: 3 } };
    const preview = await setRows(client, data, selection, TASK);
    expect(preview.status).toBe('preview');
    await expect(
      setRows(client, data, selection, TASK, { dryRun: false, confirm: preview.planId ?? '' }),
    ).rejects.toMatchObject({
      payload: { code: 'stale_value', cause: 'value_changed_after_preview' },
    });
    expect(client.writes).toHaveLength(0);
  });

  it('Q39: ядро без границы — allRows, headerOnly, пустой выбор и шапка отказаны тем же текстом', async () => {
    const data = buildSheetData(book(), { sheet: TITLE, headerRow: 1 });
    const client = new FakeSheetsClient(book());
    for (const selection of [{ allRows: true as const }, { headerOnly: true as const }]) {
      await expect(setRows(client, data, selection, TASK)).rejects.toMatchObject({
        payload: { code: 'bad_request', cause: 'row_selection' },
      });
    }
    // Выбор без способа — отказ с именем операции у обеих: правило одно, подмножества разные.
    const nothing = {} as RowSelection;
    await expect(setRows(client, data, nothing, TASK)).rejects.toMatchObject({
      payload: { cause: 'row_selection', detail: expect.stringMatching(/^setCells: не выбраны/) },
    });
    await expect(
      formatRows(client, data, nothing, ['Время'], { format: { bold: true } }),
    ).rejects.toMatchObject({
      payload: {
        cause: 'row_selection',
        detail: expect.stringMatching(/^formatCells: не выбраны/),
      },
    });
    await expect(setRows(client, data, { rows: { from: 1, to: 1 } }, TASK)).rejects.toMatchObject({
      payload: { code: 'bad_request', cause: 'rows_outside_data' },
    });
    // Ревизия, на которой агент читал лист, сверяется и у номеров строк — как у условия.
    await expect(
      setRows(client, data, { rows: { from: 3, to: 3 } }, TASK, { expectRevision: 'rev-0' }),
    ).rejects.toMatchObject({ payload: { code: 'revision_conflict' } });
    expect(client.writes).toHaveLength(0);
    expect(client.formatWrites).toHaveLength(0);
  });

  it('Q39: tools/list — rows у gc_apply описан и для setCells', async () => {
    const session = await protocolSession(harness().deps);
    try {
      const { tools } = await session.client.listTools();
      const schema = tools.find((tool) => tool.name === 'gc_apply')?.inputSchema as {
        properties: Record<string, { description?: string } | undefined>;
      };
      expect(schema.properties['rows']?.description).toContain(
        'setCells: те же номера вместо where',
      );
      expect(schema.properties['format']?.description).toContain(
        'или "none" (формат листа, «автоматический»)',
      );
    } finally {
      await session.close();
    }
  });
});

type Payload = { code: string; cause?: string; detail: string };

/** Правка вида вставленной строки с данным `format` — как её пришлёт агент. */
const formatOp = (format: unknown) => ({
  op: 'formatCells',
  target: 'daily',
  rows: { from: 3, to: 3 },
  columns: ['Суть задачи', 'Время'],
  format,
});

const parsedFormat = (format: unknown): unknown => {
  const op = parseOperation(formatOp(format));
  return op.op === 'formatCells' ? op.format : null;
};

const refusal = (format: unknown): Payload => {
  try {
    parseOperation(formatOp(format));
  } catch (error) {
    return (error as { payload: Payload }).payload;
  }
  throw new Error('ожидался отказ, а разбор прошёл');
};

describe('Q41 — граница: numberFormat "none"', () => {
  it('Q41: "none" уходит в домен null — сброс к формату листа; рядом с другими полями — тоже', () => {
    expect(parsedFormat({ numberFormat: 'none' })).toStrictEqual({ numberFormat: null });
    expect(parsedFormat({ numberFormat: 'none', bold: true })).toStrictEqual({
      numberFormat: null,
      bold: true,
    });
    // Объект — как прежде.
    expect(parsedFormat({ numberFormat: { type: 'TIME', pattern: 'h:mm' } })).toStrictEqual({
      numberFormat: { type: 'TIME', pattern: 'h:mm' },
    });
  });

  it.each(['auto', 'NONE', '', null, 0])(
    'Q41: numberFormat %j — отказ, текст называет объект и "none", null — слово отката',
    (numberFormat) => {
      const payload = refusal({ numberFormat });
      expect(payload.code).toBe('bad_request');
      expect(payload.cause).toBe('schema_violation');
      expect(payload.detail).toContain(
        'format.numberFormat: формат числа — объект {type, pattern} или "none" (формат листа, ' +
          '«автоматический»); null (сброс к виду листа) пишет только откат',
      );
    },
  );

  it('Q41: объект судит прежняя схема — тип вне списка, шаблон и опечатка в поле прежним путём и текстом', () => {
    expect(refusal({ numberFormat: { type: 'AUTO' } }).detail).toContain(
      'format.numberFormat.type: значения «AUTO» нет; допустимы: TEXT, NUMBER',
    );
    expect(refusal({ numberFormat: { type: 'TIME', pattern: '' } }).detail).toContain(
      'format.numberFormat.pattern: шаблон — до 100 знаков: dd.mm.yyyy или #,##0.00',
    );
    const typo = refusal({ numberFormat: { type: 'TIME', patern: 'h:mm' } });
    expect(typo.detail).toContain("format.numberFormat: Unrecognized key(s) in object: 'patern'");
    expect(typo.detail).toContain('Допустимые поля вида: bold, italic');
  });
});

const resetCall = (extra: Record<string, unknown> = {}) => ({
  ...formatOp({ numberFormat: 'none' }),
  ...extra,
});

describe('Q41 — сброс формата числа: план, запись, откат, чтение', () => {
  it('Q41: шов — план «DATE и TIME → формат листа», запись маской numberFormat без тела', async () => {
    const g = google();
    const journalled: WriteRecord[] = [];
    const preview = await callMcp(gcApply, resetCall(), depsOf(g.client, journalled));
    const planned = (preview.data as ApplyOutcome).changes;
    expect(
      planned.map(({ a1, beforeFormat, afterFormat }) => [a1, beforeFormat, afterFormat]),
    ).toEqual([
      ['Отчёт!B3', DAY, { numberFormat: null }],
      ['Отчёт!C3', SPENT, { numberFormat: null }],
    ]);
    expect(g.requests).toHaveLength(0);

    const written = await callMcp(
      gcApply,
      resetCall({ dryRun: false }),
      depsOf(g.client, journalled),
    );
    expect(written.data).toMatchObject({ status: 'ok' });
    expect(g.requests).toHaveLength(2);
    for (const request of g.requests) {
      expect(request.repeatCell?.fields).toBe('userEnteredFormat.numberFormat');
      expect(request.repeatCell?.cell).toStrictEqual({ userEnteredFormat: {} });
    }
    expect(journalled[0]?.changes.map((change) => change.afterFormat)).toStrictEqual([
      { numberFormat: null },
      { numberFormat: null },
    ]);
  });

  it('Q41: после сброса чтение withFormat — без numberFormat; откат возвращает DATE и TIME', async () => {
    const { client, deps, journalled } = harness();
    const formatsOfRow3 = async () => {
      const read = await callMcp(
        gcRead,
        { target: 'daily', mode: 'values', withFormat: true },
        deps,
      );
      // Окно values начинается со строки после шапки: строка 3 листа — второй элемент.
      return (read.data as { formats: { value: Record<string, CellFormat>[] } }).formats.value[1];
    };
    expect(await formatsOfRow3()).toEqual({ 'Суть задачи': DAY, Время: SPENT });

    const written = await callMcp(gcApply, resetCall({ dryRun: false }), deps);
    expect(written.data).toMatchObject({ status: 'ok' });
    expect(await formatsOfRow3()).toEqual({});

    const undone = await callMcp(gcUndo, { target: 'daily' }, deps);
    expect(undone.data).toMatchObject({ status: 'ok' });
    expect(await formatsOfRow3()).toEqual({ 'Суть задачи': DAY, Время: SPENT });
    expect(journalled.map((record) => record.op)).toEqual(['formatCells', 'undo']);
    const sheet = (await client.getSpreadsheet(ID)).sheets[0]!;
    expect(sheet.rows[2]?.map((cell) => cell.format)).toEqual([
      undefined,
      DAY,
      SPENT,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('Q41: "none" там, где формата числа нет (строка задачи), — no_change, записи нет', async () => {
    const g = google();
    const result = await callMcp(
      gcApply,
      resetCall({ rows: { from: 6, to: 6 }, dryRun: false }),
      depsOf(g.client, []),
    );
    expect(result.data).toMatchObject({ status: 'no_change' });
    expect(g.requests).toHaveLength(0);
  });
});
