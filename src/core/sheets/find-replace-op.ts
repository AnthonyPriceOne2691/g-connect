/**
 * Поиск и замена (§6.1, Ctrl+F / Ctrl+H).
 *
 * Замена идёт ЯЧЕЙКАМИ через тот же план, что обычная запись, а не одним запросом
 * `findReplace` в Google. Решение осознанное: атомарность одного запроса стоила бы честного
 * превью — Google вернул бы «заменено 7», а человеку нужно видеть, ГДЕ и что именно
 * поменяется, иначе подтверждать нечего. Цена названа в спеке.
 */

import type { ColumnProfile, SheetData, SheetsClient } from './types.js';
import { clarify, finish, rowsUnderCondition, type Prepared } from './rows.js';
import type { ApplyOutcome, PlannedChange, RowOptions } from './write-types.js';

export interface FindReplaceInput {
  readonly find: string;
  readonly replace: string;
  /** Ограничить область колонками; без них — все колонки листа. */
  readonly columns?: readonly string[];
  readonly matchCase: boolean;
  readonly matchEntireCell: boolean;
  readonly searchByRegex: boolean;
}

/** Совпадение и замена в одном значении. `null` — совпадения нет, ячейка не тронута. */
function replaceIn(value: string, input: FindReplaceInput): string | null {
  if (input.matchEntireCell) {
    const same = input.matchCase
      ? value === input.find
      : value.toLowerCase() === input.find.toLowerCase();
    return same ? input.replace : null;
  }
  if (input.searchByRegex) {
    const re = new RegExp(input.find, input.matchCase ? 'g' : 'gi');
    const next = value.replace(re, input.replace);
    return next === value ? null : next;
  }
  const flags = input.matchCase ? 'g' : 'gi';
  const escaped = input.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = value.replace(new RegExp(escaped, flags), input.replace);
  return next === value ? null : next;
}

/**
 * Колонки под замену. Формульные пропускаются с оговоркой, а не роняют весь вызов: замена
 * по листу с одной формульной колонкой — обычное дело, и падать на ней значило бы сделать
 * операцию бесполезной. Написать в формулу всё ещё можно, но осознанно — через `setCells`.
 */
function targetColumns(
  data: SheetData,
  input: FindReplaceInput,
  prepared: Prepared,
  options: RowOptions,
): ColumnProfile[] {
  const wanted =
    input.columns === undefined
      ? data.map.columns
      : data.map.columns.filter((c) => input.columns?.includes(c.name) === true);
  const out: ColumnProfile[] = [];
  for (const column of wanted) {
    if ((column.hasFormula || column.protected) && options.force !== true) {
      prepared.notes.push(
        `колонка «${column.name}» ${column.hasFormula ? 'формульная' : 'защищённая'} — ` +
          'пропущена; чтобы писать в неё, нужен force и осознанное решение',
      );
      continue;
    }
    out.push(column);
  }
  return out;
}

export async function findReplace(
  client: SheetsClient,
  data: SheetData,
  input: FindReplaceInput,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  // Область строк — весь лист: у замены нет условия отбора, но проверка ревизии и отказ
  // «пустой лист» те же, что у остальных операций.
  const selected = rowsUnderCondition(data, {}, options, 'На листе нет строк — заменять нечего.');
  if ('refusal' in selected) return selected.refusal;

  const prepared: Prepared = {
    resolved: [],
    assumptions: [],
    notes: [],
    questions: [],
    touches: [],
  };
  const columns = targetColumns(data, input, prepared, options);
  if (columns.length === 0) {
    return clarify(
      [
        {
          field: 'columns',
          reason: 'no_match',
          detail: 'Ни одной колонки под замену не осталось: все пропущены или не найдены.',
          candidates: [],
          available: map.columns.map((c) => c.name),
        },
      ],
      map,
    );
  }

  const changes = replaceChanges(data, columns, input);
  return finish(client, map, changes, prepared, options, 'findReplace');
}

/** План замены: одна строка плана на каждую затронутую ячейку — это и есть превью (V8). */
function replaceChanges(
  data: SheetData,
  columns: readonly ColumnProfile[],
  input: FindReplaceInput,
): PlannedChange[] {
  const map = data.map;
  const changes: PlannedChange[] = [];
  data.rows.forEach((row, index) => {
    for (const column of columns) {
      const before = row[column.name];
      if (before === null || before === undefined) continue;
      const next = replaceIn(String(before), input);
      if (next === null) continue;
      changes.push({
        kind: 'set',
        a1: `${map.sheet}!${column.letter}${map.headerRow + index + 1}`,
        column: column.name,
        before,
        after: next,
      });
    }
  });
  return changes;
}
