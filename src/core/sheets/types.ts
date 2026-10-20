/**
 * Доменные типы таблицы. Сознательно НЕ типы `googleapis`: ядро не должно знать форму
 * библиотеки, иначе фейк в тестах придётся строить под неё, а не под нужды ядра
 * (решение от 2026-09-01 в decisions.md).
 */

import type { UntrustedData } from '../policy.js';

export type CellValue = string | number | boolean | null;

/**
 * Вид ячейки — паритет с горячими клавишами (§6.1–6.2): Ctrl+B, Ctrl+I, Ctrl+U,
 * Ctrl+Shift+E/L/R и цвет фона; с D-26 (Q11, Q12) — гарнитура, кегль и формат числа: без них
 * дописанные строки «Реестра инфраструктуры» нельзя было ни увидеть, ни выровнять.
 *
 * Поля опциональны и означают «задано явно». Ячейка может ВЫГЛЯДЕТЬ жирной из-за темы или
 * условного форматирования, и тогда здесь будет пусто: ядро судит и откатывает только
 * явный формат ячейки, и это названо в спеке непокрытостью, а не спрятано.
 *
 * `null` у гарнитуры, кегля, формата числа, фона и цвета текста — «сбросить к виду листа по
 * умолчанию». Так откат возвращает ячейку, где поле не было задано: нейтрального значения, как
 * `bold: false`, у них нет — шрифт листа по умолчанию у каждой книги свой, а белый фон — не «без
 * заливки» (Q16). Снаружи (`gc_apply`) `null` не принимается: это слово отката, а не правки; фон,
 * цвет текста и формат числа (Q41) снимаются словом `"none"`, и граница переводит его в `null`.
 */
export interface CellFormat {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly align?: 'left' | 'center' | 'right';
  /** Цвет фона как его вводит человек: `#RRGGBB`; `null` — без заливки, вид листа (Q16). */
  readonly background?: string | null;
  /** Цвет текста `#RRGGBB` (Q18); `null` — цвет текста листа. */
  readonly textColor?: string | null;
  /** Гарнитура, как её называет Google: `Carlito`, `Arial`. */
  readonly fontFamily?: string | null;
  /** Кегль в пунктах. */
  readonly fontSize?: number | null;
  /** Формат числа или даты: тип Google и шаблон — `DATE` и `dd.mm.yyyy`; `null` — формат листа. */
  readonly numberFormat?: NumberFormat | null;
}

/** Типы формата числа Google (`NumberFormat.type`), без `NUMBER_FORMAT_TYPE_UNSPECIFIED`. */
export type NumberFormatType =
  'TEXT' | 'NUMBER' | 'PERCENT' | 'CURRENCY' | 'DATE' | 'TIME' | 'DATE_TIME' | 'SCIENTIFIC';

export interface NumberFormat {
  readonly type: NumberFormatType;
  /** Шаблон Google: `dd.mm.yyyy`, `#,##0.00`. Без шаблона Google берёт вид типа по локали. */
  readonly pattern?: string;
}

export interface Cell {
  readonly value: CellValue;
  /** Введённая формула, если в ячейке она, а не значение. */
  readonly formula?: string;
  /** Явно заданный вид; отсутствует, когда ничего не задано. */
  readonly format?: CellFormat;
  /**
   * Заметка ячейки (Q23) — непустая строка, как её отдал Google; без заметки поля нет. Пишет её
   * кто угодно, кто правит таблицу, поэтому наружу она уходит данными (`content.is-data`).
   */
  readonly note?: string;
}

/** Заметка с адресом ячейки — для карты: «A1» и текст (Q24). */
export interface CellNote {
  readonly cell: string;
  readonly note: string;
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
  /** Строк в сетке листа (`gridProperties.rowCount`) — верхняя граница, а не число данных. */
  readonly gridRows?: number;
}

export interface SpreadsheetSnapshot {
  readonly id: string;
  /**
   * Снимок усечён: читали один лист, а не книгу.
   *
   * Живой прогон 2026-09-04 нашёл следствие: карта показывала `otherSheets: []` на книге
   * из СЕМИ листов, потому что строилась из отфильтрованного снимка. Пустой список
   * читается как «других листов нет» — и на нём же стояла проверка занятого имени листа.
   */
  readonly partial?: boolean;
  /**
   * Читались только первые `rowLimit` строк листа (лёгкая карта, D-26). Лист, на котором
   * столько строк и набралось, может продолжаться — карта обязана сказать это вслух.
   */
  readonly rowLimit?: number;
  readonly title: string;
  readonly revisionId?: string;
  /**
   * Локаль книги, как её отдаёт Google (`ru_RU`, `en_US`). Нужна колонке без своих дат: первая
   * дата в неё пишется видом дат листа, а если их нет — видом локали (Q15), а не ISO.
   */
  readonly locale?: string;
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
  /**
   * Как в колонке записаны даты — чтобы писать в том же виде, а не в своём. У колонки без
   * своих дат (пустой) — вид дат листа, а без них — вид локали книги (Q15); `null` — вида нет.
   */
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
  /**
   * Заметка ячейки шапки (Q24) — часто правило заполнения: «Оценка в часах, если в днях —
   * умножай на 8». Данными с источником, а не голым текстом: заметку пишет кто угодно.
   */
  readonly headerNote?: UntrustedData<string>;
}

