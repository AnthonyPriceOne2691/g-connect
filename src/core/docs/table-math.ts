/**
 * Арифметика таблиц Docs (уровень 3, слайс 6c): где окажутся ячейки ПОСЛЕ структурной
 * правки, которую мы ещё не сделали. Нужна откатам: вставив строку/колонку/таблицу,
 * ядро вписывает сохранённые тексты по вычисленным позициям — одним пакетом, атомарно.
 *
 * ⚠ Правила выведены из документации и согласованы с фикстурой (оракул на числах);
 * живой прогон сверяет их против Google ДО первой правки живых таблиц — это названо
 * в чек-листе, а не предположено молча:
 * - вход в таблицу — 1 юнит; вход в строку — 1; вход в ячейку — 1;
 * - пустая ячейка несёт пустой абзац — ещё 1 юнит (`\n`);
 * - точка вставки текста в пустую ячейку — `cellStart + 1`.
 */

import type { DocTable } from './types.js';

/** Ширина пустой ячейки: вход + пустой абзац. */
const EMPTY_CELL = 2;

/** Ширина пустой строки из `columns` ячеек: вход в строку + ячейки. */
export const emptyRowWidth = (columns: number): number => 1 + columns * EMPTY_CELL;

/**
 * Точки вставки текста в ячейки НОВОЙ строки, вставленной на место `rowIndex`
 * (или после последней при `rowIndex === rows`). Позиции — ДО вставки текстов;
 * вписывать с конца, чтобы сдвиги не портили предыдущие.
 */
export function newRowCellInsertionPoints(table: DocTable, rowIndex: number): number[] {
  const rowStart =
    rowIndex < table.rowRanges.length
      ? table.rowRanges[rowIndex]!.startIndex
      : table.rowRanges[table.rowRanges.length - 1]!.endIndex;
  return Array.from({ length: table.columns }, (_, c) => rowStart + 1 + c * EMPTY_CELL + 1);
}

/**
 * Точки вставки текста в ячейки НОВОЙ колонки на месте `columnIndex` (или после
 * последней при `columnIndex === columns`). Вставка колонки добавляет ячейку в КАЖДУЮ
 * строку, и сдвиг накапливается по строкам: у строки r всё, что ниже точки вставки,
 * уехало на `r × EMPTY_CELL`.
 */
export function newColumnCellInsertionPoints(table: DocTable, columnIndex: number): number[] {
  return table.rowRanges.map((row, r) => {
    const base =
      columnIndex < table.columns ? table.cellRanges[r]![columnIndex]!.startIndex : row.endIndex;
    return base + r * EMPTY_CELL + 1;
  });
}

/**
 * Точки вставки текста в ячейки НОВОЙ пустой таблицы `rows × columns`, чей вход
 * окажется на `tableStart`. Порядок — по строкам; вписывать с конца.
 */
export function newTableCellInsertionPoints(
  tableStart: number,
  rows: number,
  columns: number,
): number[][] {
  return Array.from({ length: rows }, (_, r) => {
    const rowStart = tableStart + 1 + r * emptyRowWidth(columns);
    return Array.from({ length: columns }, (_, c) => rowStart + 1 + c * EMPTY_CELL + 1);
  });
}
