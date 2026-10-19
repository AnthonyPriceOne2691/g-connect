/**
 * Создание файлов и папок Drive на фасаде: разводка, которой нет места среди операций над
 * таблицей.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: остальные операции начинаются
 * с чтения таблицы, а эта до чтения не доходит вовсе, потому что цель — папка.
 */

import { createFile, type CreateInput, type SheetContent } from '../core/create-op.js';
import { assertCreateTarget, createParentOf, type CreateParent } from '../core/create-parent.js';
import type { parseOperation } from '../core/ops.js';
import type { ResolvedTarget } from '../core/targets.js';
import type { WriteRight } from '../core/write-right.js';
import { applyHint, applyOptions, writeRight } from './apply-support.js';
import type { ToolDeps } from './deps.js';

type CreateOperation = Extract<
  ReturnType<typeof parseOperation>,
  { op: 'createSheet' | 'createDoc' | 'createFolder' }
>;

/**
 * Создание файла или папки: цель — папка, а не таблица (D-26, Q20–Q22).
 *
 * Порядок несущий и закреплён тестами. Вид цели по реестру и ссылке — первым: отказ «не
 * папка» не стоит ни запроса, ни касания. Право — до любого обращения к Google, как у всех
 * записей. Вид голого ID — у Drive, до плана и до создания: прежде здесь цель без известного
 * вида молча становилась корнем «Мой диск». Таблица целью быть не может: «создать рядом с
 * этой таблицей» в Drive не выражается — у файла один родитель.
 */
export async function runCreate(
  operation: CreateOperation,
  resolved: ResolvedTarget,
  deps: ToolDeps,
): Promise<unknown> {
  assertCreateTarget(resolved);
  const right = operation.dryRun === false ? await writeRight(deps, resolved) : undefined;
  const parent = await createParentOf(resolved, () => deps.drive());
  // Вид, который назвал Drive, — вид цели дальше по вызову: у папки ревизию таблицы не
  // спрашивают (живой прогон 2026-10-17: чтение папки как таблицы — 404).
  const folder: ResolvedTarget = { ...resolved, type: 'folder' };
  const outcome = await createFile(
    await deps.sheets(),
    await deps.drive(),
    createInputOf(operation, parent, right),
    applyOptions(deps, folder, operation, right),
  );
  return {
    ...outcome,
    target: { id: resolved.id, alias: resolved.alias },
    hint: applyHint(outcome),
  };
}

const KINDS = { createSheet: 'sheet', createDoc: 'doc', createFolder: 'folder' } as const;

/** Вход создания из операции: вид, имя, папка, содержимое, право писать в созданное. */
function createInputOf(
  operation: CreateOperation,
  parent: CreateParent,
  right: WriteRight | undefined,
): CreateInput {
  const content = contentOf(operation);
  return {
    kind: KINDS[operation.op],
    name: operation.name,
    ...parent,
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
