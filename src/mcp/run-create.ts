/**
 * Создание файлов и папок Drive на фасаде: разводка, которой нет места среди операций над
 * таблицей.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: остальные операции начинаются
 * с чтения таблицы, а эта до чтения не доходит вовсе, потому что цель — папка.
 */

import { createFile } from '../core/create-op.js';
import { gcError } from '../core/errors.js';
import type { parseOperation } from '../core/ops.js';
import type { ResolvedTarget } from '../core/targets.js';
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
): Promise<unknown> {
  if (resolved.type !== 'folder' && resolved.alias !== null) {
    throw gcError('bad_request', {
      detail:
        `Цель «${resolved.alias}» — не папка, а ${resolved.type}. Создавать можно в папке: ` +
        'добавь папку в реестр целей с правом записи и назови её.',
      cause: 'create_needs_folder',
    });
  }
  const kind =
    operation.op === 'createSheet' ? 'sheet' : operation.op === 'createDoc' ? 'doc' : 'folder';
  const outcome = await createFile(
    await deps.sheets(),
    await deps.drive(),
    {
      kind,
      name: operation.name,
      ...(resolved.type === 'folder'
        ? { parentId: resolved.id, parentName: resolved.alias ?? resolved.id }
        : {}),
    },
    applyOptions(deps, resolved, operation),
  );
  return {
    ...outcome,
    target: { id: resolved.id, alias: resolved.alias },
    hint: applyHint(outcome),
  };
}
