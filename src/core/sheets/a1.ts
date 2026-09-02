/**
 * Адреса A1 и чтение значения по адресу.
 *
 * Вынесено из `undo.ts` в слайсе 1 фазы 2.6: тем же разбором пользуется предусловие
 * записи («в ячейке всё ещё то, что показывало превью»), а вторая копия разбора адресов
 * разъехалась бы с первой молча — и разъезд был бы виден только на живой таблице.
 */

import type { CellValue, SheetSnapshot } from './types.js';

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
