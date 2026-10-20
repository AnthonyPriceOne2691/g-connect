/**
 * Какие строки правит вид и пишет `setCells` (D-26, Q13, Q17, Q39): ровно один способ — условие,
 * весь лист, номера строк или одна строка шапки; у записи значений — условие или номера строк.
 *
 * Владелец выравнивал шрифт и даты «Реестра инфраструктуры» на семи вкладках, а `formatCells`
 * выбирал строки только условием `where` — выровнять лист целиком было нечем. Потом в
 * «Аккаунтах» у заголовков B2–D2 не оказалось фона шапки, а `includeHeader` красил шапку вместе
 * с данными — оформить одну шапку было нечем (Q17). Отдельным модулем от `format-op.ts`, потому
 * что выбор судится дважды: на границе, ДО обращения к Google (`parseOperation`, урок L11:
 * дорогой отказ — тоже дефект), и в ядре — по прочитанному листу, где известны границы данных.
 * Правило «ровно один способ» обязано быть одним текстом в обоих местах, а не двумя копиями.
 *
 * Ежедневный отчёт (Q39): агент вставил две строки над днём и не смог их заполнить — `setCells`
 * выбирал строки только условием, а у пустой вставленной строки уникального условия нет. Номера
 * строк у записи значений — тот же `rows`, те же границы данных и то же правило, с подмножеством
 * способов (`waysOf`): «все строки» и шапка — способы правки вида, а не записи значений.
 */

import { z } from 'zod';

import { gcError } from '../errors.js';
import { assertRevision, clarify, names, rowsUnderCondition, type RowsFound } from './rows.js';
import type { SheetData, SheetMap } from './types.js';
import type { ApplyOutcome, Question, RowOptions, RowValues } from './write-types.js';

/** Номера строк листа: 1-based и включительно — как их видит человек в Google. */
export interface RowSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * `rows` на внешней границе — одна схема на разбор ядра и транспорт `gc_apply`: две копии
 * одной формы разъехались бы молча (урок L21).
 */
export const rowSpanSchema = z
  .object({ from: z.number().int().positive(), to: z.number().int().positive() })
  .strict();

/**
 * Способ выбрать строки — ровно один, и держит это тип, а не договорённость. `headerOnly` — одна
 * строка шапки (`map.headerRow`); строка над ней (название таблицы) не адресуется ни одним.
 */
export type RowSelection =
  | { readonly where: RowValues }
  | { readonly allRows: true }
  | { readonly rows: RowSpan }
  | { readonly headerOnly: true };

/** Поля выбора, как их несёт операция с внешней границы: любое может отсутствовать. */
export interface RowSelectionFields {
  readonly where?: RowValues | undefined;
  readonly allRows?: boolean | undefined;
  readonly rows?: RowSpan | undefined;
  readonly headerOnly?: boolean | undefined;
}

/** Способ выбора строк — имя поля операции. */
type RowWay = 'where' | 'allRows' | 'rows' | 'headerOnly';

/** Операции, которые выбирают строки этим модулем: у каждой своё подмножество способов (Q39). */
export type RowSelectionOp = 'formatCells' | 'setCells';

/**
 * Способы операции. Запись значений не знает «всех строк» и шапки (Q39): одно значение во все
 * строки листа — не точечная правка, а шапка — подписи колонок, а не данные. Списки — внутри
 * функции, а не на уровне модуля: мутант кода уровня модуля Stryker судит всем набором тестов
 * (урок бюджета D-26).
 */
function waysOf(op: RowSelectionOp): readonly RowWay[] {
  return op === 'setCells' ? ['where', 'rows'] : ['where', 'allRows', 'rows', 'headerOnly'];
}

/** Способы словами — один текст на обе операции, у каждой её подмножество. */
function waysText(ways: readonly RowWay[]): string {
  const about: Readonly<Record<RowWay, string>> = {
    where: 'where — условие на строки',
    allRows: 'allRows: true — все строки данных листа',
    rows: 'rows: {from, to} — номера строк листа (включительно)',
    headerOnly: 'headerOnly: true — только строка шапки',
  };
  return ways.map((way) => about[way]).join(', ');
}

