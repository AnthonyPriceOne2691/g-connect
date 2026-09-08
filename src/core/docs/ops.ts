/**
 * Схемы операций над ДОКУМЕНТОМ на внешней границе ядра (уровень 3).
 *
 * Отдельным модулем по гейту длины `ops.ts` — и по делу: словарь документных операций
 * растёт своим темпом. Общие поля — из `op-fields.ts`, единого низа обеих половин.
 */

import { z } from 'zod';

import { commonFields } from '../op-fields.js';

/**
 * Селектор абзаца документа (§4): агент говорит ЧТО, ядро вычисляет ГДЕ. Ровно один
 * ключ; `.strict()` — чтобы «paragrafIndex» отклонялся с перечислением, а не молчал.
 */
const docWhere = z
  .object({
    paragraphIndex: z.number().int().positive().optional(),
    textStartsWith: z.string().min(1).optional(),
    textContains: z.string().min(1).optional(),
    firstParagraph: z.literal(true).optional(),
    lastParagraph: z.literal(true).optional(),
  })
  .strict();

/** Общее у операций над документом: таб по заголовку (без него — единственный). */
const docCommonFields = {
  tab: z.string().min(1).optional(),
  ...commonFields,
};

/** Дописать НОВЫЙ абзац: в конец таба, а с `afterHeading` — в конец его раздела. */
export const appendTextOp = z.object({
  op: z.literal('appendText'),
  text: z.string().min(1),
  afterHeading: z.string().min(1).optional(),
  ...docCommonFields,
});

/** Вставить НОВЫЙ абзац сразу после абзаца-якоря. */
export const insertTextOp = z.object({
  op: z.literal('insertText'),
  text: z.string().min(1),
  where: docWhere,
  ...docCommonFields,
});

/** Удалить абзац по селектору. Разрушающая: подтверждение — названием предмета (D-20). */
export const deleteParagraphOp = z.object({
  op: z.literal('deleteParagraph'),
  where: docWhere,
  ...docCommonFields,
});

/** Удалить явный диапазон — escape hatch §4; индексы едут, основной путь — селекторы. */
export const deleteRangeOp = z.object({
  op: z.literal('deleteRange'),
  startIndex: z.number().int().positive(),
  endIndex: z.number().int().positive(),
  ...docCommonFields,
});

/** Замена в пределах одного абзаца — конвертная, масштаб виден в превью. */
export const replaceTextOp = z.object({
  op: z.literal('replaceText'),
  where: docWhere,
  find: z.string().min(1),
  replace: z.string(),
  ...docCommonFields,
});

/** Массовая замена по табу или документу. Разрушающая: подтверждение — названием (D-20). */
export const replaceAllTextOp = z.object({
  op: z.literal('replaceAllText'),
  find: z.string().min(1),
  replace: z.string(),
  ...docCommonFields,
});

/** Адресация таблицы: номер из карты или якорь по содержимому ячейки. */
const tableFields = {
  table: z.number().int().positive().optional(),
  tableWithCell: z.string().min(1).optional(),
};

/** Вставить пустую таблицу после абзаца-якоря (без якоря — в конец таба). */
export const insertTableOp = z.object({
  op: z.literal('insertTable'),
  rows: z.number().int().min(1).max(50),
  columns: z.number().int().min(1).max(10),
  where: docWhere.optional(),
  ...docCommonFields,
});

/** Вставить строку рядом со строкой-якорем (по умолчанию — ниже). */
export const insertTableRowOp = z.object({
  op: z.literal('insertTableRow'),
  rowWithCell: z.string().min(1).optional(),
  rowIndex: z.number().int().positive().optional(),
  below: z.boolean().default(true),
  ...tableFields,
  ...docCommonFields,
});

/** Вставить колонку рядом с колонкой-якорем (по умолчанию — правее). */
export const insertTableColumnOp = z.object({
  op: z.literal('insertTableColumn'),
  columnTitle: z.string().min(1).optional(),
  columnIndex: z.number().int().positive().optional(),
  right: z.boolean().default(true),
  ...tableFields,
  ...docCommonFields,
});

/** Удалить строку. Разрушающая: подтверждение — названием предмета (D-20). */
export const deleteTableRowOp = z.object({
  op: z.literal('deleteTableRow'),
  rowWithCell: z.string().min(1).optional(),
  rowIndex: z.number().int().positive().optional(),
  ...tableFields,
  ...docCommonFields,
});

/** Удалить колонку. Разрушающая. */
export const deleteTableColumnOp = z.object({
  op: z.literal('deleteTableColumn'),
  columnTitle: z.string().min(1).optional(),
  columnIndex: z.number().int().positive().optional(),
  ...tableFields,
  ...docCommonFields,
});

/** Удалить таблицу целиком. Разрушающая. */
export const deleteTableOp = z.object({
  op: z.literal('deleteTable'),
  ...tableFields,
  ...docCommonFields,
});

/** Вид текста на внешней границе — strict: неизвестное поле отклоняется с перечислением. */
const docTextStyle = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    link: z.string().url().optional(),
    fontSize: z.number().int().min(6).max(96).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'цвет задаётся как #RRGGBB')
      .optional(),
  })
  .strict();

/** Общее у стилевых операций: якорный абзац и сколько абзацев подряд (P12). */
const styleCommonFields = {
  where: docWhere,
  count: z.number().int().min(1).max(50).default(1),
  ...docCommonFields,
};

/** Вид текста абзаца (частичная правка: {bold} не сбрасывает остальное). */
export const updateTextStyleOp = z.object({
  op: z.literal('updateTextStyle'),
  style: docTextStyle,
  ...styleCommonFields,
});

/** Вид абзаца: обычный текст или заголовок. */
export const setParagraphStyleOp = z.object({
  op: z.literal('setParagraphStyle'),
  namedStyle: z.enum([
    'NORMAL_TEXT',
    'HEADING_1',
    'HEADING_2',
    'HEADING_3',
    'HEADING_4',
    'HEADING_5',
    'HEADING_6',
  ]),
  ...styleCommonFields,
});

export const createParagraphBulletsOp = z.object({
  op: z.literal('createParagraphBullets'),
  ...styleCommonFields,
});

export const deleteParagraphBulletsOp = z.object({
  op: z.literal('deleteParagraphBullets'),
  ...styleCommonFields,
});
