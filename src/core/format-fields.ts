/**
 * Поля вида ячейки на внешней границе (`formatCells`) — модуль-низ, как `op-fields.ts`, и по
 * гейту длины `ops.ts`: с D-26 (Q12) вид получил гарнитуру, кегль и формат числа, с Q16 и Q18 —
 * снятие заливки и цвет текста, с Q41 — сброс формата числа, и у каждого свой отказ человеческим
 * текстом — агент должен узнать, ЧТО не так, а не «invalid_type».
 */

import { z } from 'zod';

import { NUMBER_FORMAT_TYPES } from './sheets/number-format.js';

/** `null` — слово отката (сброс к виду листа, D-26): правка его не пишет, и отказ это называет. */
const NO_NULL = 'null (сброс к виду листа) пишет только откат';

/** Кегль — целые пункты, как в меню Google: дробный и вне 6–96 отклоняется этим текстом. */
const FONT_SIZE = 'кегль — целое число пунктов от 6 до 96';
const FONT_FAMILY = 'гарнитура — имя шрифта до 100 знаков: Carlito, Arial';

/**
 * Формат числа объектом: тип Google и шаблон — `{type: 'DATE', pattern: 'dd.mm.yyyy'}`. Без
 * шаблона Google берёт вид типа по локали книги. `.strict()` — по той же причине, что у вида:
 * `{patern: …}` молча не сделал бы ничего. Схема и тексты строятся на разборе, а не на уровне
 * модуля: мутант кода уровня модуля Stryker судит всем набором тестов (урок бюджета D-26).
 */
function numberFormatObject() {
  const pattern = 'шаблон — до 100 знаков: dd.mm.yyyy или #,##0.00';
  return z
    .object(
      {
        type: z.enum(NUMBER_FORMAT_TYPES),
        pattern: z.string().min(1, pattern).max(100, pattern).optional(),
      },
      {
        invalid_type_error:
          `формат числа — объект {type, pattern} или "none" (формат листа, «автоматический»); ` +
          NO_NULL,
      },
    )
    .strict();
}

/**
 * Формат числа на границе (Q41): объект или слово `"none"` — формат листа, «автоматический». В
 * домен `"none"` уходит `null` — сброс тем же путём, что у фона и цвета текста: поле в маске
 * `repeatCell` без значения. Строка задачи, вставленная над днём ежедневного отчёта, унаследовала
 * DATE и TIME, и вернуть «автоматический» было нечем. Объект судит прежняя строгая схема, и её
 * отказы — тип вне списка, опечатка в поле — доходят до агента прежними путями и текстом; `null`,
 * как и у шрифта, — слово отката, а не правки.
 */
function numberFormatOrNone() {
  return z
    .unknown()
    .transform((value, context) => {
      if (value === 'none') return null;
      const parsed = numberFormatObject().safeParse(value);
      if (parsed.success) return parsed.data;
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    })
    .optional();
}

/**
 * Цвет на границе (Q16, Q18): `#RRGGBB` или слово `"none"` — «без заливки» у фона, «цвет листа» у
 * текста. В домен `"none"` уходит `null` — сброс к виду листа, тем же словом, каким откат снимает
 * шрифт (D-26): белый `#ffffff` — не «без заливки», он прячет сетку. Любая другая строка, `null`
 * и не строка — отказ текстом `refusal`. Регулярка — внутри проверки, а не на уровне модуля:
 * мутант кода уровня модуля Stryker судит всем набором тестов (урок бюджета D-26).
 */
function colorOrNone(refusal: string) {
  return z
    .unknown()
    .superRefine((value, context) => {
      const hex = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
      if (hex || value === 'none') return;
      context.addIssue({ code: z.ZodIssueCode.custom, message: refusal });
    })
    .transform((value) => (value === 'none' ? null : (value as string)))
    .optional();
}

/**
 * Вид ячейки на внешней границе. `.strict()` не косметика: `{strikethrough: true}` должен
 * отклоняться С ПЕРЕЧИСЛЕНИЕМ допустимых полей (пример V11), а не проходить в никуда —
 * иначе агент будет уверен, что текст зачёркнут.
 *
 * `null` у шрифта, кегля и формата числа здесь НЕ принимается, хотя домен его знает: это слово
 * отката — «сбросить к виду листа», — а не правки (D-26). Фон, цвет текста и формат числа к виду
 * листа возвращает слово `"none"` (Q16, Q18, Q41). Новое поле дописывается в конец: порядок ключей
 * — это порядок перечисления допустимых полей в отказе.
 */
export const cellFormat = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    background: colorOrNone('фон — #RRGGBB или "none" (без заливки)'),
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
    numberFormat: numberFormatOrNone(),
    textColor: colorOrNone('цвет текста — #RRGGBB или "none" (цвет листа)'),
  })
  .strict();

/** Допустимые поля вида — из самой схемы, а не вторым списком (урок L21). */
export const FORMAT_FIELDS: readonly string[] = Object.keys(cellFormat.shape);
