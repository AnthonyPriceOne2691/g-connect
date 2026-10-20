/**
 * Вид как у строки N (D-26, Q42) — весть сессии соседнего проекта (профиль work). На листе
 * ежедневного отчёта вставленную строку задачи агент оформлял как прошлые дни шестью вызовами
 * `formatCells`: один `format` на все колонки вызова, а у строки задачи вид в каждой колонке свой —
 * шрифт, цвет, формат числа. Решение владельца — «вид как у строки N»: `likeRow: N` вместо
 * `format`.
 *
 * Лист — `fixtures/daily-report.ts`: строка 4 вставлена над днём с видом дня (DATE и TIME,
 * жирный), образец — строка задачи 7 со своим видом в каждой колонке. Инструменты — через
 * настоящий протокол (урок L26), запрос записи — в форме библиотеки Google (урок L28), запись и
 * откат — на фейке с семантикой Google (`fixtures/sheet.ts`).
 */

import { describe, expect, it } from 'vitest';

import { formatKey } from '../src/core/sheets/a1.js';
import { formatRows } from '../src/core/sheets/format-op.js';
import type { FormatSource } from '../src/core/sheets/format-source.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';
import type { Cell, CellFormat, SheetSnapshot, SheetsClient } from '../src/core/sheets/types.js';
import { gcApply, gcUndo } from '../src/mcp/tools.js';
import {
  COLUMNS,
  DAY,
  SPENT,
  TITLE,
  book,
  cellsOf,
  dailySheet,
  depsOf,
  google,
  harness,
  valuesOf,
  withCell,
  withoutGoogle,
} from './fixtures/daily-report.js';
import { FakeSheetsClient, row } from './fixtures/sheet.js';
import { callMcp, protocolSession } from './fixtures/protocol.js';

const BOLD: CellFormat = { bold: true };

/**
 * Вид строки дня по колонкам A–F — его унаследовала вставленная строка 4: жирный во всю строку,
 * дата подчёркнута, итог времени — курсивом, статус — влево.
 */
const DAY_LOOK: readonly CellFormat[] = [
  BOLD,
  { ...DAY, ...BOLD, underline: true },
  { ...SPENT, ...BOLD, italic: true },
  BOLD,
  { ...BOLD, align: 'left' },
  BOLD,
];

/** Вид строки задачи 7 по колонкам A–F — свой в каждой: шрифт, формат числа, цвет, заливка. */
const TASK_LOOK: readonly (CellFormat | undefined)[] = [
  undefined,
  { fontFamily: 'Carlito', fontSize: 10 },
  { numberFormat: { type: 'TIME', pattern: '[h]:mm' } },
  { textColor: '#1155cc', underline: true },
  { background: '#d9ead3', align: 'center' },
  { italic: true },
];

const TIME_SPAN = TASK_LOOK[2]!;

/** Лист Q42: строка 4 — с видом дня, строка 7 — с видом задачи; остальное — как в вести. */
function likeRowSheet(): SheetSnapshot {
  const looked = (cells: readonly Cell[], looks: readonly (CellFormat | undefined)[]) =>
    cells.map((cell, column) => {
      const look = looks[column];
      return look === undefined ? cell : { ...cell, format: look };
    });
  const sheet = dailySheet();
  const rows = sheet.rows.map((cells, index) => {
    if (index === 3) return looked(cells, DAY_LOOK);
    return index === 6 ? looked(cells, TASK_LOOK) : cells;
  });
  return { ...sheet, rows };
}

/** Правка вида строки 4 по образцу строки 7 — как её пришлёт агент. */
const likeCall = (extra: Record<string, unknown> = {}) => ({
  op: 'formatCells',
  target: 'daily',
  rows: { from: 4, to: 4 },
  likeRow: 7,
  ...extra,
});

const lookPlanOf = (data: unknown) =>
  (data as ApplyOutcome).changes.map(({ a1, beforeFormat, afterFormat }) => [
    a1,
    beforeFormat,
    afterFormat,
  ]);

const addressesOf = (data: unknown) => (data as ApplyOutcome).changes.map((change) => change.a1);

/** Вид строки ключом сравнения (`formatKey`): `bold: false` и «жирности нет» — один вид. */
const looksOf = async (client: SheetsClient, rowNumber: number): Promise<string[]> =>
  (await cellsOf(client, rowNumber)).map((cell) => formatKey(cell?.format));

