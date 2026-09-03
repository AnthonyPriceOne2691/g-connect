/**
 * Схема операций на ВНЕШНЕЙ границе ядра (DESIGN.md §3).
 *
 * Зачем схема, если TypeScript строже: типы живут до компиляции, а от MCP-клиента
 * приходит произвольный JSON. Схема — то место, где «удалиВсё» и `{Часы: {}}`
 * отклоняются с внятным текстом ДО обращения к Google, а не превращаются в
 * `undefined` где-то в середине записи.
 */

import { z } from 'zod';

import { gcError } from './errors.js';
import type { CellFormat } from './sheets/types.js';

/** Значение ячейки, как его может прислать клиент. */
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Имена колонок — ключи; значения примитивны. Объект в ячейку не пишется (§8.3). */
const rowValues = z.record(z.string().min(1), cellValue);

const commonFields = {
  /** alias реестра, ссылка или ID. */
  target: z.string().min(1),
  sheet: z.string().min(1).optional(),
  /** 1-based строка заголовков, если эвристику надо переопределить. */
  headerRow: z.number().int().positive().max(1000).optional(),
  /** По умолчанию НЕ пишем (§11.1). */
  dryRun: z.boolean().default(true),
  /** Осознанное подтверждение записи в формульную или защищённую колонку. */
  force: z.boolean().default(false),
  /**
   * Код плана из превью — подпись человека под КОНКРЕТНОЙ правкой (D-16). Запись без него
   * не проходит: «пиши» без кода означает «пиши что-нибудь», а между превью и записью план
   * мог измениться.
   */
  confirm: z.string().min(1).optional(),
  /** Ревизия, на которой строилась карта: защита от гонки с живой правкой. */
  expectRevision: z.string().min(1).optional(),
};

export const appendRowOp = z.object({
  op: z.literal('appendRow'),
  values: rowValues,
  ...commonFields,
});

export const upsertRowOp = z.object({
  op: z.literal('upsertRow'),
  key: rowValues,
  values: rowValues,
  ...commonFields,
});

export const setCellsOp = z.object({
  op: z.literal('setCells'),
  where: rowValues,
  values: rowValues,
  ...commonFields,
});

/**
 * Вид ячейки на внешней границе. `.strict()` не косметика: `{fontSize: 14}` должен
 * отклоняться С ПЕРЕЧИСЛЕНИЕМ допустимых полей (пример V11), а не проходить в никуда —
 * иначе агент будет уверен, что размер шрифта поменялся.
 */
const cellFormat = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'цвет задаётся как #RRGGBB')
      .optional(),
  })
  .strict();

export const FORMAT_FIELDS: readonly string[] = [
  'bold',
  'italic',
  'underline',
  'align',
  'background',
];

