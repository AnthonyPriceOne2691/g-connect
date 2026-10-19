/**
 * Правка вида ячеек (§6.1–6.2). Отдельным модулем: гейт длины отклонил её житьё в
 * `rows.ts` (593 строки), и по делу — «что записать» и «как оформить» это разные вопросы,
 * даже когда контур подтверждения у них общий.
 *
 * Машинерию записи (`finish`, план, охранники) операция берёт из `rows.ts` и НЕ повторяет:
 * второй путь записи разъехался бы с первым первой же правкой.
 */

import { clarify, columnQuestion, finish, guardColumn, type Prepared } from './rows.js';
import { sameFormat } from './a1.js';
import { needsClarification, resolveColumn } from '../resolver.js';
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
): Promise<ApplyOutcome> => formatRows(client, data, { where }, columns, format, options);

/**
 * Правка вида существующих ячеек (§6.1–6.2: Ctrl+B, Ctrl+I, Ctrl+U, выравнивание, фон).
 *
 * Значения не трогает вовсе — на это отдельный оракул, а не обещание в комментарии.
 * Колонки — по именам; строки — ровно одним способом (Q13, Q17): условием, всем листом,
 * номерами строк или одной строкой шапки. Весь лист и пачка строк конверт не обходят: он судит
 * ячейки плана, а их — до строк × колонок, у шапки — до числа колонок (ячейка, чей вид уже
 * такой, в план не попадает).
 */
export async function formatRows(
  client: SheetsClient,
  data: SheetData,
  selection: RowSelection,
  columns: readonly string[],
  format: CellFormat,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  const selected = selectedRows(
    data,
    selection,
    options,
    'Под условие не подошла ни одна строка — оформлять нечего.',
  );
  if ('refusal' in selected) return selected.refusal;

  const prepared: Prepared = {
    resolved: [],
    assumptions: [],
    notes: [],
    questions: [],
    touches: [],
  };
  const targets = resolveTargets(columns, map, prepared, options);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  const changes = formatChanges(data, selected.rows, targets, format, options);
  return finish(client, map, changes, prepared, options, 'formatCells');
}

/** Колонки правки вида: те же ступени резолвера и тот же охранник формул (§8.1). */
function resolveTargets(
  columns: readonly string[],
  map: SheetMap,
  prepared: Prepared,
  options: RowOptions,
): ColumnProfile[] {
  const targets: ColumnProfile[] = [];
  for (const requested of columns) {
    const resolution = resolveColumn(requested, map.columns, options);
    if (needsClarification(resolution.step) || resolution.column === null) {
      prepared.questions.push(columnQuestion(requested, resolution, map));
      continue;
    }
    if (resolution.assumption !== null) prepared.assumptions.push(resolution.assumption);
    guardColumn(resolution.column, prepared, options);
    targets.push(resolution.column);
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
  // «null → null», хотя в ней лежит текст: нашла живая проверка 2026-09-03.
  const value = isHeader ? column.name : (values[column.name] ?? null);
  return { before: formats[column.name], value };
}

/**
 * План правки вида. Правка ЧАСТИЧНАЯ: заданные поля накладываются на текущий вид, а не
 * заменяют его — иначе «сделай курсивом» снимало бы жирность (пример V5). Ячейки, где
 * итог совпал с текущим видом, в план не попадают: `no_change` вместо пустой записи.
 */
function formatChanges(
  data: SheetData,
  rows: readonly number[],
  targets: readonly ColumnProfile[],
  format: CellFormat,
  options: RowOptions,
): PlannedChange[] {
  const map = data.map;
  const changes: PlannedChange[] = [];
  for (const rowNumber of rowsToFormat(map, rows, options)) {
    for (const column of targets) {
      const { before, value } = cellState(data, rowNumber, column);
      const after = { ...before, ...format };
      if (sameFormat(before, after)) continue;
      changes.push({
        kind: 'format',
        a1: `${map.sheet}!${column.letter}${rowNumber}`,
        column: column.name,
        // Значение не меняется — в плане оно одно и то же по обе стороны, и это видно.
        before: value,
        after: value,
        ...(before === undefined ? {} : { beforeFormat: before }),
        afterFormat: after,
      });
    }
  }
  return changes;
}