describe('Q42 — formatCells по образцу строки: likeRow', () => {
  it('Q42: rows {4,4} likeRow 7 без columns — план по всем колонкам, (A) тоже; запись; вид 4 = вид 7; откат', async () => {
    const { client, deps, journalled } = harness(undefined, likeRowSheet());
    const preview = await callMcp(gcApply, likeCall(), deps);
    expect(preview.data).toMatchObject({ status: 'preview', notes: [] });
    // Поля образца — как есть; поле, которого у образца нет, — сброс: флаг false, иное null.
    expect(lookPlanOf(preview.data)).toEqual([
      ['Отчёт!A4', BOLD, { bold: false }],
      [
        'Отчёт!B4',
        DAY_LOOK[1],
        { numberFormat: null, bold: false, underline: false, fontFamily: 'Carlito', fontSize: 10 },
      ],
      ['Отчёт!C4', DAY_LOOK[2], { ...TIME_SPAN, bold: false, italic: false }],
      ['Отчёт!D4', BOLD, { bold: false, textColor: '#1155cc', underline: true }],
      ['Отчёт!E4', DAY_LOOK[4], { bold: false, align: 'center', background: '#d9ead3' }],
      ['Отчёт!F4', BOLD, { bold: false, italic: true }],
    ]);

    const written = await callMcp(gcApply, likeCall({ dryRun: false }), deps);
    expect(written.data).toMatchObject({ status: 'ok' });
    // По полям, которые читает G connect, строка 4 теперь как строка 7, а значения не тронуты.
    expect(await looksOf(client, 4)).toEqual(await looksOf(client, 7));
    expect(await valuesOf(client, 4)).toEqual([null, null, null, null, null, null]);
    expect(journalled.map((record) => [record.op, record.changes.length])).toEqual([
      ['formatCells', 6],
    ]);

    const undone = await callMcp(gcUndo, { target: 'daily' }, deps);
    expect(undone.data).toMatchObject({ status: 'ok' });
    expect(await looksOf(client, 4)).toEqual(DAY_LOOK.map((look) => formatKey(look)));
  });

  it('Q42: строка-образец среди целей не меняется; columns сужают правку, (A) — с допущением; незнакомая — вопрос', async () => {
    const { deps } = harness(undefined, likeRowSheet());
    const span = await callMcp(gcApply, likeCall({ rows: { from: 6, to: 7 } }), deps);
    expect(addressesOf(span.data)).toEqual([
      'Отчёт!B6',
      'Отчёт!C6',
      'Отчёт!D6',
      'Отчёт!E6',
      'Отчёт!F6',
    ]);
    const named = await callMcp(gcApply, likeCall({ columns: ['(A)', 'Время'] }), deps);
    expect(addressesOf(named.data)).toEqual(['Отчёт!A4', 'Отчёт!C4']);
    expect((named.data as ApplyOutcome).assumptions).toEqual([
      '(A) — колонка без подписи в шапке: беру A по явному ключу',
    ]);
    const unknown = await callMcp(gcApply, likeCall({ columns: ['Исполнитель'] }), deps);
    expect(unknown.data).toMatchObject({
      status: 'needs_clarification',
      questions: [{ field: 'Исполнитель', reason: 'no_match' }],
    });
  });

  it('Q42: у образца нет выравнивания, а у цели есть — сбросить нечем: остаётся своё, превью называет ячейки', async () => {
    const left = withCell(likeRowSheet(), 4, 0, { format: { ...BOLD, align: 'left' } });
    const { deps } = harness(
      undefined,
      withCell(left, 4, 2, { format: { ...DAY_LOOK[2], align: 'right' } }),
    );
    const preview = await callMcp(gcApply, likeCall({ columns: ['(A)', 'Время'] }), deps);
    expect(lookPlanOf(preview.data)).toEqual([
      ['Отчёт!A4', { ...BOLD, align: 'left' }, { bold: false, align: 'left' }],
      [
        'Отчёт!C4',
        { ...DAY_LOOK[2], align: 'right' },
        { ...TIME_SPAN, bold: false, italic: false, align: 'right' },
      ],
    ]);
    expect((preview.data as ApplyOutcome).notes).toEqual([
      'выравнивание не копируется: у строки 7 его нет, а сбросить выравнивание к виду листа ' +
        'нечем — в Отчёт!A4, Отчёт!C4 остаётся своё',
    ]);
    // Правка полями выравнивания не трогает — и заметки о нём нет.
    const fields = { likeRow: undefined, columns: ['Время'], format: { italic: false } };
    const plain = await callMcp(gcApply, likeCall(fields), deps);
    expect(plain.data).toMatchObject({ status: 'preview', notes: [] });
  });

  const WAYS = 'Нужно ровно одно: format — поля вида или likeRow: N — вид как у строки N.';
  it.each([
    {
      name: 'format вместе с likeRow',
      fields: { format: { bold: true } },
      cause: 'format_source',
      detail: `formatCells: вид задан дважды — format и likeRow. ${WAYS} Ни одной правки не сделано.`,
    },
    {
      name: 'ни format, ни likeRow',
      fields: { likeRow: undefined },
      cause: 'format_source',
      detail: `formatCells: не задан вид. ${WAYS} Ни одной правки не сделано.`,
    },
    {
      name: 'format без columns',
      fields: { likeRow: undefined, format: { bold: true } },
      cause: 'format_columns',
      detail:
        'formatCells: у format не названы колонки (columns). Все колонки сразу — только у ' +
        'likeRow: N, где вид каждой берётся из её ячейки в строке N. Ни одной правки не сделано.',
    },
  ])('Q42: $name — отказ $cause до обращения к Google и тем же текстом в ядре', async (bad) => {
    const result = await callMcp(gcApply, likeCall(bad.fields), withoutGoogle());
    expect(result.error).toMatchObject({
      code: 'bad_request',
      cause: bad.cause,
      detail: bad.detail,
    });
    // Ядро без границы судит то же само тем же текстом: прямой вызов разбор не проходит.
    const sheet = book(likeRowSheet());
    const client = new FakeSheetsClient(sheet);
    const data = buildSheetData(sheet, { sheet: TITLE, headerRow: 1 });
    const source = { likeRow: 7, ...bad.fields } as FormatSource;
    await expect(
      formatRows(client, data, { rows: { from: 4, to: 4 } }, undefined, source),
    ).rejects.toMatchObject({
      payload: { code: 'bad_request', cause: bad.cause, detail: bad.detail },
    });
    expect(client.formatWrites).toHaveLength(0);
  });

  it.each([
    {
      name: 'шапка',
      sheet: likeRowSheet(),
      likeRow: 1,
      extra: {},
      place: 'строка 1 — шапка листа «Отчёт» (данные — строки 2–9)',
    },
    {
      name: 'ниже данных',
      sheet: likeRowSheet(),
      likeRow: 12,
      extra: {},
      place: 'строка 12 — вне строк данных листа «Отчёт» (данные — строки 2–9)',
    },
    {
      name: 'над шапкой',
      sheet: likeRowSheet(),
      likeRow: 1,
      extra: { headerRow: 2 },
      place: 'строка 1 — над шапкой листа «Отчёт» (данные — строки 3–9)',
    },
    {
      name: 'лист без строк данных',
      sheet: { ...dailySheet(), rows: [row(null, ...COLUMNS)] },
      likeRow: 2,
      extra: { rows: undefined, headerOnly: true },
      place: 'строка 2 — вне строк данных листа «Отчёт» (строк данных нет)',
    },
  ])('Q42: образец — $name: отказ с границами данных, записи нет', async (bad) => {
    const { deps, journalled } = harness(undefined, bad.sheet);
    const call = likeCall({ likeRow: bad.likeRow, ...bad.extra, dryRun: false });
    const result = await callMcp(gcApply, call, deps);
    expect(result.error).toMatchObject({
      code: 'bad_request',
      cause: 'like_row_outside_data',
      detail: `likeRow: ${bad.place}: образец вида — только строка данных. Ни одной правки не сделано.`,
    });
    expect(journalled).toHaveLength(0);
  });

  it('Q42: образец — первая и последняя строки данных (2 и 9); образец без вида — сброс к виду листа', async () => {
    const { deps } = harness(undefined, likeRowSheet());
    for (const likeRow of [2, 9]) {
      const result = await callMcp(gcApply, likeCall({ likeRow, columns: ['Время'] }), deps);
      expect(lookPlanOf(result.data), `строка ${likeRow}`).toEqual([
        ['Отчёт!C4', DAY_LOOK[2], { numberFormat: null, bold: false, italic: false }],
      ]);
    }
  });

  it('Q42: без columns — тот же охранник формул: формульную колонку без force не оформляет', async () => {
    const formula = withCell(likeRowSheet(), 9, 2, { formula: '=C6+C7' });
    const result = await callMcp(gcApply, likeCall(), harness(undefined, formula).deps);
    expect(result.error).toMatchObject({ code: 'write_blocked', cause: 'formula_column' });
  });

  it('Q42: шов — один batchUpdate, repeatCell на ячейку: в теле поля образца, в маске они и сброшенные', async () => {
    const g = google(likeRowSheet());
    const written = await callMcp(gcApply, likeCall({ dryRun: false }), depsOf(g.client, []));
    expect(written.data).toMatchObject({ status: 'ok' });
    expect(g.batches).toEqual([6]);
    const b4 = g.requests[1]?.repeatCell;
    expect(b4?.range).toEqual({
      sheetId: 5,
      startRowIndex: 3,
      endRowIndex: 4,
      startColumnIndex: 1,
      endColumnIndex: 2,
    });
    expect(b4?.fields?.split(',').sort()).toEqual([
      'userEnteredFormat.numberFormat',
      'userEnteredFormat.textFormat.bold',
      'userEnteredFormat.textFormat.fontFamily',
      'userEnteredFormat.textFormat.fontSize',
      'userEnteredFormat.textFormat.underline',
    ]);
    expect(b4?.cell).toStrictEqual({
      userEnteredFormat: {
        textFormat: { bold: false, underline: false, fontFamily: 'Carlito', fontSize: 10 },
      },
    });
  });

  it('Q42: tools/list — gc_apply объявляет likeRow и называет, что не копируется', async () => {
    const session = await protocolSession(harness().deps);
    try {
      const { tools } = await session.client.listTools();
      const schema = tools.find((tool) => tool.name === 'gc_apply')?.inputSchema as {
        properties: Record<string, { description?: string } | undefined>;
      };
      const about = schema.properties['likeRow']?.description;
      expect(about).toContain('formatCells: вид как у строки N вместо format');
      expect(about).toContain(
        'Рамки, перенос, вертикальное выравнивание и условное форматирование не копируются',
      );
    } finally {
      await session.close();
    }
  });
});
