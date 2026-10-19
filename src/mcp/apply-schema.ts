/**
 * Схема входа `gc_apply` — единственного инструмента, который пишет.
 *
 * Отдельным модулем по гейту длины `tools.ts`, и это не только про строки: описания полей
 * читает МОДЕЛЬ, а не человек, и они часть поверхности продукта наравне с правилами. Их
 * правка меняет поведение при зелёных тестах, поэтому им место в файле, чей дифф видно.
 */

import { z } from 'zod';

import { orJsonText } from '../core/op-fields.js';
import {
  OPERATION_NAMES,
  parseOperation,
  setParagraphStyleOp,
  type Operation,
  type OperationName,
} from '../core/ops.js';
import { rowSpanSchema } from '../core/sheets/row-selection.js';
import { targetArg } from './target-arg.js';

/**
 * Поля операций над документом (уровень 3).
 *
 * Живой прогон 2026-10-02 через протокол: ни одна правка документа не доходила до ядра.
 * SDK MCP собирает из этой схемы `z.object` и молча выбрасывает незнакомые ключи, а
 * doc-полей здесь не было вовсе — `tab`, `text`, `uri` терялись по дороге, и ядро
 * отвечало «text: Required» на запрос, где текст был. Тесты молчали: они зовут обработчик
 * напрямую, мимо схемы транспорта, а проба сверяла с ядром только ИМЕНА операций (L21 —
 * тот же класс, что девять операций из двадцати одной). Оракул теперь сверяет ПОЛЯ:
 * `tests/mcp-transport.test.ts` и `probe_mcp.mjs`.
 *
 * Типы здесь нестрогие намеренно, как у табличных полей: судит ядро, и его отказ —
 * `bad_request` с понятным текстом, а отказ транспорта пришёл бы в формате SDK.
 * Перечисление вида абзаца берётся из ядра — список значений в двух местах разъехался бы.
 */
const docFields = {
  tab: z.string().min(1).optional().describe('Документ: таб по заголовку; без него — единственный'),
  text: z.string().min(1).optional().describe('appendText/insertText: текст НОВОГО абзаца'),
  afterHeading: z
    .string()
    .min(1)
    .optional()
    .describe(
      'appendText: дописать в конец РАЗДЕЛА с этим заголовком (граница — следующий ' +
        'заголовок того же или старшего уровня); без него — в конец таба',
    ),
  uri: z
    .string()
    .min(1)
    .optional()
    .describe(
      'insertInlineImage: https-URL, доступный Google (он скачивает файл сам); локальный ' +
        'путь и file:// отклоняются до обращения к сети',
    ),
  style: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'updateTextStyle: bold, italic, underline, strikethrough, link (URL), fontSize ' +
        '(6–96), color #RRGGBB — частичная правка, остальное не сбрасывается',
    ),
  namedStyle: setParagraphStyleOp.shape.namedStyle
    .optional()
    .describe('setParagraphStyle: вид абзаца — обычный текст или заголовок'),
  // Три смысла у одного имени, как у `columns`: число строк новой таблицы документа, строки
  // новой таблицы Sheets (D-23) и номера строк правки вида (Q13). Без любой из форм транспорт
  // отклонял бы её до ядра. Строка JSON разбирается тем же `orJsonText`, что в ядре (Q19): клиент
  // со старой схемой шлёт форму строкой, а в `tools/list` строки нет — модель видит три формы.
  rows: orJsonText(
    z.union([
      z.number().int().positive(),
      z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
      rowSpanSchema,
    ]),
  )
    .optional()
    .describe(
      'insertTable: число строк (1–50); createSheet: строки новой таблицы — массивы значений ' +
        'в порядке колонок шапки; formatCells: {from, to} — номера строк листа включительно, ' +
        'внутри строк данных (пачка под конверт)',
    ),
  asText: z
    .boolean()
    .optional()
    .describe(
      'createSheet: значения шапки и строк текстом (RAW), по умолчанию да — дата остаётся ' +
        'строкой; false — как набрал бы человек',
    ),
  table: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Таблица документа по номеру из карты (mode=map)'),
  tableWithCell: z
    .string()
    .min(1)
    .optional()
    .describe('Таблица документа по тексту любой её ячейки — вместо table'),
  rowWithCell: z
    .string()
    .min(1)
    .optional()
    .describe('insertTableRow/deleteTableRow: строка таблицы по тексту её ячейки'),
  rowIndex: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('insertTableRow/deleteTableRow: строка таблицы по номеру, с 1'),
  columnTitle: z
    .string()
    .min(1)
    .optional()
    .describe('insertTableColumn/deleteTableColumn: колонка таблицы по тексту ячейки шапки'),
  columnIndex: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('insertTableColumn/deleteTableColumn: колонка таблицы по номеру, с 1'),
  right: z
    .boolean()
    .optional()
    .describe('insertTableColumn: правее колонки-якоря (по умолчанию да)'),
  startIndex: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('deleteRange: начало диапазона — запасной путь, индексы едут при каждой правке'),
  endIndex: z.number().int().positive().optional().describe('deleteRange: конец диапазона'),
};

