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
