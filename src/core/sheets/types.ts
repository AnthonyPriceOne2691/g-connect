/**
 * Доменные типы таблицы. Сознательно НЕ типы `googleapis`: ядро не должно знать форму
 * библиотеки, иначе фейк в тестах придётся строить под неё, а не под нужды ядра
 * (решение от 2026-09-01 в decisions.md).
 */

export type CellValue = string | number | boolean | null;

export interface Cell {
  readonly value: CellValue;
  /** Введённая формула, если в ячейке она, а не значение. */
  readonly formula?: string;
}

export interface GridRange {
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface ValidationRule {
  readonly range: GridRange;
  readonly values: readonly string[];
}

export interface SheetSnapshot {
  readonly title: string;
  readonly sheetId: number;
  /** Строки с первой по последнюю заполненную; вложенный массив — по колонкам. */
  readonly rows: readonly (readonly Cell[])[];
  readonly frozenRows?: number;
  readonly validations?: readonly ValidationRule[];
  readonly protectedRanges?: readonly GridRange[];
  /** Объединённые ячейки: на них разбор таблицы спотыкается, поэтому о них говорят. */
  readonly merges?: readonly GridRange[];
}

export interface SpreadsheetSnapshot {
  readonly id: string;
  readonly title: string;
  readonly revisionId?: string;
  readonly sheets: readonly SheetSnapshot[];
}

export type ColumnType = 'date' | 'number' | 'boolean' | 'link' | 'string' | 'unknown';

export interface ColumnProfile {
  readonly name: string;
  /** Буква колонки: A, B, … — для сообщений человеку и для диапазонов. */
  readonly letter: string;
  /** 0-based индекс внутри строки. */
  readonly index: number;
  readonly type: ColumnType;
  /** Как в колонке записаны даты — чтобы писать в том же виде, а не в своём. */
  readonly dateFormat: 'iso' | 'dotted' | null;
  /** Допустимые значения: из dataValidation таблицы либо выведенные по факту. */
  readonly enumValues: readonly string[] | null;
  /** Откуда взят список: правило таблицы — авторитетно, вывод по данным — нет. */
  readonly enumSource: 'validation' | 'inferred' | null;
  readonly filled: number;
  readonly unique: number;
  /** В колонке есть формулы: запись значения затрёт их (§8.1). */
  readonly hasFormula: boolean;
  readonly protected: boolean;
}

export interface SheetMap {
  readonly spreadsheetId: string;
  readonly spreadsheetTitle: string;
  readonly revisionId: string | null;
  readonly sheet: string;
  readonly sheetId: number;
  /** 1-based номер строки заголовков. */
  readonly headerRow: number;
  /** Как выбрана строка заголовков — показывается человеку (§9.3). */
  readonly headerRowReason: string;
  readonly headerRowConfident: boolean;
  readonly usedRange: string;
  readonly dataRowCount: number;
  readonly columns: readonly ColumnProfile[];
  readonly sampleRows: readonly Readonly<Record<string, CellValue>>[];
  readonly otherSheets: readonly { readonly title: string; readonly rowCount: number }[];
  /** Предупреждения: объединённые ячейки, вторая таблица на листе и т.п. */
  readonly warnings: readonly string[];
}

/**
 * Карта — то, что уходит агенту (десятки строк). Данные — то, что нужно операциям.
 * Разделены сознательно: положить 5000 строк в ответ агенту значит выжечь контекст (§7).
 */
export interface SheetData {
  readonly map: SheetMap;
  /** Все строки данных, ключ — имя колонки. */
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
}

export interface ReadOptions {
  /** Читать только этот лист — иначе тянется всё, а это дорого на живых таблицах. */
  readonly sheet?: string;
  /** Верхняя граница строк: ответ помечается усечённым, а не молча обрезается (§9.5). */
  readonly maxRows?: number;
}

export interface SheetsClient {
  getSpreadsheet(id: string, options?: ReadOptions): Promise<SpreadsheetSnapshot>;
  /** Запись значений в A1-диапазон; `values` — как ввёл бы человек. */
  updateValues(id: string, range: string, values: readonly (readonly CellValue[])[]): Promise<void>;
  appendValues(id: string, range: string, values: readonly (readonly CellValue[])[]): Promise<void>;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
