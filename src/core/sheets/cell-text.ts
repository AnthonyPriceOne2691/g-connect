/**
 * Текст ячейки глазами разбора листа — общий у карты (`map.ts`) и границы блока (`block-bound.ts`):
 * одна правда о «пусто», «число» и «дата», иначе граница и профиль колонки разошлись бы молча.
 */

import type { Cell } from './types.js';

export const text = (cell: Cell | undefined): string =>
  cell?.value === null || cell?.value === undefined ? '' : String(cell.value).trim();

export const isBlank = (cell: Cell | undefined): boolean => text(cell) === '';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/;
export const NUMBER_RE = /^-?\d+([.,]\d+)?$/;
