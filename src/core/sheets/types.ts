/**
 * Доменные типы таблицы. Сознательно НЕ типы `googleapis`: ядро не должно знать форму
 * библиотеки, иначе фейк в тестах придётся строить под неё, а не под нужды ядра
 * (решение от 2026-09-01 в decisions.md).
 */

export type CellValue = string | number | boolean | null;

/**
 * Вид ячейки — только то, что требует паритет с горячими клавишами (§6.1–6.2): Ctrl+B,
 * Ctrl+I, Ctrl+U, Ctrl+Shift+E/L/R и цвет фона.
 *
 * Поля опциональны и означают «задано явно». Ячейка может ВЫГЛЯДЕТЬ жирной из-за темы или
 * условного форматирования, и тогда здесь будет пусто: ядро судит и откатывает только
 * явный формат ячейки, и это названо в спеке непокрытостью, а не спрятано.
 */
export interface CellFormat {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly align?: 'left' | 'center' | 'right';
  /** Цвет фона как его вводит человек: `#RRGGBB`. */
  readonly background?: string;
}

export interface Cell {
  readonly value: CellValue;
  /** Введённая формула, если в ячейке она, а не значение. */
  readonly formula?: string;
  /** Явно заданный вид; отсутствует, когда ничего не задано. */
  readonly format?: CellFormat;
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

/**
 * Свойства листа, которые ядро умеет вернуть после удаления (D-19).
 *
 * Список закрытый и короткий намеренно: всё, чего здесь нет, откат не восстановит, и об
 * этом человек читает В ПЛАНЕ до удаления, а не выясняет после.
 */
export interface SheetProperties {
  readonly frozenRows?: number;
  readonly frozenColumns?: number;
  /** Цвет ярлыка как `#RRGGBB`. */
  readonly tabColor?: string;
  readonly hidden?: boolean;
}

/**
 * Чего на листе есть, но чего ядро восстановить не может. Считается, чтобы назвать
 * человеку ЧИСЛОМ, что он потеряет безвозвратно (решение владельца 2026-09-03).
 */
export interface SheetExtras {
  readonly conditionalFormats: number;
  readonly dataValidations: number;
  readonly protectedRanges: number;
  readonly charts: number;
  readonly filters: number;
}

export interface SheetSnapshot {
  readonly title: string;
  readonly sheetId: number;
  /** Строки с первой по последнюю заполненную; вложенный массив — по колонкам. */
  readonly rows: readonly (readonly Cell[])[];
  readonly properties?: SheetProperties;
  /** Невосстановимое, посчитанное: условное форматирование, проверки данных и прочее. */
  readonly extras?: SheetExtras;
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
  /**
   * Вид ячейки заголовка и вид первой строки данных — попадают в карту только когда
   * что-то задано явно. Агенту это нужно, чтобы «сделай как в шапке» имело смысл, а
   * человеку — чтобы видеть, что правка вида вообще возможна.
   */
  readonly headerFormat?: CellFormat;
  readonly format?: CellFormat;
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
  /**
   * Явный вид тех же ячеек, ключ — имя колонки. Отдельным полем, а не внутри `rows`:
   * `rows` читают все, кто пишет значения, и добавлять им объект вида в каждую ячейку
   * значило бы утяжелить самый частый путь ради самого редкого. Пустых записей нет.
   */
  readonly formats: readonly Readonly<Record<string, CellFormat>>[];
  /** Вид ячеек строки заголовков — для «сделай шапку жирной». */
  readonly headerFormats: Readonly<Record<string, CellFormat>>;
}

export interface ReadOptions {
  /** Читать только этот лист — иначе тянется всё, а это дорого на живых таблицах. */
  readonly sheet?: string;
  /** Верхняя граница строк: ответ помечается усечённым, а не молча обрезается (§9.5). */
  readonly maxRows?: number;
}

/**
 * Правка вида одной ячейки. Запрос доменный, а не `sheets_v4.Schema$Request`: иначе фейк в
 * тестах пришлось бы строить под форму библиотеки, а не под нужды ядра (решение фазы 1), и
 * типы `googleapis` протекли бы за единственный шов — на это есть гейт `core-no-library`.
 *
 * Гранулярность — ячейка, а не диапазон: план записи и так живёт по ячейкам, и снимок вида
 * «до» для отката собирается по ним же. Один вызов `batchUpdate` уносит их пачкой.
 */
export interface FormatRequest {
  readonly kind: 'format';
  readonly sheetId: number;
  /** 1-based строка и 0-based колонка — как в остальном домене. */
  readonly row: number;
  readonly column: number;
  /** Только заданные поля и правятся: `{ bold: true }` не сбрасывает выравнивание. */
  readonly format: CellFormat;
}

/** Строки или колонки: у структурных операций это одно и то же с разной осью. */
export type Dimension = 'rows' | 'columns';

/**
 * Вставка строк или колонок (§6.2, `Ctrl+Shift+=`). Позиция 1-based и означает «перед
 * этим номером»: `at: 4, count: 1` вставляет одну строку так, что прежняя четвёртая
 * становится пятой.
 */
export interface InsertDimensionRequest {
  readonly kind: 'insertDimension';
  readonly sheetId: number;
  readonly dimension: Dimension;
  readonly at: number;
  readonly count: number;
}

/** Удаление строк или колонок. Обратная операция для вставки и наоборот. */
export interface DeleteDimensionRequest {
  readonly kind: 'deleteDimension';
  readonly sheetId: number;
  readonly dimension: Dimension;
  readonly at: number;
  readonly count: number;
}

/** Новый лист. Id не возвращаем: откат адресует лист по имени, оно уникально в книге. */
export interface AddSheetRequest {
  readonly kind: 'addSheet';
  readonly title: string;
  /** Свойства при создании — ими откат возвращает удалённый лист «как был» (D-19). */
  readonly properties?: SheetProperties;
}

export interface DeleteSheetRequest {
  readonly kind: 'deleteSheet';
  readonly sheetId: number;
}

export interface RenameSheetRequest {
  readonly kind: 'renameSheet';
  readonly sheetId: number;
  readonly title: string;
}

/**
 * Прямоугольник листа для доменных запросов: 1-based строка, 0-based колонка — как в
 * остальном домене, а не как в библиотеке. Перевод в полуинтервал Google живёт в шве.
 */
export interface DomainRange {
  readonly row: number;
  readonly column: number;
  readonly rowCount: number;
  readonly columnCount: number;
}

/** Что переносить при вставке: всё, только значения или только вид (§6.2, Ctrl+Shift+V). */
export type PasteKind = 'all' | 'values' | 'format';

export interface CopyPasteRequest {
  readonly kind: 'copyPaste';
  readonly sheetId: number;
  readonly source: DomainRange;
  readonly destination: DomainRange;
  readonly paste: PasteKind;
}

/** Вырезать и вставить: источник очищается тем же запросом Google. */
export interface CutPasteRequest {
  readonly kind: 'cutPaste';
  readonly sheetId: number;
  readonly source: DomainRange;
  readonly destination: DomainRange;
  readonly paste: PasteKind;
}

/** Автозаполнение: Google экстраполирует по образцу из `source` на `destination`. */
export interface AutoFillRequest {
  readonly kind: 'autoFill';
  readonly sheetId: number;
  readonly source: DomainRange;
  readonly destination: DomainRange;
}

/**
 * Перемещение строк (§6.2). `destinationIndex` — 0-based и считается ПО КООРДИНАТАМ ДО
 * удаления блока, как требует Google: `at=2, count=3, destinationIndex=9` оставляет блок
 * на позиции 6 (проверено по документации и её же примеру). Формула обратного хода живёт
 * в `undo-structure.ts` и покрыта оракулом на числах.
 */
export interface MoveDimensionRequest {
  readonly kind: 'moveDimension';
  readonly sheetId: number;
  readonly dimension: Dimension;
  readonly at: number;
  readonly count: number;
  readonly destinationIndex: number;
}

/**
 * Сортировка диапазона по одной колонке. Диапазон всегда начинается с колонки A: в
 * документации не сказано, относительно чего считается `dimensionIndex` у `sortSpecs` —
 * листа или диапазона, — а при начале от A оба чтения совпадают.
 */
export interface SortRangeRequest {
  readonly kind: 'sortRange';
  readonly sheetId: number;
  readonly range: DomainRange;
  /** 0-based индекс колонки листа. */
  readonly column: number;
  readonly descending?: boolean;
}

export interface DuplicateSheetRequest {
  readonly kind: 'duplicateSheet';
  readonly sheetId: number;
  readonly title: string;
}

export type SheetRequest =
  | FormatRequest
  | InsertDimensionRequest
  | DeleteDimensionRequest
  | AddSheetRequest
  | DeleteSheetRequest
  | RenameSheetRequest
  | CopyPasteRequest
  | CutPasteRequest
  | AutoFillRequest
  | DuplicateSheetRequest
  | MoveDimensionRequest
  | SortRangeRequest;

export interface SheetsClient {
  getSpreadsheet(id: string, options?: ReadOptions): Promise<SpreadsheetSnapshot>;
  /** Запись значений в A1-диапазон; `values` — как ввёл бы человек. */
  updateValues(id: string, range: string, values: readonly (readonly CellValue[])[]): Promise<void>;
  appendValues(id: string, range: string, values: readonly (readonly CellValue[])[]): Promise<void>;
  /** Правки, которых нет в values-API: вид ячеек (§6.2), дальше — структурные (2.5b). */
  batchUpdate(id: string, requests: readonly SheetRequest[]): Promise<void>;
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
