/**
 * Схема входа `gc_apply` — единственного инструмента, который пишет.
 *
 * Отдельным модулем по гейту длины `tools.ts`, и это не только про строки: описания полей
 * читает МОДЕЛЬ, а не человек, и они часть поверхности продукта наравне с правилами. Их
 * правка меняет поведение при зелёных тестах, поэтому им место в файле, чей дифф видно.
 */

import { z } from 'zod';

import { OPERATION_NAMES, type OperationName } from '../core/ops.js';
import { targetArg } from './target-arg.js';

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
      'Условие отбора строк: им адресуют правку setCells, formatCells, findReplace, ' +
        'insertRows, deleteRows и moveRows. Ключ строки или значение любой колонки; ' +
        'пустое условие у удаления и перемещения отклоняется',
    ),
  values: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Имена колонок → значения (для записи; formatCells их не требует)'),
  columns: z
    .array(z.string().min(1))
    .optional()
    .describe('formatCells: имена колонок, чей вид правим'),
  format: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'formatCells: bold, italic, underline, align (left|center|right), background #RRGGBB',
    ),
  includeHeader: z
    .boolean()
    .optional()
    .describe('formatCells: заодно поправить ячейку заголовка этих колонок'),
  find: z.string().min(1).optional().describe('findReplace: что искать'),
  count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('insertRows/insertColumns: сколько вставить (по умолчанию 1)'),
  below: z
    .boolean()
    .optional()
    .describe('insertRows/insertColumns: вставить ниже (правее) якоря, а не выше'),
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
  replace: z.string().optional().describe('findReplace: на что заменить'),
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
};
