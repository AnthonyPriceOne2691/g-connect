/**
 * Точечная правка ячеек по условию (§5). Отдельным модулем: гейт длины отклонил житьё
 * всех трёх операций в `rows.ts` разом, а делить по вопросам честнее, чем по строкам —
 * `rows.ts` остался машинерией записи (план, охранники, журнал), операции живут рядом.
 */

import { clarify, finish, prepare, rowsUnderCondition } from './rows.js';
import type { SheetData, SheetsClient } from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions, RowValues } from './write-types.js';

/** Точечно поправить ячейки во всех строках, подходящих под условие. */

export async function setCells(
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  values: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  const selected = rowsUnderCondition(
    data,
    where,
    options,
    'Под условие не подошла ни одна строка — править нечего.',
  );
  if ('refusal' in selected) return selected.refusal;

  const prepared = prepare(map, values, options);
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