export const formatCellsOp = z.object({
  op: z.literal('formatCells'),
  /** Какие строки: то же условие, что у `setCells` — по ключу или по любой колонке. */
  where: rowValues,
  /** Какие колонки — по именам, а не по буквам: колонки переставляют (§5). */
  columns: z.array(z.string().min(1)).min(1),
  /**
   * Правка частичная: `{bold: true}` не сбрасывает выравнивание и фон.
   *
   * `transform` убирает ключи со значением `undefined`: при `exactOptionalPropertyTypes`
   * `{bold: undefined}` и «поля нет» — разные типы, и чистка обязана быть на границе, а не
   * в ядре. Домен от этого остаётся строгим.
   */
  format: cellFormat
    .refine((f) => Object.values(f).some((v) => v !== undefined), 'не задано ни одного поля вида')
    .transform(
      (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as CellFormat,
    ),
  /** Заодно поправить ячейку заголовка этих колонок — «сделай шапку жирной». */
  includeHeader: z.boolean().default(false),
  ...commonFields,
});

/**
 * Поиск и замена (§6.1, Ctrl+F/Ctrl+H). Область — лист или перечисленные колонки.
 *
 * Регулярное выражение проверяется ЗДЕСЬ, на границе: битое выражение должно отклоняться
 * до обращения к Google и до построения плана (пример V10), а не падать в середине.
 */
export const findReplaceOp = z.object({
  op: z.literal('findReplace'),
  find: z.string().min(1),
  replace: z.string(),
  /** Ограничить область колонками; без этого — весь лист. */
  columns: z.array(z.string().min(1)).optional(),
  matchCase: z.boolean().default(false),
  matchEntireCell: z.boolean().default(false),
  searchByRegex: z.boolean().default(false),
  ...commonFields,
});

export const operationSchema = z.discriminatedUnion('op', [
  appendRowOp,
  upsertRowOp,
  setCellsOp,
  formatCellsOp,
  findReplaceOp,
]);

export type Operation = z.infer<typeof operationSchema>;
export type OperationName = Operation['op'];

export const OPERATION_NAMES: readonly OperationName[] = [
  'appendRow',
  'upsertRow',
  'setCells',
  'formatCells',
  'findReplace',
];

/**
 * Битое регулярное выражение — отказ на границе, а не падение в середине плана (V10).
 *
 * Проверка здесь, а не в схеме: `superRefine` возвращает `ZodEffects`, которому нет места
 * в `discriminatedUnion`, а разбор операции и есть граница ядра.
 */
function assertUsableRegex(operation: Operation): void {
  if (operation.op !== 'findReplace' || !operation.searchByRegex) return;
  try {
    new RegExp(operation.find);
  } catch (error) {
    throw gcError('bad_request', {
      detail:
        `Регулярное выражение «${operation.find}» не разбирается: ` +
        `${error instanceof Error ? error.message : 'ошибка разбора'}. Ни одной замены не сделано.`,
      cause: 'bad_regex',
    });
  }
}

/** Путь ошибки zod в читаемый вид: `values.Часы`, а не `[object Object]`. */
const pathOf = (issue: z.ZodIssue): string =>
  issue.path.length === 0 ? 'корень запроса' : issue.path.join('.');

/**
 * Разбор операции. Ошибка — `bad_request` с перечислением допустимых операций:
 * агент, назвавший операцию неверно, должен узнать список, а не получить «invalid union».
 */
export function parseOperation(input: unknown): Operation {
  const parsed = operationSchema.safeParse(input);
  if (parsed.success) {
    assertUsableRegex(parsed.data);
    return parsed.data;
  }

  const named = (input as { op?: unknown } | null)?.op;
  const unknownOp = typeof named !== 'string' || !OPERATION_NAMES.includes(named as OperationName);

  if (unknownOp) {
    throw gcError('bad_request', {
      detail:
        (typeof named === 'string' && named !== ''
          ? `Операции «${named}» нет. `
          : 'Не указана операция. ') + `Допустимы: ${OPERATION_NAMES.join(', ')}.`,
      cause: 'unknown_operation',
    });
  }

  const problems = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${pathOf(issue)}: ${issue.message}`)
    .join('; ');
  // «Unrecognized key fontSize» говорит, чего НЕЛЬЗЯ, и молчит о том, что можно — агент
  // после такого ответа угадывает. Список допустимых полей вида дописывается явно
  // (пример V11): узнать его иначе неоткуда, схема вида в `tools/list` вложенная.
  const aboutFormat = parsed.error.issues.some((issue) => issue.path[0] === 'format');
  throw gcError('bad_request', {
    detail:
      `Запрос операции «${named}» не проходит проверку — ${problems}.` +
      (aboutFormat ? ` Допустимые поля вида: ${FORMAT_FIELDS.join(', ')}.` : ''),
    cause: 'schema_violation',
  });
}

/** JSON-схема для `tools/list`: генерируется ИЗ zod, а не пишется вторым текстом. */
export function operationJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['op', 'target'],
    properties: {
      op: { type: 'string', enum: [...OPERATION_NAMES], description: 'Что делать со строками' },
      target: { type: 'string', description: 'alias реестра, ссылка на таблицу или её ID' },
      sheet: { type: 'string', description: 'Имя листа; без него берётся первый' },
      headerRow: { type: 'integer', minimum: 1, description: 'Переопределить строку заголовков' },
      key: {
        type: 'object',
        description: 'upsertRow: ключ строки по именам колонок',
        additionalProperties: true,
      },
      where: {
        type: 'object',
        description: 'setCells: условие отбора строк по именам колонок',
        additionalProperties: true,
      },
      values: {
        type: 'object',
        description: 'Что записать: имена колонок → значения',
        additionalProperties: true,
      },
      dryRun: {
        type: 'boolean',
        default: true,
        description: 'true (по умолчанию) — вернуть план, ничего не записывая',
      },
      force: {
        type: 'boolean',
        default: false,
        description: 'Осознанно писать в формульную или защищённую колонку',
      },
      expectRevision: {
        type: 'string',
        description: 'Ревизия из gc_read: запись отклоняется, если таблица изменилась',
      },
    },
  };
}
