/**
 * Поля вида ячейки на внешней границе (`formatCells`) — модуль-низ, как `op-fields.ts`, и по
 * гейту длины `ops.ts`: с D-26 (Q12) вид получил гарнитуру, кегль и формат числа, и у каждого
 * свой отказ человеческим текстом — агент должен узнать, ЧТО не так, а не «invalid_type».
 */

import { z } from 'zod';

import { NUMBER_FORMAT_TYPES } from './sheets/number-format.js';

/** `null` — слово отката (сброс к виду листа, D-26): правка его не пишет, и отказ это называет. */
const NO_NULL = 'null (сброс к виду листа) пишет только откат';

/** Кегль — целые пункты, как в меню Google: дробный и вне 6–96 отклоняется этим текстом. */
const FONT_SIZE = 'кегль — целое число пунктов от 6 до 96';
const FONT_FAMILY = 'гарнитура — имя шрифта до 100 знаков: Carlito, Arial';
const PATTERN = 'шаблон — до 100 знаков: dd.mm.yyyy или #,##0.00';

/**
 * Формат числа: тип Google и шаблон — `{type: 'DATE', pattern: 'dd.mm.yyyy'}`. Без шаблона
 * Google берёт вид типа по локали книги. `.strict()` — по той же причине, что у вида:
 * `{patern: …}` молча не сделал бы ничего.
 */
const numberFormat = z
  .object(
    {
      type: z.enum(NUMBER_FORMAT_TYPES),
      pattern: z.string().min(1, PATTERN).max(100, PATTERN).optional(),
    },
    { invalid_type_error: `формат числа — объект {type, pattern}; ${NO_NULL}` },
  )
  .strict();

/**
 * Вид ячейки на внешней границе. `.strict()` не косметика: `{strikethrough: true}` должен
 * отклоняться С ПЕРЕЧИСЛЕНИЕМ допустимых полей (пример V11), а не проходить в никуда —
 * иначе агент будет уверен, что текст зачёркнут.
 *
 * `null` у шрифта, кегля и формата числа здесь НЕ принимается, хотя домен его знает: это слово
 * отката — «сбросить к виду листа», — а не правки (D-26).
 */
export const cellFormat = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'цвет задаётся как #RRGGBB')
      .optional(),
    fontFamily: z
      .string({ invalid_type_error: `${FONT_FAMILY}; ${NO_NULL}` })
      .trim()
      .min(1, FONT_FAMILY)
      .max(100, FONT_FAMILY)
      .optional(),
    fontSize: z
      .number({ invalid_type_error: `${FONT_SIZE}; ${NO_NULL}` })
      .int(FONT_SIZE)
      .min(6, FONT_SIZE)
      .max(96, FONT_SIZE)
      .optional(),
    numberFormat: numberFormat.optional(),
  })
  .strict();

/** Допустимые поля вида — из самой схемы, а не вторым списком (урок L21). */
export const FORMAT_FIELDS: readonly string[] = Object.keys(cellFormat.shape);
