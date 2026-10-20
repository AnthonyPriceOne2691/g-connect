/**
 * Границы данных и колонки без подписи (D-26, Q30–Q32).
 *
 * Находки двух сессий на живых листах (профиль work). «Лист5»: данные в A1:C27, C1 пустая, в
 * C9–C11 три подпункта — колонки C не было ни в `columns`, ни в строках, предупреждения тоже;
 * подсказал только `usedRange`, а шапку искали перебором. «Лог проверок»: `usedRange` A1:Z46 при
 * колонках A–B — границу считали по всем ячейкам сетки, и оформление выдавало себя за данные.
 *
 * Отдельным модулем по гейту длины `map.ts` — и по делу: карту и окно строк `values` судит одно
 * правило, и ключ колонки без подписи у них обязан совпадать.
 */

import { columnLetter, type Cell, type ColumnProfile, type UnlabeledColumn } from './types.js';

type Rows = readonly (readonly Cell[])[];

/** Колонка по имени и месту — всё, что нужно, чтобы разложить строку по ключам. */
export type KeyedColumn = Pick<ColumnProfile, 'name' | 'index'>;

/** Значение — как его считает карта (`filled` колонок): пусто и одни пробелы — не значение. */
const hasValue = (cell: Cell): boolean => cell.value !== null && String(cell.value).trim() !== '';

/**
 * `usedRange` — от A1 до последней строки и последней колонки со значением или формулой (Q31).
 * Раньше — по всем ячейкам, что отдал Google, а он отдаёт и ячейки с одним оформлением: у «Лога
 * проверок» выходило A1:Z46 при данных в A–B. Пустой лист — `A1:A1`, как раньше. Размер сетки —
 * отдельное поле (`sheetRows`, Q7), и его это не касается.
 */
export function dataBounds(title: string, rows: Rows): string {
  const { height, width } = extentOf(rows);
  return `${title}!A1:${columnLetter(Math.max(width, 1) - 1)}${Math.max(height, 1)}`;
}

/** Строк до последней со значением или формулой — высота других листов в карте (Q31). */
export const dataHeight = (rows: Rows): number => extentOf(rows).height;

function extentOf(rows: Rows): { height: number; width: number } {
  let height = 0;
  let width = 0;
  rows.forEach((row, index) => {
    row.forEach((cell, column) => {
      if (cell.formula === undefined && !hasValue(cell)) return;
      height = index + 1;
      width = Math.max(width, column + 1);
    });
  });
  return { height, width };
}

/** Колонки без подписи — для карты и для окна `values`. */
export interface Unlabeled {
  /** По порядку листа; пусто — таких колонок нет. */
  readonly columns: readonly UnlabeledColumn[];
  /** Поле карты — только когда такие колонки есть: лист без них карта отдаёт прежней (Q32). */
  readonly fields: { readonly unlabeled?: readonly UnlabeledColumn[] };
  readonly warnings: readonly string[];
}

/** Начало предупреждения — по нему `values` заменяет предупреждение карты своим (Q30). */
export const UNLABELED_WARNING = 'в колонках без подписи';

/**
 * Колонки без подписи со значениями в строках данных (Q30) — под пустой ячейкой шапки между
 * подписями и правее последней. `detectSideBlock` видит только разрыв МЕЖДУ подписями, а записи
 * строк берут лишь колонки карты, и такие значения выпадали молча. `rows` — строки подряд, первая —
 * строка листа `firstRow`; подписанные — колонки карты. Колонка с одним оформлением или заметкой —
 * не данные: ни поля, ни предупреждения (Q30, п. 4). `where` — чьё предупреждение: карта посылает
 * читать `values`, а `values` называет ключи своих строк.
 */
export function unlabeledIn(
  rows: Rows,
  firstRow: number,
  labeled: readonly KeyedColumn[],
  where: 'map' | 'values',
): Unlabeled {
  const indices = new Set(labeled.map((column) => column.index));
  const found = new Map<number, Span>();
  const touched = new Set<number>();
  rows.forEach((row, offset) => {
    const at = firstRow + offset;
    row.forEach((cell, index) => {
      if (indices.has(index) || !hasValue(cell)) return;
      const span = found.get(index);
      found.set(index, { first: span?.first ?? at, last: at, filled: (span?.filled ?? 0) + 1 });
      touched.add(at);
    });
  });
  const names = new Set(labeled.map((column) => column.name));
  const columns = [...found.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, span]) => columnOf(index, span, names));
  return {
    columns,
    fields: columns.length === 0 ? {} : { unlabeled: columns },
    warnings: warningOf(columns, touched.size, where),
  };
}

/** Где в колонке значения: строки листа — первая и последняя, и сколько их. */
interface Span {
  readonly first: number;
  readonly last: number;
  readonly filled: number;
}

function columnOf(index: number, span: Span, names: ReadonlySet<string>): UnlabeledColumn {
  const letter = columnLetter(index);
  // Буква в скобках — так колонку не подписывают; а подписали — ещё скобки, пока ключ не свободен:
  // ключ, совпавший с подписью, затёр бы в строке `values` значение настоящей колонки.
  let key = `(${letter})`;
  while (names.has(key)) key = `(${key})`;
  const { first, last, filled } = span;
  return { letter, index, key, filled, rows: first === last ? `${first}` : `${first}–${last}` };
}

/**
 * Предупреждение (Q30): сколько значений не попало в колонки и как их прочесть. Запись не
 * открывается — это хотфикс чтения: резолвер записи знает только колонки карты, и ключ `(C)` для
 * него — незнакомая колонка, вопрос, а не запись.
 */
function warningOf(
  columns: readonly UnlabeledColumn[],
  rows: number,
  where: 'map' | 'values',
): string[] {
  if (columns.length === 0) return [];
  const cells = columns.reduce((sum, column) => sum + column.filled, 0);
  const keys =
    `под ${columns.length === 1 ? 'ключом' : 'ключами'} ` +
    listed(columns.map((column) => `«${column.key}»`));
  const tail =
    where === 'map'
      ? `в данные не попали; прочитать — gc_read mode=values, там они ${keys}`
      : `в rows они ${keys}`;
  return [
    `${UNLABELED_WARNING} (${listed(columns.map((column) => column.letter))}) есть значения: ` +
      `${cells} ${plural(cells, ['ячейка', 'ячейки', 'ячеек'])} в ${rows} ` +
      `${plural(rows, ['строке', 'строках', 'строках'])} — ${tail}; писать в них нельзя, пока ` +
      'в шапке нет подписи',
  ];
}

/** Пять — и многоточие: предупреждение остаётся строкой, а целиком список — в поле `unlabeled`. */
const listed = (items: readonly string[]): string =>
  items.length > 5 ? `${items.slice(0, 5).join(', ')}, …` : items.join(', ');

/** Форма слова при числе: 1 ячейка, 3 ячейки, 5 ячеек; 11–14 — как 5. */
function plural(n: number, [one, few, many]: readonly [string, string, string]): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return many;
  const units = n % 10;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}
