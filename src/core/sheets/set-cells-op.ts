/**
 * Точечная правка ячеек (§5) — по условию или по номерам строк (D-26, Q39). Отдельным модулем:
 * гейт длины отклонил житьё всех трёх операций в `rows.ts` разом, а делить по вопросам честнее,
 * чем по строкам — `rows.ts` остался машинерией записи (план, охранники, журнал), операции живут
 * рядом.
 */

import { clarify, finish, prepare, withAssumptions } from './rows.js';
import { selectedRows, type RowSelection } from './row-selection.js';
import type { SheetData, SheetsClient } from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions, RowValues } from './write-types.js';

/**
 * Точечно поправить ячейки во всех строках, подходящих под условие, — прежний адрес вызова.
 * Обёртка, а не копия: путь записи значений один — `setRows`.
 */
export const setCells = (
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  values: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> => setRows(client, data, { where }, values, options);

/**
 * Точечно поправить ячейки выбранных строк: условием — во всех подошедших, номерами строк листа —
 * в строках внутри данных (Q39). В ежедневном отчёте две строки, вставленные над днём, пусты во
 * всех колонках: уникального условия у них нет, а номер есть. Способ — ровно один
 * (`rowSelectionOf` с подмножеством `setCells`): «все строки» и шапка — способы правки вида, и
 * ядро отказывает в них и без границы. План, конверт (ячейки строк × колонок), сверка «было»
 * перед записью (D-17) и откат — те же, что у условия: путь записи один.
 */
export async function setRows(
  client: SheetsClient,
  data: SheetData,
  selection: RowSelection,
  values: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  const selected = selectedRows(
    data,
    selection,
    options,
    'Под условие не подошла ни одна строка — править нечего.',
    'setCells',
  );
  if ('refusal' in selected) return selected.refusal;

  const prepared = withAssumptions(prepare(data, values, options), selected);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  const changes = plannedCells(data, selected.rows, prepared);
  return finish(client, map, changes, prepared, options, 'setCells');
}

/**
 * Ячейки плана: строка × колонка, только там, где значение реально меняется.
 *
 * Вынесено из `setCells` по гейту сложности — и заодно стало видно, что фильтр «значение
 * уже такое» тут ровно один, а не размазан по циклу.
 */
function plannedCells(
  data: SheetData,
  rows: readonly number[],
  prepared: ReturnType<typeof prepare>,
): PlannedChange[] {
  const map = data.map;
  const changes: PlannedChange[] = [];
  for (const rowNumber of rows) {
    const current = data.rows[rowNumber - map.headerRow - 1] ?? {};
    for (const { column, value } of prepared.resolved) {
      const before = current[column.name] ?? null;
      if (String(before ?? '') === String(value ?? '')) continue;
      changes.push({
        kind: 'set',
        a1: `${map.sheet}!${column.letter}${rowNumber}`,
        column: column.name,
        before,
        after: value,
      });
    }
  }
  return changes;
}