/**
 * Поля операции → способ выбора строк или отказ `bad_request`. Ни одного способа — отказ, а не
 * «все строки»: молчаливое «весь лист» — ровно то, от чего выбор и защищает; два сразу — отказ,
 * потому что угадывать, какой из них имелся в виду, ядро не берётся. Способ, которого у операции
 * нет (`allRows` у `setCells`, Q39), — тот же отказ с её способами, а не «незнакомое поле».
 */
export function rowSelectionOf(fields: RowSelectionFields, op: RowSelectionOp): RowSelection {
  const chosen = chosenWays(fields);
  const ways = waysOf(op);
  const foreign = chosen.map(wayOf).filter((way) => !ways.includes(way));
  const [only] = chosen;
  if (only === undefined || chosen.length > 1 || foreign.length > 0) {
    throw gcError('bad_request', {
      detail:
        `${op}: ${selectionFault(chosen, foreign)}. Нужен ровно один: ${waysText(ways)}. ` +
        'Ни одной правки не сделано.',
      cause: 'row_selection',
    });
  }
  assertUsable(only, op);
  return only;
}

/** Способы, названные в полях: `false` у флага — не способ, а его отсутствие. */
function chosenWays(fields: RowSelectionFields): RowSelection[] {
  return [
    ...(fields.where === undefined ? [] : [{ where: fields.where }]),
    ...(fields.allRows === true ? [{ allRows: true as const }] : []),
    ...(fields.rows === undefined ? [] : [{ rows: fields.rows }]),
    ...(fields.headerOnly === true ? [{ headerOnly: true as const }] : []),
  ];
}

/** Что не так с выбором: чужой способ, ни одного или несколько сразу. */
function selectionFault(chosen: readonly RowSelection[], foreign: readonly RowWay[]): string {
  if (foreign.length > 0) {
    const named = foreign.join(' и ');
    return `здесь нет ${named} — так строки выбирает только правка вида (formatCells)`;
  }
  if (chosen.length === 0) return 'не выбраны строки';
  return `строки выбраны сразу несколькими способами (${chosen.map(wayOf).join(', ')})`;
}

const wayOf = (selection: RowSelection): RowWay => Object.keys(selection)[0] as RowWay;

/**
 * Выбор, который нельзя исполнить, — отказ на любом пути: и с границы, и из прямого вызова ядра.
 *
 * Пустое `where` раньше молча выбирало ВСЕ строки (пустой `every` истинен) — теперь «все строки»
 * говорят только явным `allRows: true`. Там, где такого способа нет (`setCells`), пустое условие
 * берёт все строки, как прежде (K3): две семантики пустого условия названы в decisions.md.
 */
function assertUsable(selection: RowSelection, op: RowSelectionOp): void {
  const empty = 'where' in selection && Object.keys(selection.where).length === 0;
  if (empty && waysOf(op).includes('allRows')) {
    throw gcError('bad_request', {
      detail:
        'Пустое условие where выбрало бы все строки молча. Нужны все строки данных — скажи это ' +
        'явно: allRows: true. Ни одной правки не сделано.',
      cause: 'empty_condition',
    });
  }
  if ('rows' in selection && selection.rows.from > selection.rows.to) {
    const { from, to } = selection.rows;
    throw gcError('bad_request', {
      detail:
        `rows: from ${from} больше to ${to} — в таком диапазоне нет ни одной строки. Номера — ` +
        `строки листа включительно: {from: ${to}, to: ${from}}. Ни одной правки не сделано.`,
      cause: 'rows_reversed',
    });
  }
}

/** Строки данных листа: от строки после шапки до последней строки с данными. */
interface DataBounds {
  readonly first: number;
  readonly last: number;
}

/**
 * Граница данных, а не счётчик непустых (урок L16): `data.rows` идут без пустого хвоста, но с
 * пустыми строками внутри, и лист прочитан целиком (D-26). Строк данных нет — `null`.
 */