/**
 * Колонка без подписи в шапке, но со значениями в строках данных (D-26, Q30). В `columns` её нет —
 * записи по ней нет, — а значения видны: «Лист5» прятал так три подпункта в C9–C11.
 */
export interface UnlabeledColumn {
  readonly letter: string;
  /** 0-based индекс внутри строки. */
  readonly index: number;
  /** Ключ её ячеек в строках `gc_read mode=values`: `(C)`; занят подписью — `((C))`. */
  readonly key: string;
  /** Непустых ячеек в строках данных. */
  readonly filled: number;
  /** Строки листа с ними — от первой до последней: «9–11», одна — «9». */
  readonly rows: string;
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
  /** От A1 до последней строки и колонки со значением или формулой: оформление — не данные (Q31). */
  readonly usedRange: string;
  readonly dataRowCount: number;
  readonly columns: readonly ColumnProfile[];
  readonly sampleRows: readonly Readonly<Record<string, CellValue>>[];
  readonly otherSheets: readonly { readonly title: string; readonly rowCount: number }[];
  /** Строк в сетке листа — верхняя граница; карта строится по первым строкам (D-26). */
  readonly sheetRows?: number;
  /** Заметки строк над шапкой с адресами (Q24), данными; заметок нет — поля нет. */
  readonly notesAboveHeader?: UntrustedData<readonly CellNote[]>;
  /** Колонки без подписи со значениями (Q30); таких нет — поля нет (Q32). */
  readonly unlabeled?: readonly UnlabeledColumn[];
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
  /**
   * Те же строки ячейками по индексу колонки листа — с колонками без подписи и разрывом шапки
   * (Q33, Q34). `rows` и `formats` знают только колонки карты, а строку Google удаляет и
   * сортирует целиком: снимок по ним терял C3 «а) доступы» и писал значения D в C.
   */
  readonly cells: readonly (readonly Cell[])[];
}

export interface ReadOptions {
  /** Читать только этот лист — иначе тянется всё, а это дорого на живых таблицах. */
  readonly sheet?: string;
  /**
   * Только первые `maxRows` строк — для лёгкой карты (D-26). Без него названный лист читается
   * ЦЕЛИКОМ: запись, превью, предусловие и откат считаются по всему листу, а частичное
   * чтение надо попросить явно. Снимок такого чтения несёт `rowLimit`.
   */
  readonly maxRows?: number;
}

/** Окно строк листа для `gc_read mode=values` (D-26): строки — подряд, начиная с `fromRow`. */
export interface RowWindow {
  readonly rows: readonly (readonly Cell[])[];
  /** Строк в сетке листа — по нему судится, есть ли строки дальше окна. */
  readonly gridRows: number;
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
 * листа или диапазона, — а при начале от A оба чтения совпадают. Кончается — последней колонкой
 * строк данных (Q33): Google двигает только ячейки диапазона, остальные остаются на месте.
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

/** Лист книги по метаданным: имя и `sheetId` — тот же номер, что `gid` в ссылке на вкладку. */
export interface SheetTitle {
  readonly title: string;
  readonly sheetId: number;
}

export interface SheetsClient {
  getSpreadsheet(id: string, options?: ReadOptions): Promise<SpreadsheetSnapshot>;
  /** Строки листа с `fromRow` (номер строки листа), не больше `count` — окно чтения. */
  readRows(id: string, sheet: string, fromRow: number, count: number): Promise<RowWindow>;
  /**
   * Только листы книги — имя и `sheetId`, без сетки.
   *
   * Отдельным методом, потому что проверка занятого имени листа не имеет права опираться
   * на карту: карта строится из усечённого снимка, и её `otherSheets` пуст даже когда
   * листов семь (живой прогон 2026-09-04). А полное чтение книги ради имён стоило бы
   * десятков тысяч ячеек. Тем же вызовом лист выбирается по `gid` ссылки (Q27) — до сетки.
   */
  sheetTitles(id: string): Promise<readonly SheetTitle[]>;
  /**
   * Запись значений в A1-диапазон. `input: 'user'` (по умолчанию) — как ввёл бы человек:
   * «2025-06-01» станет датой; `'raw'` — текстом, как есть (D-23, таблица со шапкой).
   */
  /**
   * Несколько ячеек — одним запросом (D-26, Q10): запрос либо записан целиком, либо нет, и
   * повтор после 429 повторяет его весь, а не дописывает хвост.
   */
  batchUpdateValues(
    id: string,
    cells: readonly { readonly range: string; readonly value: CellValue }[],
  ): Promise<void>;
  updateValues(
    id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
    input?: 'user' | 'raw',
  ): Promise<void>;
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
