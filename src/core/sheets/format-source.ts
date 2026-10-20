/**
 * Откуда вид правки (D-26, Q42): поля вида (`format`) или строка-образец (`likeRow: N`) — ровно
 * одно.
 *
 * Весть сессии соседнего проекта (профиль work): вставленную строку задачи ежедневного отчёта агент
 * оформлял как прошлые дни шестью вызовами `formatCells` — один `format` на все колонки вызова, а у
 * строки задачи вид в каждой колонке свой: шрифт, цвет, формат числа. Решение владельца — «вид как
 * у строки N»: у каждой колонки цели вид её ячейки в строке N.
 *
 * Отдельным модулем от `format-op.ts`, как выбор строк (`row-selection.ts`): правило «ровно одно»
 * судится дважды — на границе (`parseOperation`, до Google, урок L11) и в ядре, где известны
 * границы данных, — и обязано быть одним текстом. Запись — прежний путь `formatRows`: план ячейка
 * за ячейкой, `repeatCell` с маской полей, откат вида по записанным полям.
 */

import { gcError } from '../errors.js';
import { dataBounds, spanText } from './row-selection.js';
import type { CellFormat, ColumnProfile, SheetData } from './types.js';

/** Вид — полями или образцом строки, ровно одно; держит это тип, а не договорённость. */
export type FormatSource = { readonly format: CellFormat } | { readonly likeRow: number };

/** Поля операции, из которых берётся вид, — с внешней границы: любое может отсутствовать. */
export interface FormatSourceFields {
  readonly format?: CellFormat | undefined;
  readonly likeRow?: number | undefined;
  readonly columns?: readonly string[] | undefined;
}

/**
 * Поля операции → откуда вид, или отказ `bad_request`. Оба сразу — отказ: что главнее, ядро не
 * угадывает; ни одного — тоже. Поля вида без `columns` — отказ (`format_columns`): все колонки
 * сразу берёт только образец, у которого в каждой колонке вид своей ячейки, — один вид на весь
 * лист был бы ровно тем, от чего защищает выбор строк.
 */
export function formatSourceOf(fields: FormatSourceFields): FormatSource {
  const { format, likeRow } = fields;
  if (format === undefined && likeRow !== undefined) return { likeRow };
  if (format !== undefined && likeRow === undefined) {
    if (fields.columns !== undefined) return { format };
    throw gcError('bad_request', {
      detail:
        'formatCells: у format не названы колонки (columns). Все колонки сразу — только у ' +
        'likeRow: N, где вид каждой берётся из её ячейки в строке N. Ни одной правки не сделано.',
      cause: 'format_columns',
    });
  }
  const fault = format === undefined ? 'не задан вид' : 'вид задан дважды — format и likeRow';
  throw gcError('bad_request', {
    detail:
      `formatCells: ${fault}. Нужно ровно одно: format — поля вида или likeRow: N — вид как у ` +
      'строки N. Ни одной правки не сделано.',
    cause: 'format_source',
  });
}

/** Ячейка правки вида: адрес, колонка и явный вид до правки. */
export interface TargetCell {
  readonly a1: string;
  readonly column: ColumnProfile;
  readonly before: CellFormat | undefined;
}

/** Как правка меняет вид: вид ячейки после — и заметки превью о том, что осталось своим. */
export interface Restyle {
  readonly after: (cell: TargetCell) => CellFormat;
  readonly notes: (cells: readonly TargetCell[]) => string[];
}

/**
 * Источник вида → как он меняет ячейку. Полями — ЧАСТИЧНО: заданные поля накладываются на текущий
 * вид, а не заменяют его, иначе «сделай курсивом» снимало бы жирность (пример V5). Образцом — вид
 * ячейки строки N той же колонки (`likeSample`); строка N судится здесь, до плана.
 */
export function restyleOf(data: SheetData, source: FormatSource): Restyle {
  if ('format' in source) {
    const { format } = source;
    return { after: (cell) => ({ ...cell.before, ...format }), notes: () => [] };
  }
  const { likeRow } = source;
  const sample = sampleOf(data, likeRow);
  return {
    after: (cell) => likeSample(cell.before, sample(cell.column)),
    notes: (cells) =>
      alignNotes(
        cells.filter((cell) => alignKept(cell.before, sample(cell.column))),
        likeRow,
      ),
  };
}

/**
 * Вид строки-образца по колонкам — или отказ: образец — строка данных листа, не шапка, не строка
 * над ней и не строка ниже данных. Граница данных — та же, что у выбора строк (`dataBounds`, урок
 * L16): пустая строка внутри данных — тоже строка данных, и её вид — законный образец.
 */
function sampleOf(
  data: SheetData,
  likeRow: number,
): (column: ColumnProfile) => CellFormat | undefined {
  const bounds = dataBounds(data);
  if (bounds !== null && likeRow >= bounds.first && likeRow <= bounds.last) {
    const formats = data.formats[likeRow - bounds.first] ?? {};
    return (column) => formats[column.name];
  }
  const { headerRow, sheet } = data.map;
  const place =
    likeRow > headerRow ? 'вне строк данных' : likeRow === headerRow ? 'шапка' : 'над шапкой';
  const rows =
    bounds === null ? 'строк данных нет' : `данные — ${spanText(bounds.first, bounds.last)}`;
  throw gcError('bad_request', {
    detail:
      `likeRow: строка ${likeRow} — ${place} листа «${sheet}» (${rows}): образец вида — только ` +
      'строка данных. Ни одной правки не сделано.',
    cause: 'like_row_outside_data',
  });
}

/**
 * Вид ячейки цели по образцу: поля образца — как есть; поле, которого у образца нет, — сброс к виду
 * листа: `false` у жирности, курсива и подчёркивания, `null` у фона, цвета текста, шрифта, кегля и
 * формата числа (шов пишет его маской без значения). Так цель совпадает с образцом по полям,
 * которые читает G connect, — кроме выравнивания: сброса у него в домене нет (откат ставит `left`,
 * то есть выдумывает вид), и оно остаётся своим; превью это называет (`alignNotes`).
 */
function likeSample(before: CellFormat | undefined, sample: CellFormat | undefined): CellFormat {
  const reset: CellFormat = {
    bold: false,
    italic: false,
    underline: false,
    background: null,
    textColor: null,
    fontFamily: null,
    fontSize: null,
    numberFormat: null,
  };
  // Сброс — только полям, что у цели есть; поля образца ложатся последними и его перекрывают.
  const cleared = Object.entries(reset).filter(
    ([key]) => before?.[key as keyof CellFormat] !== undefined,
  );
  return { ...before, ...Object.fromEntries(cleared), ...sample };
}

/** У образца выравнивания нет, а у цели есть: сбросить его нечем — остаётся своё. */
const alignKept = (before: CellFormat | undefined, sample: CellFormat | undefined): boolean =>
  before?.align !== undefined && sample?.align === undefined;

/** Заметка превью — где вид не совпадёт с образцом: выравнивание осталось своим. */
function alignNotes(cells: readonly TargetCell[], likeRow: number): string[] {
  if (cells.length === 0) return [];
  const where = cells.map((cell) => cell.a1).join(', ');
  return [
    `выравнивание не копируется: у строки ${likeRow} его нет, а сбросить выравнивание к виду ` +
      `листа нечем — в ${where} остаётся своё`,
  ];
}
