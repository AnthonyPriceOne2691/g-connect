/**
 * Схема входа `gc_apply` — единственного инструмента, который пишет.
 *
 * Отдельным модулем по гейту длины `tools.ts`, и это не только про строки: описания полей
 * читает МОДЕЛЬ, а не человек, и они часть поверхности продукта наравне с правилами. Их
 * правка меняет поведение при зелёных тестах, поэтому им место в файле, чей дифф видно.
 */

import { z } from 'zod';

import { targetArg } from './target-arg.js';

export const applyInput = {
  op: z.enum([
    'appendRow',
    'upsertRow',
    'setCells',
    'formatCells',
    'findReplace',
    'insertRows',
    'insertColumns',
    'addSheet',
    'renameSheet',
  ]),
  /** Превью файлом: широкую таблицу в терминале не читают (§13.3, ступень 0). */
  report: z.boolean().default(false).describe('Дополнительно записать превью HTML-файлом'),
  target: targetArg,
  sheet: z.string().min(1).optional(),
  headerRow: z.number().int().positive().optional(),
  key: z.record(z.string(), z.unknown()).optional().describe('upsertRow: ключ строки'),
  where: z.record(z.string(), z.unknown()).optional().describe('setCells: условие отбора'),
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
  column: z.string().min(1).optional().describe('insertColumns/deleteColumns: колонка по имени'),
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
  expectRevision: z
    .string()
    .min(1)
    .optional()
    .describe('Ревизия для вызовов БЕЗ превью (CLI, раннер): у превью её несёт код плана'),
};
