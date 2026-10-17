/**
 * Создание файлов и папок Drive на фасаде: разводка, которой нет места среди операций над
 * таблицей.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: остальные операции начинаются
 * с чтения таблицы, а эта до чтения не доходит вовсе, потому что цель — папка.
 */

import { createFile, type CreateInput, type SheetContent } from '../core/create-op.js';
import { gcError } from '../core/errors.js';
import type { parseOperation } from '../core/ops.js';
import { MY_DRIVE_ID, type ResolvedTarget } from '../core/targets.js';
import type { WriteRight } from '../core/write-right.js';
import { applyHint, applyOptions } from './apply-support.js';
import type { ToolDeps } from './deps.js';

/**
 * Создание файла или папки: цель — папка реестра, а не таблица.
 *
 * Таблица целью быть не может: «создать рядом с этой таблицей» в Drive не выражается — у
 * файла один родитель, и его id мы бы всё равно спрашивали у Drive. Поэтому отказ прямой,
 * со списком того, что делать.
 */
export async function runCreate(
  operation: Extract<
    ReturnType<typeof parseOperation>,
    { op: 'createSheet' | 'createDoc' | 'createFolder' }
  >,
  resolved: ResolvedTarget,
  deps: ToolDeps,
  right?: WriteRight,
): Promise<unknown> {
  if (resolved.type !== 'folder' && resolved.alias !== null) {
    throw gcError('bad_request', {
      detail:
        `Цель «${resolved.alias}» — не папка, а ${resolved.type}. Создавать можно в папке: ` +
        'добавь папку в реестр целей с правом записи и назови её.',
      cause: 'create_needs_folder',
    });
  }
  const outcome = await createFile(
    await deps.sheets(),
    await deps.drive(),
    createInputOf(operation, resolved, right),
    applyOptions(deps, resolved, operation, right),
  );
  return {
    ...outcome,
    target: { id: resolved.id, alias: resolved.alias },
    hint: applyHint(outcome),
  };
}

type CreateOperation = Extract<
  ReturnType<typeof parseOperation>,
  { op: 'createSheet' | 'createDoc' | 'createFolder' }
>;

const KINDS = { createSheet: 'sheet', createDoc: 'doc', createFolder: 'folder' } as const;

/** Вход создания из операции: вид, имя, папка, содержимое, право писать в созданное. */
function createInputOf(
  operation: CreateOperation,
  resolved: ResolvedTarget,
  right: WriteRight | undefined,
): CreateInput {
  const parentName = resolved.id === MY_DRIVE_ID ? 'Мой диск' : (resolved.alias ?? resolved.id);
  const content = contentOf(operation);
  return {
    kind: KINDS[operation.op],
    name: operation.name,
    ...(resolved.type === 'folder' ? { parentId: resolved.id, parentName } : {}),
    ...(content === undefined ? {} : { content }),
    writable: right?.via === 'grant',
  };
}

/** Шапка и строки — только у таблицы и только если названы (D-23, X7). */
function contentOf(operation: CreateOperation): SheetContent | undefined {
  if (operation.op !== 'createSheet') return undefined;
  if (operation.columns === undefined && operation.rows === undefined) return undefined;
  return {
    ...(operation.columns === undefined ? {} : { columns: operation.columns }),
    ...(operation.rows === undefined ? {} : { rows: operation.rows }),
    asText: operation.asText,
  };
}
