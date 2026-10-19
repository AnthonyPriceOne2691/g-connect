/**
 * Диапазоны чтения таблицы (D-26) — отдельным модулем по гейту длины `sheets.ts`.
 *
 * Названный лист без `maxRows` читается ЦЕЛИКОМ: по такому снимку считаются запись, превью,
 * предусловие и откат. Частичное чтение — только явным `maxRows` (лёгкая карта), и такой снимок
 * помечается `rowLimit`, чтобы карта сказала вслух, что лист может продолжаться.
 */

import type { ReadOptions, SpreadsheetSnapshot } from '../sheets/types.js';

/**
 * Диапазон чтения (D-26): книга целиком без листа; названный лист — целиком, если `maxRows`
 * не задан (по такому снимку считается запись), иначе — первые `maxRows` строк.
 */
export function rangesFor(options: ReadOptions): string[] | undefined {
  if (options.sheet === undefined) return undefined;
  return [
    options.maxRows === undefined
      ? `'${options.sheet}'`
      : `'${options.sheet}'!A1:ZZ${options.maxRows}`,
  ];
}

/** Лёгкое чтение помечается: карта обязана сказать, что лист может продолжаться. */
export function withRowLimit(
  snapshot: SpreadsheetSnapshot,
  maxRows: number | undefined,
): SpreadsheetSnapshot {
  return maxRows === undefined ? snapshot : { ...snapshot, rowLimit: maxRows };
}
