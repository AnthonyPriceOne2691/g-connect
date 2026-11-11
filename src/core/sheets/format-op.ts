/**
 * Правка вида ячеек (§6.1–6.2). Отдельным модулем: гейт длины отклонил её житьё в
 * `rows.ts` (593 строки), и по делу — «что записать» и «как оформить» это разные вопросы,
 * даже когда контур подтверждения у них общий.
 *
 * Машинерию записи (`finish`, план, охранники) операция берёт из `rows.ts` и НЕ повторяет:
 * второй путь записи разъехался бы с первым первой же правкой.
 */

import { clarify, finish, guardColumn, writeColumn, type Prepared } from './rows.js';
import { sameFormat } from './a1.js';
import {
  formatSourceOf,
  restyleOf,
  type FormatSource,
  type Restyle,
  type TargetCell,
} from './format-source.js';
import { selectedRows, type RowSelection } from './row-selection.js';
import type { CellFormat, ColumnProfile, SheetData, SheetMap, SheetsClient } from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions, RowValues } from './write-types.js';

/**
 * Правка вида по условию — прежний адрес вызова: строки выбирает `where`, как у `setCells`.
 * Обёртка, а не копия: путь правки вида один — `formatRows`.
 */
export const formatCells = (
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  columns: readonly string[],
  format: CellFormat,
  options: RowOptions = {},
): Promise<ApplyOutcome> => formatRows(client, data, { where }, columns, { format }, options);

/**
 * Правка вида существующих ячеек (§6.1–6.2: Ctrl+B, Ctrl+I, Ctrl+U, выравнивание, фон).
 *
 * Значения не трогает вовсе — на это отдельный оракул, а не обещание в комментарии.
 * Колонки — по именам; строки — ровно одним способом (Q13, Q17): условием, всем листом,
 * номерами строк или одной строкой шапки. Весь лист и пачка строк конверт не обходят: он судит
 * ячейки плана, а их — до строк × колонок, у шапки — до числа колонок (ячейка, чей вид уже
 * такой, в план не попадает). Вид — полями или строкой-образцом, ровно одно (Q42): у образца без
 * `columns` правятся все колонки листа.
 */
export async function formatRows(
  client: SheetsClient,
  data: SheetData,
  selection: RowSelection,
  columns: readonly string[] | undefined,
  source: FormatSource,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  // Источник вида судится и здесь, тем же текстом, что на границе: прямой вызов её не проходит.
  const chosen = formatSourceOf({ ...source, columns });
  const selected = selectedRows(
    data,
    selection,
    options,
    'Под условие не подошла ни одна строка — оформлять нечего.',
    'formatCells',
  );
  if ('refusal' in selected) return selected.refusal;
  const restyle = restyleOf(data, chosen);

  const prepared: Prepared = {
    resolved: [],
    // Оговорки условия — в превью тоже (Q40): ключ колонки без подписи, нечёткое имя.
    assumptions: [...(selected.assumptions ?? [])],
    notes: [],
    questions: [],
    touches: [],
  };
  const targets = resolveTargets(columns, data, prepared, options);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  const cells = targetCells(data, selected.rows, targets, options);
  const changes = formatChanges(cells, restyle);
  const named: Prepared = { ...prepared, notes: [...prepared.notes, ...restyle.notes(cells)] };
  return finish(client, map, changes, named, options, 'formatCells');
}

/**
 * Колонки правки вида: та же дорога, что у значений (§8.1, Q40) — ступени резолвера, точный ключ
 * колонки без подписи и тот же охранник формул. Без `columns` (только у образца, Q42) — все колонки
 * карты и колонки без подписи со значениями, слева направо, под тем же охранником.
 */
function resolveTargets(
  columns: readonly string[] | undefined,
  data: SheetData,
  prepared: Prepared,
  options: RowOptions,
): ColumnProfile[] {
  if (columns === undefined) {
    const all = [...data.map.columns, ...data.unlabeled].sort((a, b) => a.index - b.index);
    for (const column of all) guardColumn(column, prepared, options);
    return all;
  }
  const targets: ColumnProfile[] = [];
  for (const requested of columns) {
    const found = writeColumn(requested, data, options);
    if ('question' in found) {
      prepared.questions.push(found.question);
      continue;
    }
    if (found.assumption !== null) prepared.assumptions.push(found.assumption);
    guardColumn(found.column, prepared, options);
    targets.push(found.column);
  }
  return targets;
}

/**
 * Строки, чей вид правим: выбранные плюс, по желанию, ячейка заголовка. Шапку уже выбрал
 * `headerOnly` — `includeHeader` к ней ничего не добавляет: то же самое, а не дубль ячеек (Q17).
 */
function rowsToFormat(map: SheetMap, rows: readonly number[], options: RowOptions): number[] {
  const header = options.includeHeader === true && !rows.includes(map.headerRow);
  return header ? [map.headerRow, ...rows] : [...rows];
}

/** Текущий вид и значение ячейки: у заголовка они лежат отдельно от данных. */
function cellState(
  data: SheetData,
  rowNumber: number,
  column: ColumnProfile,
): { before: CellFormat | undefined; value: PlannedChange['before'] } {
  const map = data.map;
  const isHeader = rowNumber === map.headerRow;
  const index = rowNumber - map.headerRow - 1;
  const formats = isHeader ? data.headerFormats : (data.formats[index] ?? {});
  const values = isHeader ? {} : (data.rows[index] ?? {});
  // У ячейки заголовка значение — само имя колонки. Раньше в плане она читалась как
  // «null → null», хотя в ней лежит текст: нашла живая проверка 2026-09-03. У колонки без
  // подписи шапка пуста (Q40): ключ «(C)» — имя для записи, а не текст ячейки.
  const header = data.unlabeled.includes(column) ? null : column.name;
  const value = isHeader ? header : (values[column.name] ?? null);
  return { before: formats[column.name], value };
}

/** Ячейка правки вида со значением: в плане оно справочно — правка вида его не трогает. */
interface FormatCell extends TargetCell {
  readonly value: PlannedChange['before'];
}

/** Ячейки правки: выбранные строки (и, по желанию, шапка) × колонки цели, строка за строкой. */
function targetCells(
  data: SheetData,
  rows: readonly number[],
  targets: readonly ColumnProfile[],
  options: RowOptions,
): FormatCell[] {
  const map = data.map;
  return rowsToFormat(map, rows, options).flatMap((rowNumber) =>
    targets.map((column) => ({
      a1: `${map.sheet}!${column.letter}${rowNumber}`,
      column,
      ...cellState(data, rowNumber, column),
    })),
  );
}

/**
 * План правки вида: вид каждой ячейки после — от источника (`restyleOf`: поля накладываются на
 * текущий вид, образец — вид ячейки строки N). Ячейки, где итог совпал с текущим видом, в план не
 * попадают: `no_change` вместо пустой записи.
 */
function formatChanges(cells: readonly FormatCell[], restyle: Restyle): PlannedChange[] {
  const changes: PlannedChange[] = [];
  for (const cell of cells) {
    const after = restyle.after(cell);
    if (sameFormat(cell.before, after)) continue;
    changes.push({
      kind: 'format',
      a1: cell.a1,
      column: cell.column.name,
      // Значение не меняется — в плане оно одно и то же по обе стороны, и это видно.
      before: cell.value,
      after: cell.value,
      ...(cell.before === undefined ? {} : { beforeFormat: cell.before }),
      afterFormat: after,
    });
  }
  return changes;
}
