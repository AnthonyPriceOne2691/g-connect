/**
 * Какие строки правит вид (D-26, Q13, Q17): ровно один способ — условие, весь лист, номера строк
 * или одна строка шапки.
 *
 * Владелец выравнивал шрифт и даты «Реестра инфраструктуры» на семи вкладках, а `formatCells`
 * выбирал строки только условием `where` — выровнять лист целиком было нечем. Потом в
 * «Аккаунтах» у заголовков B2–D2 не оказалось фона шапки, а `includeHeader` красил шапку вместе
 * с данными — оформить одну шапку было нечем (Q17). Отдельным модулем от `format-op.ts`, потому
 * что выбор судится дважды: на границе, ДО обращения к Google (`parseOperation`, урок L11:
 * дорогой отказ — тоже дефект), и в ядре — по прочитанному листу, где известны границы данных.
 * Правило «ровно один способ» обязано быть одним текстом в обоих местах, а не двумя копиями.
 */

import { z } from 'zod';

import { gcError } from '../errors.js';
import { assertRevision, clarify, names, rowsUnderCondition } from './rows.js';
import type { SheetData, SheetMap } from './types.js';
import type { ApplyOutcome, RowOptions, RowValues } from './write-types.js';

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

const WAYS =
  'where — условие на строки, allRows: true — все строки данных листа, rows: {from, to} — ' +
  'номера строк листа (включительно), headerOnly: true — только строка шапки';

/**
 * Поля операции → способ выбора строк или отказ `bad_request`. Ни одного способа — отказ, а не
 * «все строки»: молчаливое «весь лист» — ровно то, от чего выбор и защищает; два сразу — отказ,
 * потому что угадывать, какой из них имелся в виду, ядро не берётся.
 */
export function rowSelectionOf(fields: RowSelectionFields): RowSelection {
  const chosen: RowSelection[] = [
    ...(fields.where === undefined ? [] : [{ where: fields.where }]),
    ...(fields.allRows === true ? [{ allRows: true as const }] : []),
    ...(fields.rows === undefined ? [] : [{ rows: fields.rows }]),
    ...(fields.headerOnly === true ? [{ headerOnly: true as const }] : []),
  ];
  const [only] = chosen;
  if (only === undefined || chosen.length > 1) {
    const what =
      only === undefined
        ? 'не выбраны строки'
        : `строки выбраны сразу несколькими способами (${chosen.map(wayOf).join(', ')})`;
    throw gcError('bad_request', {
      detail: `formatCells: ${what}. Нужен ровно один: ${WAYS}. Ни одной правки не сделано.`,
      cause: 'row_selection',
    });
  }
  assertUsable(only);
  return only;
}

const wayOf = (selection: RowSelection): string => Object.keys(selection)[0] ?? '';

/**
 * Выбор, который нельзя исполнить, — отказ на любом пути: и с границы, и из прямого вызова ядра.
 *
 * Пустое `where` раньше молча выбирало ВСЕ строки (пустой `every` истинен) — теперь «все строки»
 * говорят только явным `allRows: true`.
 */
function assertUsable(selection: RowSelection): void {
  if ('where' in selection && Object.keys(selection.where).length === 0) {
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
 * Номера вне строк данных — отказ с границами данных: агент видит карту по первым 500 строкам
 * (D-26) и номер последней строки может не знать — ответ называет её сам. Задета шапка — ответ
 * называет, чем её оформить (Q17): строки над ней не адресует ни один способ.
 */
function assertWithinData(span: RowSpan, bounds: DataBounds, map: SheetMap): void {
  if (span.from >= bounds.first && span.to <= bounds.last) return;
  throw gcError('bad_request', {
    detail:
      `rows: ${spanText(span.from, span.to)} — за пределами строк данных листа «${map.sheet}»: ` +
      `данные — ${spanText(bounds.first, bounds.last)}. Ни одной правки не сделано.` +
      (span.from <= map.headerRow
        ? ' Шапку оформляет headerOnly: true — одну, без строк данных — или includeHeader: true ' +
          'вместе со строками.'
        : ''),
    cause: 'rows_outside_data',
  });
}

const numbers = (first: number, last: number): number[] =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);

/**
 * Номера выбранных строк листа или готовый отказ. Условие идёт прежним путём (`setCells` и
 * правка вида отвечают на «какие строки трогаем» одной функцией); весь лист и номера строк —
 * по границе данных. Пустой лист — вопрос, а не `no_change`: «вид уже такой» там было бы ложью.
 * Шапке строки данных не нужны: лист из одной шапки оформляется (Q17).
 */
export function selectedRows(
  data: SheetData,
  selection: RowSelection,
  options: RowOptions,
  nothingMatched: string,
): { rows: readonly number[] } | { refusal: ApplyOutcome } {
  assertUsable(selection);
  if ('where' in selection) {
    return rowsUnderCondition(data, selection.where, options, nothingMatched);
  }
  const map = data.map;
  assertRevision(map, options);
  if ('headerOnly' in selection) return { rows: [map.headerRow] };
  const bounds = dataBounds(data);
  if (bounds === null) {
    const question = {
      field: wayOf(selection),
      reason: 'key_not_found' as const,
      detail: `На листе «${map.sheet}» нет строк данных ниже шапки (строка ${map.headerRow}).`,
      candidates: [],
      available: names(map),
    };
    return { refusal: clarify([question], map) };
  }
  if ('allRows' in selection) return { rows: numbers(bounds.first, bounds.last) };
  assertWithinData(selection.rows, bounds, map);
  return { rows: numbers(selection.rows.from, selection.rows.to) };
}
