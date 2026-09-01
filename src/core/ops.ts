/**
 * Схема операций на ВНЕШНЕЙ границе ядра (DESIGN.md §3).
 *
 * Зачем схема, если TypeScript строже: типы живут до компиляции, а от MCP-клиента
 * приходит произвольный JSON. Схема — то место, где «удалиВсё» и `{Часы: {}}`
 * отклоняются с внятным текстом ДО обращения к Google, а не превращаются в
 * `undefined` где-то в середине записи.
 */

import { z } from 'zod';

import { gcError } from './errors.ts';

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

export const operationSchema = z.discriminatedUnion('op', [appendRowOp, upsertRowOp, setCellsOp]);

export type Operation = z.infer<typeof operationSchema>;
export type OperationName = Operation['op'];

export const OPERATION_NAMES: readonly OperationName[] = ['appendRow', 'upsertRow', 'setCells'];

/** Путь ошибки zod в читаемый вид: `values.Часы`, а не `[object Object]`. */
const pathOf = (issue: z.ZodIssue): string =>
  issue.path.length === 0 ? 'корень запроса' : issue.path.join('.');

/**
 * Разбор операции. Ошибка — `bad_request` с перечислением допустимых операций:
 * агент, назвавший операцию неверно, должен узнать список, а не получить «invalid union».
 */
export function parseOperation(input: unknown): Operation {
  const parsed = operationSchema.safeParse(input);
  if (parsed.success) return parsed.data;

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
  throw gcError('bad_request', {
    detail: `Запрос операции «${named}» не проходит проверку — ${problems}.`,
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
