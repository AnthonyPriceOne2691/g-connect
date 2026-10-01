/**
 * Доменные типы документа. Сознательно НЕ типы `googleapis` — по той же причине, что у
 * таблиц (`sheets/types.ts`): фейк в тестах строится под нужды ядра, а не под форму
 * библиотеки, и 100 % логики карты и селекторов проверяется без сети.
 *
 * Индексы везде — UTF-16 code units, как считает Docs API и как нативно считает
 * JS-строка (`.length`). Суррогатная пара (эмодзи) — 2 юнита. Это контракт шва,
 * закреплённый оракулом на числах из документации (урок L23: семантику шва не
 * предполагаем, а берём из документации и сверяем живым прогоном).
 */

/** Операции над документом, которые видит контур разрешений (уровень 3). */
export type DocOperationKind =
  | 'appendText'
  | 'insertText'
  | 'replaceText'
  | 'deleteParagraph'
  | 'deleteRange'
  | 'deleteTable'
  | 'deleteTableRow'
  | 'deleteTableColumn'
  | 'replaceAllText'
  | 'insertTable'
  | 'insertTableRow'
  | 'insertTableColumn'
  | 'updateTextStyle'
  | 'setParagraphStyle'
  | 'createParagraphBullets'
  | 'deleteParagraphBullets'
  | 'insertPageBreak'
  | 'insertInlineImage';

/** Стиль текстового прогона — только то, что продукт умеет ставить и откатывать. */
export interface DocTextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  /** Ссылка, если прогон — ссылка. */
  readonly link?: string;
  /** Размер в пунктах. */
  readonly fontSize?: number;
  /** Цвет текста как его вводит человек: `#RRGGBB`. */
  readonly color?: string;
}

/**
 * Встроенный объект абзаца: занимает юниты, но текста не несёт. Живьём (2026-10-01)
 * картинка, @-чип человека, чип даты и разрыв страницы — по 1 юниту.
 */
export type DocObjectKind =
  | 'image'
  | 'person'
  | 'date'
  | 'pageBreak'
  | 'columnBreak'
  | 'footnote'
  | 'equation'
  | 'richLink'
  | 'autoText'
  | 'horizontalRule';

/**
 * Знак, которым объект стоит в тексте снимка, — по одному на юнит: индексы ТЕКСТА равны
 * индексам Google. До живого прогона шов объекты пропускал, и всё индексное после
 * картинки или чипа съезжало на юнит (замена задевала соседний символ).
 */
export const OBJECT_MARK = '\uFFFC';

/** Непрерывный кусок текста одного стиля внутри абзаца. */
export interface DocTextRun {
  readonly text: string;
  /** Явно заданный стиль; отсутствует, когда ничего не задано. */
  readonly style?: DocTextStyle;
  /** Объект, а не текст: `text` — знаки OBJECT_MARK по его ширине. */
  readonly object?: DocObjectKind;
}

/**
 * Именованный стиль абзаца. Держим строкой домена, а не enum библиотеки: ядру важны
 * «обычный текст» и уровень заголовка, остальные (TITLE, SUBTITLE) проходят транзитом.
 */
export type ParagraphNamedStyle =
  | 'NORMAL_TEXT'
  | 'TITLE'
  | 'SUBTITLE'
  | 'HEADING_1'
  | 'HEADING_2'
  | 'HEADING_3'
  | 'HEADING_4'
  | 'HEADING_5'
  | 'HEADING_6';

export interface DocParagraph {
  /** Порядковый № абзаца в табе, с 1 — валюта селекторов и карты. */
  readonly index: number;
  /** Начало абзаца в UTF-16 юнитах сегмента (включая). */
  readonly startIndex: number;
  /** Конец абзаца (не включая); включает завершающий `\n`. */
  readonly endIndex: number;
  /** Текст без завершающего `\n`. */
  readonly text: string;
  readonly runs: readonly DocTextRun[];
  readonly namedStyle: ParagraphNamedStyle;
  /** Абзац в списке (буллеты или нумерация). */
  readonly bulleted?: boolean;
  /** Абзац живёт внутри ячейки таблицы (№ таблицы в табе, с 1). */
  readonly inTable?: { readonly table: number; readonly row: number; readonly column: number };
  /** В абзаце есть inline-объект (картинка и т.п.). */
  readonly hasInlineObject?: boolean;
}

export interface DocCellRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface DocTable {
  /** Порядковый № таблицы в табе, с 1. */
  readonly index: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rows: number;
  readonly columns: number;
  /** Плоский текст ячеек: `cells[row][column]`, абзацы ячейки через `\n`. */
  readonly cells: readonly (readonly string[])[];
  /** Границы строк таблицы — адресация вставки/удаления строк. */
  readonly rowRanges: readonly DocCellRange[];
  /** Границы ячеек `cellRanges[row][column]` — адресация текста внутри ячейки. */
  readonly cellRanges: readonly (readonly DocCellRange[])[];
}

