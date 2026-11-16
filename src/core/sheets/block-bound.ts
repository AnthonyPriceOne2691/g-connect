/**
 * Граница блока на листе из нескольких таблиц одна под другой (DESIGN §9.3; слово владельца
 * 2026-11-16 «давай сейчас исправим» после хотфикса листа оценки). Шапка считала своими строки до
 * конца листа: тип, список, формулы, поиск по ключу и дозапись собирались из чужих блоков.
 *
 * Граница консервативна: ложная прячет строки таблицы с пропуском, пропущенная оставляет прежнее
 * поведение. Новая таблица начинается там, где после пустой строки — сразу или через строку-
 * заголовок из одной текстовой ячейки — идёт строка, похожая на шапку (две и больше разных
 * подписей текстом, без формул), под ней есть данные, и это подтверждено: оформлена как текущая
 * шапка (общая жирность или фон подписей) или стоит подписью над колонкой, где в блоке числа или
 * даты. С заголовком хватает одного подтверждения, без него — нужны оба: строка «Перерыв |
 * отпуск» после пропуска в таблице дат и сумм — данные, а не шапка. Таблица с пропуском, где после
 * пустой строки снова текстовые данные, и таблица с разделами-заголовками границы не получают.
 */

import { DATE_RE, NUMBER_RE, isBlank, text } from './cell-text.js';
import type { Cell } from './types.js';

type Row = readonly Cell[];

export interface BlockBound {
  /** Строк блока под шапкой — до первой пустой строки разрыва. */
  readonly end: number;
  /** Строка листа, где начинается следующая таблица: её заголовок или шапка. */
  readonly nextRow: number;
  /** Строка листа шапки следующей таблицы. */
  readonly nextHeaderRow: number;
  /** Пустых строк между блоком и следующей таблицей. */
  readonly blankRows: number;
  /** Подписи шапки следующей таблицы — для предупреждения карты. */
  readonly labels: readonly string[];
}

/** Подтверждение типом: в колонке блока три и больше чисел или дат, и это 80% её значений. */
const TYPED_MIN = 3;
const TYPED_SHARE = 0.8;

const filledCells = (row: Row): Cell[] => row.filter((cell) => !isBlank(cell));

/**
 * Где кончаются данные шапки: `rows` — строки листа под ней, `headerRow` — её номер. Нет
 * подтверждённой следующей таблицы — `null`, и данные шапки, как раньше, до конца листа.
 */
export function blockBound(
  rows: readonly Row[],
  header: Row,
  headerRow: number,
): BlockBound | null {
  let last = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (filledCells(rows[i] ?? []).length === 0) continue;
    if (last >= 0 && i - last > 1) {
      const next = newTableAt(rows, i, last, header);
      if (next !== null) {
        return {
          end: last + 1,
          nextRow: headerRow + 1 + i,
          nextHeaderRow: headerRow + 1 + next.at,
          blankRows: i - last - 1,
          labels: next.labels,
        };
      }
    }
    last = i;
  }
  return null;
}

/** Строка `i` после пустых — начало новой таблицы? Её шапка — `i` или строка под заголовком. */
function newTableAt(
  rows: readonly Row[],
  i: number,
  last: number,
  header: Row,
): { at: number; labels: readonly string[] } | null {
  const titled = isTitle(rows[i] ?? []);
  const at = titled ? i + 1 : i;
  const candidate = rows[at];
  if (candidate === undefined || !hasData(rows[at + 1])) return null;
  const labels = headerLabels(candidate);
  if (labels === null || !confirmed(candidate, { header, rows, last, titled })) return null;
  return { at, labels };
}

const hasData = (row: Row | undefined): boolean => filledCells(row ?? []).length > 0;

/** С заголовком блока хватает одного подтверждения, без него — нужны оба. */
function confirmed(
  candidate: Row,
  around: { header: Row; rows: readonly Row[]; last: number; titled: boolean },
): boolean {
  const styled = styledLike(candidate, around.header, around.rows[around.last] ?? []);
  const typed = typedBelow(candidate, around.rows.slice(0, around.last + 1));
  return around.titled ? styled || typed : styled && typed;
}

const isLabel = (cell: Cell): boolean => {
  const value = text(cell);
  return cell.formula === undefined && !NUMBER_RE.test(value) && !DATE_RE.test(value);
};

/** Строка-заголовок блока: одна непустая ячейка, текст без формулы — «Сервисы», «Итоги». */
function isTitle(row: Row): boolean {
  const filled = filledCells(row);
  return filled.length === 1 && isLabel(filled[0]!);
}

/** Подписи строки, похожей на шапку: две и больше, все — текст без формул, разные. Иначе `null`. */
function headerLabels(row: Row): readonly string[] | null {
  const filled = filledCells(row);
  if (filled.length < 2 || !filled.every(isLabel)) return null;
  const labels = filled.map(text);
  return new Set(labels.map((label) => label.toLowerCase())).size === labels.length ? labels : null;
}

/** Оформлена как текущая шапка: её общий признак у всех подписей кандидата, но не у строки блока. */
function styledLike(candidate: Row, header: Row, lastRow: Row): boolean {
  const mark = styleMark(header);
  return mark !== null && styleMark(candidate) === mark && styleMark(lastRow) !== mark;
}

/** Общий признак оформления непустых ячеек строки — жирность и фон; общего нет — `null`. */
function styleMark(row: Row): string | null {
  const marks = filledCells(row).map(
    (cell) => `${cell.format?.bold === true ? 'b' : ''}|${cell.format?.background ?? ''}`,
  );
  const first = marks[0];
  return first !== undefined && first !== '|' && marks.every((mark) => mark === first)
    ? first
    : null;
}

/** Хотя бы одна подпись кандидата стоит над колонкой, где в блоке числа или даты. */
function typedBelow(candidate: Row, block: readonly Row[]): boolean {
  return candidate.some((cell, index) => {
    if (isBlank(cell)) return false;
    const values = block.map((row) => text(row[index])).filter((value) => value !== '');
    const typed = values.filter((value) => NUMBER_RE.test(value) || DATE_RE.test(value)).length;
    return typed >= TYPED_MIN && typed >= TYPED_SHARE * values.length;
  });
}