export const applyInput = {
  /**
   * Операции берутся ИЗ ЯДРА, а не перечисляются здесь.
   *
   * Живой прогон 2026-09-04 нашёл ровно эту дыру: рукописный список отставал от ядра на
   * десять операций, схема транспорта отклоняла их до ядра, а `policy://rules` уверял
   * агента, что они есть. Гейты молчали, потому что тесты звали ядро и типизированную
   * разводку, а схему транспорта с ядром не сверял никто (урок L14: поле, которое одна
   * сторона объявляет, а другая не заполняет, — дыра между двумя наборами оракулов).
   *
   * Приведение к непустому кортежу нужно `zod` и названо здесь: `OPERATION_NAMES`
   * непуст по построению — он и есть источник правды о составе операций.
   */
  op: z.enum(OPERATION_NAMES as unknown as [OperationName, ...OperationName[]]),
  /** Превью файлом: широкую таблицу в терминале не читают (§13.3, ступень 0). */
  report: z.boolean().default(false).describe('Дополнительно записать превью HTML-файлом'),
  target: targetArg,
  sheet: z.string().min(1).optional(),
  headerRow: z.number().int().positive().optional(),
  key: z.record(z.string(), z.unknown()).optional().describe('upsertRow: ключ строки'),
  where: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Таблица: условие отбора строк для setCells, formatCells, findReplace, insertRows, ' +
        'deleteRows и moveRows — ключ строки или значение любой колонки; пустое условие у ' +
        'formatCells, удаления и перемещения отклоняется. Документ: селектор абзаца, ровно ' +
        'один ключ из paragraphIndex (№ из mode=map), textStartsWith, textContains, ' +
        'firstParagraph, lastParagraph',
    ),
  values: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Имена колонок → значения (для записи; formatCells их не требует)'),
  // Два смысла у одного имени: список колонок у таблицы и число колонок у новой таблицы
  // документа. Только список — и `insertTable` отклонялся бы транспортом до ядра.
  columns: z
    .union([z.array(z.string().min(1)), z.number().int().positive()])
    .optional()
    .describe(
      'formatCells/findReplace: имена колонок, чей вид или текст правим; insertTable: ' +
        'число колонок новой таблицы (1–10); createSheet: шапка новой таблицы',
    ),
  format: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'formatCells: bold, italic, underline, align (left|center|right), background #RRGGBB, ' +
        'fontFamily (Carlito), fontSize (целое 6–96), numberFormat {type, pattern} — ' +
        'например {type: DATE, pattern: dd.mm.yyyy}',
    ),
  includeHeader: z
    .boolean()
    .optional()
    .describe(
      'formatCells: заодно поправить ячейку заголовка этих колонок — вместе со строками ' +
        'данных; только шапку — headerOnly: true',
    ),
  allRows: z
    .boolean()
    .optional()
    .describe(
      'formatCells: все строки данных листа — от строки после шапки до последней строки с ' +
        'данными; строки выбирает ровно одно из where, allRows, rows, headerOnly. Конверт ' +
        'судит ячейки плана (до строк × колонок): длинный лист — пачками rows',
    ),
  headerOnly: z
    .boolean()
    .optional()
    .describe(
      'formatCells: только строка шапки — ячейки заголовков названных колонок, без строк ' +
        'данных (фон или шрифт шапки). Строка над шапкой, например название таблицы, не ' +
        'адресуется',
    ),
  find: z
    .string()
    .min(1)
    .optional()
    .describe('findReplace, replaceText, replaceAllText: что искать'),
  count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'insertRows/insertColumns: сколько вставить (по умолчанию 1); стили документа: ' +
        'сколько абзацев подряд от якоря where (по умолчанию 1)',
    ),
  below: z
    .boolean()
    .optional()
    .describe(
      'insertRows/insertColumns: вставить ниже (правее) якоря, а не выше; ' +
        'insertTableRow: ниже строки-якоря (по умолчанию да)',
    ),
  before: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('moveRows: условие на строку, ПЕРЕД которой ставим перемещаемые'),
  descending: z.boolean().optional().describe('sortRange: сортировать по убыванию'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('createSheet/createDoc/createFolder: имя создаваемого файла или папки'),
  title: z.string().min(1).optional().describe('addSheet/renameSheet/duplicateSheet: имя листа'),
  toColumn: z
    .string()
    .min(1)
    .optional()
    .describe('copyRange/cutRange: колонка-получатель по имени'),
  paste: z
    .enum(['all', 'values', 'format'])
    .optional()
    .describe('copyRange/cutRange: что переносить (Ctrl+Shift+V — values)'),
  column: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Колонка по ИМЕНИ. Её едят insertColumns, deleteColumns, sortRange, copyRange, ' +
        'cutRange и autoFill',
    ),
  replace: z
    .string()
    .optional()
    .describe('findReplace, replaceText, replaceAllText: на что заменить'),
  matchCase: z.boolean().optional().describe('findReplace: учитывать регистр'),
  matchEntireCell: z.boolean().optional().describe('findReplace: совпадение по всей ячейке'),
  searchByRegex: z
    .boolean()
    .optional()
    .describe('findReplace: find — регулярное выражение (битое отклоняется до записи)'),
  dryRun: z.boolean().default(true),
  force: z.boolean().default(false),
  confirm: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Подтверждение человека: код плана из превью, а для разрушающих операций — ' +
        'фраза с НАЗВАНИЕМ предмета правки («удаляю строку AutoLink Platform»). ' +
        'Одного «да» недостаточно',
    ),
  planId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Код плана из превью, которое видел человек. У разрушающих правок его прикладываешь ' +
        'ТЫ к фразе человека в confirm: фраза — подпись, код — привязка к показанному плану ' +
        '(повтор фразы после записи второй правки не делает)',
    ),
  expectRevision: z
    .string()
    .min(1)
    .optional()
    .describe('Ревизия для вызовов БЕЗ превью (CLI, раннер): у превью её несёт код плана'),
  ...docFields,
};

/**
 * Поля, которые знает только транспорт: ядру их не передают. Ядро отклоняет незнакомое
 * поле с названием (D-22), поэтому всё, что принадлежит инструменту, а не операции,
 * снимается здесь, в одном месте.
 */
export const TRANSPORT_ONLY_FIELDS = ['report'] as const;

/** Запрос `gc_apply` → операция ядра: без полей транспорта, со строгим разбором ядра. */
export function operationOf(args: Record<string, unknown>): Operation {
  const own = Object.fromEntries(
    Object.entries(args).filter(
      ([key]) => !(TRANSPORT_ONLY_FIELDS as readonly string[]).includes(key),
    ),
  );
  return parseOperation(own);
}
