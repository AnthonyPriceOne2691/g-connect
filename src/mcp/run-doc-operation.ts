/**
 * Разводка операций над ДОКУМЕНТОМ (уровень 3) — зеркало `run-operation.ts` таблиц.
 *
 * Вид цели решает путь ДО чтения: doc-операция по таблице и табличная по документу —
 * отказ с советом здесь, а не «файл не найден» из глубины не того API (P22).
 */

import { runDocDelete } from '../core/docs/delete-op.js';
import { runDocInsert, type DocApplyOutcome } from '../core/docs/insert-op.js';
import { undoDocLast } from '../core/undo-docs.js';
import type { UndoOutcome } from '../core/undo-types.js';
import { gcError } from '../core/errors.js';
import { DOC_OPERATION_NAMES, type DocOperation, type Operation } from '../core/ops.js';
import type { ResolvedTarget } from '../core/targets.js';
import type { ToolDeps } from './deps.js';
import { envelopeJudge } from './apply-support.js';

export const isDocOperation = (operation: Operation): operation is DocOperation =>
  DOC_OPERATION_NAMES.includes(operation.op);

/** Отказ по виду цели: названы обе стороны — что просили и что умеет эта цель. */
export function assertTargetKind(operation: Operation, resolved: ResolvedTarget): void {
  const docOp = isDocOperation(operation);
  if (docOp && resolved.type === 'sheet') {
    throw gcError('bad_request', {
      detail:
        `${operation.op} правит документ, а цель «${resolved.alias ?? resolved.id}» — таблица. ` +
        'Для таблиц: appendRow, upsertRow, setCells и остальные табличные операции.',
    });
  }
  if (!docOp && resolved.type === 'doc') {
    throw gcError('bad_request', {
      detail:
        `${operation.op} правит таблицу, а цель «${resolved.alias ?? resolved.id}» — документ. ` +
        `Для документов: ${DOC_OPERATION_NAMES.join(', ')}.`,
    });
  }
}

export async function runDocApply(
  operation: DocOperation,
  resolved: ResolvedTarget,
  deps: ToolDeps,
): Promise<DocApplyOutcome & { target: { id: string; alias: string | null } }> {
  const client = await deps.docs();
  const snapshot = await client.getDocument(resolved.id);
  const options = {
    dryRun: operation.dryRun,
    journal: deps.journal,
    journalSource: deps.journalSource,
    account: deps.account,
    alias: resolved.alias,
    ...(operation.confirm === undefined ? {} : { confirm: operation.confirm }),
    force: operation.force,
    authorize: envelopeJudge(resolved),
  };
  const outcome =
    operation.op === 'appendText' || operation.op === 'insertText'
      ? await runDocInsert(
          client,
          snapshot,
          {
            op: operation.op,
            text: operation.text,
            tab: operation.tab,
            ...(operation.op === 'appendText'
              ? { afterHeading: operation.afterHeading }
              : { where: operation.where }),
          },
          options,
        )
      : await runDocDelete(
          client,
          snapshot,
          {
            op: operation.op,
            tab: operation.tab,
            ...(operation.op === 'deleteParagraph'
              ? { where: operation.where }
              : { startIndex: operation.startIndex, endIndex: operation.endIndex }),
          },
          options,
        );
  return { ...outcome, target: { id: resolved.id, alias: resolved.alias } };
}

/**
 * Откат по doc-цели. Без табличного `deps.revision`: ревизии документа отдаёт сам
 * Docs API — «до» из снимка, «после» из ответа записи (см. undo-docs.ts).
 */
export async function runDocUndo(
  deps: ToolDeps,
  resolved: ResolvedTarget,
  input: { force?: boolean | undefined; record?: string | undefined },
): Promise<UndoOutcome> {
  const docs = await deps.docs();
  return undoDocLast(docs, resolved.id, deps.journalSource, {
    account: deps.account,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.record === undefined ? {} : { correlationId: input.record }),
    journal: deps.journal,
  });
}
