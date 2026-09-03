/**
 * Адреса A1 и чтение значения по адресу.
 *
 * Вынесено из `undo.ts` в слайсе 1 фазы 2.6: тем же разбором пользуется предусловие
 * записи («в ячейке всё ещё то, что показывало превью»), а вторая копия разбора адресов
 * разъехалась бы с первой молча — и разъезд был бы виден только на живой таблице.
 */

import type { CellFormat, CellValue, SheetSnapshot } from './types.js';

/** `Лист1!D3` → лист и индексы (1-based строка, 0-based колонка). `null` — не адрес. */
export function parseA1(a1: string): { sheet: string; row: number; column: number } | null {
  const match = /^(.+)!([A-Z]+)(\d+)$/.exec(a1);
  if (match === null) return null;
  const letters = match[2] ?? '';
  let column = 0;
  for (const ch of letters) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { sheet: match[1] ?? '', row: Number(match[3]), column: column - 1 };
}

/**
 * Значение по адресу или `undefined`, если адрес не разобрался.
 *
 * Разница между `undefined` и `null` здесь смысловая: `null` — «в ячейке пусто», а
 * `undefined` — «спросили не то»; сливать их значило бы объявлять пустой ячейкой опечатку
 * в адресе.
 */
export function valueAt(
  snapshot: { readonly sheets: readonly SheetSnapshot[] },
  a1: string,
): CellValue | undefined {
  const parsed = parseA1(a1);
  if (parsed === null) return undefined;
  const sheet = snapshot.sheets.find((s) => s.title === parsed.sheet);
  return sheet?.rows[parsed.row - 1]?.[parsed.column]?.value ?? null;
}

/**
 * Сравнение значений так, как их видит человек: «2» и 2 — одно и то же, пробелы по краям
 * не считаются правкой. Семантика перенесена из `undo.ts` без изменений: там она уже
 * судила «трогали ли нашу ячейку», и расхождение двух сравнений было бы худшим из миров.
 */
export const sameCell = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  String(a ?? '').trim() === String(b ?? '').trim();

/** Явный вид ячейки по адресу — то же, что `valueAt`, но про формат. */
export function formatAt(
  snapshot: { readonly sheets: readonly SheetSnapshot[] },
  a1: string,
): CellFormat | undefined {
  const parsed = parseA1(a1);
  if (parsed === null) return undefined;
  const sheet = snapshot.sheets.find((s) => s.title === parsed.sheet);
  return sheet?.rows[parsed.row - 1]?.[parsed.column]?.format;
}

/**
 * Сравнение видов по сути, а не по порядку ключей: `{bold, italic}` и `{italic, bold}` —
 * один вид. Живёт здесь, а не в `rows.ts`, потому что нужно и плану, и охранникам.
 */
export function sameFormat(a: CellFormat | undefined, b: CellFormat | undefined): boolean {
  return formatKey(a) === formatKey(b);
}

/**
 * Вид как строка для сравнения. `bold: false` и «жирность не задана» — это ОДИН вид:
 * ячейка выглядит одинаково, и просьба «снять жирность» там, где её нет, не должна
 * становиться планом. Нашла живая проверка 2026-09-03: `{bold: false}` на неоформленной
 * ячейке строило правку вместо `no_change`.
 *
 * Выравнивание и фон так не сворачиваются: у выравнивания значение по умолчанию зависит
 * от типа данных (числа Google равняет вправо), а белый фон — осознанный выбор, а не
 * «фона нет». Схлопывать их значило бы врать в другую сторону.
 */
export function formatKey(format: CellFormat | undefined): string {
  const entries = Object.entries(format ?? {}).filter(([key, value]) => {
    if (value === undefined) return false;
    const isFlag = key === 'bold' || key === 'italic' || key === 'underline';
    return !(isFlag && value === false);
  });
  return JSON.stringify(entries.sort(([x], [y]) => (x < y ? -1 : 1)));
}
