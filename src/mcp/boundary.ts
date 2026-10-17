/**
 * Граница входа инструментов (D-22): проверку делает наш слой, а не SDK.
 *
 * `McpServer` SDK проверял вход сам — и молча срезал незнакомые ключи (через протокол не
 * проходила ни одна правка документа, LR3-5; опечатка `afterHeding` уводила вставку в
 * конец таба), а отказ формы отдавал своим текстом, без `code`, `action` и `correlationId`,
 * мимо аудита. Здесь любой отказ — `bad_request` нашего контракта: незнакомое поле
 * называется с подсказкой, неверный тип — путём и тем, что допустимо.
 */

import { z } from 'zod';

import { gcError } from '../core/errors.js';
import { issuesDetail, unknownFields, unknownFieldsDetail } from '../core/field-check.js';
import type { ToolDefinition, ToolResult } from './deps.js';

/** Строгий разбор по схеме инструмента: незнакомое поле — отказ, умолчания подставлены. */
function strictInput(definition: ToolDefinition, args: Record<string, unknown>) {
  const known = Object.keys(definition.input);
  const unknown = unknownFields(args, known);
  if (unknown.length > 0) {
    throw gcError('bad_request', {
      detail: unknownFieldsDetail(unknown, known, `инструменту ${definition.name}`),
      cause: 'unknown_field',
    });
  }
  const parsed = z.object(definition.input).safeParse(args);
  if (!parsed.success) {
    throw gcError('bad_request', {
      detail: `Запрос ${definition.name} не проходит проверку — ${issuesDetail(parsed.error.issues)}.`,
      cause: 'schema_violation',
    });
  }
  return parsed.data as Record<string, unknown>;
}

/**
 * Вход инструмента после границы. Свой разбор инструмента — когда общая схема судит
 * хуже его собственного: у `gc_apply` поля зависят от операции, и судит их ядро.
 */
export const parseToolInput = (
  definition: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> => (definition.parseInput ?? ((a) => strictInput(definition, a)))(args);

/** Вызов инструмента, которого нет, — тоже ответ нашего контракта, а не текст SDK. */
export const unknownToolResult = (name: string, known: readonly string[]): ToolResult => ({
  ok: false,
  error: gcError('bad_request', {
    detail: `Инструмента «${name}» нет. Есть: ${known.join(', ')}.`,
    cause: 'unknown_tool',
  }).payload,
});
