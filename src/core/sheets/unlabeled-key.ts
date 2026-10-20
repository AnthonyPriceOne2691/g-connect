/**
 * Колонка без подписи — явным ключом (D-26, Q40).
 *
 * Случай соседней сессии: лист ежедневного отчёта, A1 пуста, B1–F1 подписаны, даты дней и
 * названия задач — в колонке A. Карта называла A колонкой без подписи с ключом `(A)`, но ни писать в
 * неё, ни ставить её в условие было нельзя (Q30), и якорь «строка, где A = 19.10.2026» агент взял
 * обходом `headerRow: 2`: шапкой стала строка-пометка, а A получила имя из 272 символов. Решение
 * владельца — «Явный ключ «(A)»»: писать и искать по такой колонке — только точным ключом из карты.
 *
 * Отдельным модулем от резолвера по делу: резолвер нечёткий по замыслу и колонок без подписи не
 * знает вовсе — поэтому «A», «(a)» и «колонка A» он к ним не сведёт никогда. Точный ключ решается
 * здесь, до него; ключ в скобках, который колонкой не стал, — отказ, а не подбор.
 */

import type { Cell, ColumnProfile, SheetData, UnlabeledColumn } from './types.js';
import type { Question } from './write-types.js';

/**
 * Профили записи колонок без подписи (Q40): имя — ключ `(C)` из карты, значение — свободный текст,
 * как у подписанной колонки без выведенного типа, вида дат и списка: ни `not_in_enum`, ни отказа по
 * типу. Формулы и защита — как у подписанной: формульную колонку запись без `force` не затрёт.
 * `rows` — строки данных листа, первая — строка под шапкой.
 */
export function unlabeledProfiles(
  columns: readonly UnlabeledColumn[],
  rows: readonly (readonly Cell[])[],
  isProtected: (index: number) => boolean,
): ColumnProfile[] {
  return columns.map((column) => {
    const cells = rows.map((row) => row[column.index]);
    const values = cells.map((cell) => String(cell?.value ?? '').trim()).filter((v) => v !== '');
    return {
      name: column.key,
      letter: column.letter,
      index: column.index,
      type: 'string',
      dateFormat: null,
      enumValues: null,
      enumSource: null,
      filled: column.filled,
      unique: new Set(values.map((value) => value.toLowerCase())).size,
      hasFormula: cells.some((cell) => cell?.formula !== undefined),
      protected: isProtected(column.index),
    };
  });
}

/** Колонка без подписи по ключу — только точное совпадение: регистр и скобки — часть ключа. */
export const unlabeledByKey = (requested: string, data: SheetData): ColumnProfile | undefined =>
  data.unlabeled.find((column) => column.name === requested);

/**
 * Допущение превью (Q40) — одно на ключ и операцию: одинаковые строки из условия и значений
 * сводит контур записи. Глагол общий — колонка бывает и условием строк, и местом записи.
 */
export const unlabeledAssumption = (column: ColumnProfile): string =>
  `${column.name} — колонка без подписи в шапке: беру ${column.letter} по явному ключу`;

/**
 * Ключ в скобках, не ставший колонкой без подписи, — отказ без подбора (Q40). `(B)` у подписанной
 * колонки называет её подпись; `(Z)` без значений, `(a)` не в том регистре — список ключей и
 * подсказку «подпиши шапку». Не ключ по виду (`A`, `колонка A`) — `null`: такое имя судит резолвер
 * подписанных колонок, как любое другое. `available` — полный список того, что пишется.
 */
export function unlabeledKeyQuestion(
  requested: string,
  data: SheetData,
  available: readonly string[],
): Question | null {
  const shape = /^\(+([A-Za-z]+)\)+$/.exec(requested.trim());
  if (shape === null) return null;
  const letter = (shape[1] ?? '').toUpperCase();
  const labeled = data.map.columns.find((column) => column.letter === letter);
  const base = { field: requested, reason: 'no_match' as const, available };
  if (labeled !== undefined) {
    return {
      ...base,
      detail:
        `У ${letter} есть подпись «${labeled.name}» — пиши по ней: ключ в скобках бывает только ` +
        'у колонки без подписи в шапке.',
      candidates: [labeled.name],
    };
  }
  const keys = data.unlabeled.map((column) => `«${column.name}»`);
  const found =
    keys.length === 0
      ? `на листе «${data.map.sheet}» таких колонок нет`
      : `есть ${keys.join(', ')}`;
  return {
    ...base,
    detail:
      `Ключа «${requested}» среди колонок без подписи со значениями нет — ${found}. Ключ пишется ` +
      'точно, как в карте; в колонку без подписи и без значений не пишу — подпиши шапку.',
    candidates: [],
  };
}
