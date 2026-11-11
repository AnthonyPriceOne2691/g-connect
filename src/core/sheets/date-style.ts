/**
 * Вид дат — колонки, листа и книги (D-26, Q15).
 *
 * Колонка пишет дату тем видом, каким даты в ней уже записаны: «2026-09-01» в колонку с
 * «01.09.2026» — порча. У пустой колонки своего вида нет, и первая дата уходила как её прислал
 * агент: в «Реестре инфраструктуры» «Дата старта» встала 2026-09-10 при 19.10.2026 во всей
 * книге, а дальше колонка держала уже этот вид. Теперь у пустой колонки — вид дат листа, а
 * без них — вид локали книги.
 *
 * Регулярки и список локалей — внутри функций, а не на уровне модуля: мутант кода уровня
 * модуля Stryker судит всем набором тестов, а не тестами, которые его покрывают (у `map.ts`
 * 33 таких мутанта стоили доле десяти минут — урок бюджета D-26).
 */

import type { ColumnProfile } from './types.js';

export type DateStyle = 'iso' | 'dotted';

/** Вид одной даты: ISO `2026-09-10` или с точкой (косой) `10.09.2026`; иначе — не дата. */
function styleOf(raw: string): DateStyle | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'iso';
  if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(raw)) return 'dotted';
  return null;
}

/** Формат даты берётся у самой колонки: писать «2026-09-01» в колонку с «01.09.2026» — порча. */
export function detectDateFormat(values: readonly string[]): DateStyle | null {
  let iso = 0;
  let dotted = 0;
  for (const v of values) {
    const style = styleOf(v);
    if (style === 'iso') iso += 1;
    else if (style === 'dotted') dotted += 1;
  }
  if (iso === 0 && dotted === 0) return null;
  return iso >= dotted ? 'iso' : 'dotted';
}

/**
 * День и месяц числовой даты — то, что вид колонки может переписать; слова («сегодня») —
 * это текст, и здесь `null`. Нужны, чтобы сверить разобранную дату с написанной:
 * «31.02.2026» `Date` молча переносит в 3 марта, а переписать дату в чужой день — порча.
 */
export function dayAndMonth(raw: string): { readonly day: number; readonly month: number } | null {
  const iso = /^\d{4}-(\d{2})-(\d{2})$/.exec(raw);
  if (iso !== null) return { day: Number(iso[2]), month: Number(iso[1]) };
  const dotted = /^(\d{1,2})[./](\d{1,2})[./]\d{2,4}$/.exec(raw);
  if (dotted !== null) return { day: Number(dotted[1]), month: Number(dotted[2]) };
  return null;
}

/**
 * Вид локали книги: «день.месяц.год» — у локалей, где так пишется краткая дата (CLDR, короткий
 * формат: ru, uk, be, kk, de, pl, tr, ro, nb, da, fi, et). У остальных вида нет, и значение
 * уходит как прислано: «10.09.2026» в книге `en_US` Google прочёл бы как 9 октября.
 */
export function localeDateStyle(locale: string | undefined): DateStyle | null {
  if (locale === undefined) return null;
  const dotted = ['ru', 'uk', 'be', 'kk', 'de', 'pl', 'tr', 'ro', 'nb', 'da', 'fi', 'et'];
  const language = locale.toLowerCase().split(/[_-]/)[0] ?? '';
  return dotted.includes(language) ? 'dotted' : null;
}

/** Вид дат листа — тот, что у большинства колонок со своими датами; ничья — вида нет. */
export function sheetDateStyle(columns: readonly ColumnProfile[]): DateStyle | null {
  let iso = 0;
  let dotted = 0;
  for (const column of columns) {
    if (column.dateFormat === 'iso') iso += 1;
    else if (column.dateFormat === 'dotted') dotted += 1;
  }
  if (iso === dotted) return null;
  return iso > dotted ? 'iso' : 'dotted';
}

/**
 * Пустой колонке — вид дат листа, а без них — вид локали книги; колонки со своими значениями
 * остаются при своём виде (или без вида, если дат в них нет).
 */
export function withDateStyle(
  columns: readonly ColumnProfile[],
  locale: string | undefined,
): ColumnProfile[] {
  const style = sheetDateStyle(columns) ?? localeDateStyle(locale);
  return columns.map((column) =>
    column.filled === 0 && style !== null ? { ...column, dateFormat: style } : column,
  );
}