function dataBounds(data: SheetData): DataBounds | null {
  if (data.rows.length === 0) return null;
  const first = data.map.headerRow + 1;
  return { first, last: data.map.headerRow + data.rows.length };
}

const spanText = (first: number, last: number): string =>
  first === last ? `строка ${first}` : `строки ${first}–${last}`;

/**
 * Куда вести агента, когда номера мимо строк данных (Q17, Q39): шапку оформляет `headerOnly`, а
 * пишет — никто; строки ниже данных `setCells` не пишет — новую дописывает `appendRow`. Правка вида
 * ниже данных не нужна вовсе, и подсказки там нет.
 */
function adviceOf(op: RowSelectionOp): { readonly header: string; readonly below: string } {
  if (op === 'setCells') {
    return {
      header: ' Шапка — подписи колонок, а не данные: setCells её не пишет.',
      below: ' Строки ниже данных setCells не пишет: новая строка — appendRow.',
    };
  }
  return {
    header:
      ' Шапку оформляет headerOnly: true — одну, без строк данных — или includeHeader: true ' +
      'вместе со строками.',
    below: '',
  };
}

/**
 * Номера вне строк данных — отказ с границами данных: агент видит карту по первым 500 строкам
 * (D-26) и номер последней строки может не знать — ответ называет её сам. Задета шапка — ответ
 * называет, чем её оформить (Q17): строки над ней не адресует ни один способ; строки ниже данных
 * у записи значений — `appendRow` (Q39).
 */
function assertWithinData(
  span: RowSpan,
  bounds: DataBounds,
  map: SheetMap,
  op: RowSelectionOp,
): void {
  if (span.from >= bounds.first && span.to <= bounds.last) return;
  const advice = adviceOf(op);
  throw gcError('bad_request', {
    detail:
      `rows: ${spanText(span.from, span.to)} — за пределами строк данных листа «${map.sheet}»: ` +
      `данные — ${spanText(bounds.first, bounds.last)}. Ни одной правки не сделано.` +
      (span.from <= map.headerRow ? advice.header : '') +
      (span.to > bounds.last ? advice.below : ''),
    cause: 'rows_outside_data',
  });
}

/** Строк данных нет — вопрос с подсказкой операции, а не `no_change`. */
function noDataQuestion(selection: RowSelection, map: SheetMap, op: RowSelectionOp): Question {
  return {
    field: wayOf(selection),
    reason: 'key_not_found',
    detail:
      `На листе «${map.sheet}» нет строк данных ниже шапки (строка ${map.headerRow}).` +
      adviceOf(op).below,
    candidates: [],
    available: names(map),
  };
}

const numbers = (first: number, last: number): number[] =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);

/**
 * Номера выбранных строк листа или готовый отказ. Выбор судится заново и здесь — тем же
 * `rowSelectionOf` с подмножеством операции: прямой вызов ядра границу не проходит. Условие идёт
 * прежним путём (`setCells` и правка вида отвечают на «какие строки трогаем» одной функцией); весь
 * лист и номера строк — по границе данных. Пустой лист — вопрос, а не `no_change`: «вид уже такой»
 * там было бы ложью. Шапке строки данных не нужны: лист из одной шапки оформляется (Q17).
 */
export function selectedRows(
  data: SheetData,
  selection: RowSelection,
  options: RowOptions,
  nothingMatched: string,
  op: RowSelectionOp,
): RowsFound | { refusal: ApplyOutcome } {
  const chosen = rowSelectionOf(selection, op);
  if ('where' in chosen) {
    return rowsUnderCondition(data, chosen.where, options, nothingMatched);
  }
  const map = data.map;
  assertRevision(map, options);
  if ('headerOnly' in chosen) return { rows: [map.headerRow] };
  const bounds = dataBounds(data);
  if (bounds === null) return { refusal: clarify([noDataQuestion(chosen, map, op)], map) };
  if ('allRows' in chosen) return { rows: numbers(bounds.first, bounds.last) };
  assertWithinData(chosen.rows, bounds, map, op);
  return { rows: numbers(chosen.rows.from, chosen.rows.to) };
}