export interface DocTab {
  readonly tabId: string;
  readonly title: string;
  /** Абзацы тела таба — верхний уровень И содержимое ячеек таблиц (см. `inTable`). */
  readonly paragraphs: readonly DocParagraph[];
  readonly tables: readonly DocTable[];
  /** Конец тела таба в UTF-16 юнитах — граница для «в конец» и проверок диапазонов. */
  readonly endIndex: number;
}

export interface DocSnapshot {
  readonly docId: string;
  readonly title: string;
  /**
   * Ревизия документа, как её выдаёт Docs API. В отличие от `version` Drive (урок L18)
   * её сверяет СЕРВЕР: `batchUpdate` с `writeControl.requiredRevisionId` отказывает,
   * если документ ушёл. Валидна ограниченное время — протухший план перестраивается.
   */
  readonly revisionId: string;
  readonly tabs: readonly DocTab[];
  /** В документе есть неразрешённые предложения (suggestions) — карта предупреждает. */
  readonly hasSuggestions: boolean;
  /** Сегменты, которые ядро не показывает и не правит; карта называет их числом. */
  readonly headerCount: number;
  readonly footerCount: number;
  readonly footnoteCount: number;
}

/**
 * Доменные запросы записи. Перечень растёт по слайсам; перевод в форму библиотеки —
 * единственная обязанность `google/doc-requests.ts`.
 */
export type DocRequest =
  | {
      readonly kind: 'insertText';
      readonly tabId: string;
      /** UTF-16 позиция вставки в теле таба. */
      readonly at: number;
      readonly text: string;
    }
  | {
      readonly kind: 'deleteRange';
      readonly tabId: string;
      readonly startIndex: number;
      readonly endIndex: number;
    }
  | {
      readonly kind: 'updateTextStyle';
      readonly tabId: string;
      readonly startIndex: number;
      readonly endIndex: number;
      readonly style: DocTextStyle;
      /**
       * Стиль ТОЧНЫЙ: управляемые поля, которых нет в `style`, сбрасываются (маска
       * `fields` перечисляет все — так Google велит сбрасывать). Нужен восстановлению:
       * вставленный текст наследует стиль соседа, а «не задано» ≠ явный `false`.
       */
      readonly exact?: true;
    }
  | {
      readonly kind: 'updateParagraphStyle';
      readonly tabId: string;
      readonly startIndex: number;
      readonly endIndex: number;
      readonly namedStyle: ParagraphNamedStyle;
    }
  | {
      readonly kind: 'setBullets';
      readonly tabId: string;
      readonly startIndex: number;
      readonly endIndex: number;
      readonly bulleted: boolean;
    }
  | {
      readonly kind: 'insertTable';
      readonly tabId: string;
      /** Позиция вставки; таблица встаёт СЛЕДУЮЩИМ блоком после абзаца с этой точкой. */
      readonly at: number;
      readonly rows: number;
      readonly columns: number;
    }
  | {
      readonly kind: 'insertTableRow';
      readonly tabId: string;
      /** startIndex таблицы — так её адресует Docs API. */
      readonly tableStart: number;
      readonly rowIndex: number;
      readonly below: boolean;
    }
  | {
      readonly kind: 'insertTableColumn';
      readonly tabId: string;
      readonly tableStart: number;
      readonly columnIndex: number;
      readonly right: boolean;
    }
  | {
      readonly kind: 'deleteTableRow';
      readonly tabId: string;
      readonly tableStart: number;
      readonly rowIndex: number;
    }
  | {
      readonly kind: 'deleteTableColumn';
      readonly tabId: string;
      readonly tableStart: number;
      readonly columnIndex: number;
    }
  | {
      readonly kind: 'insertPageBreak';
      readonly tabId: string;
      readonly at: number;
    }
  | {
      readonly kind: 'insertInlineImage';
      readonly tabId: string;
      readonly at: number;
      /** URL, доступный Google: картинку скачивает он сам в момент вставки. */
      readonly uri: string;
    };

/** Абзац внутри снимка: где начинается (юниты от начала снимка) и чем был. */
export interface SnapshotParagraph {
  readonly offset: number;
  readonly namedStyle: ParagraphNamedStyle;
  readonly bulleted?: boolean;
}

/** Снимок текста «до» — им откат восстанавливает удалённое: текст, стили, вид абзацев. */
export interface DocRangeSnapshot {
  readonly tab: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly runs: readonly DocTextRun[];
  /** Стили абзацев снимка — без них восстановленный заголовок стал бы обычным текстом. */
  readonly paragraphs?: readonly SnapshotParagraph[];
}

/** Шов с Docs API: чтение и запись под серверным предусловием. */
export interface DocsClient {
  getDocument(id: string): Promise<DocSnapshot>;
  /**
   * Запись пакета правок. `requiredRevisionId` обязателен по построению: запись без
   * предусловия в этом ядре не существует. Несовпадение ревизии — отказ `doc_changed`
   * ОТ СЕРВЕРА, ни одной правки. Возвращает ревизию после записи.
   */
  batchUpdate(
    id: string,
    requests: readonly DocRequest[],
    requiredRevisionId: string,
  ): Promise<{ revisionId: string }>;
}
