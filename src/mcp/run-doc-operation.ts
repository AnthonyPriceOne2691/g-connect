/**
 * Разводка операций над ДОКУМЕНТОМ (уровень 3) — зеркало `run-operation.ts` таблиц.
 *
 * Вид цели решает путь ДО чтения: doc-операция по таблице и табличная по документу —
 * отказ с советом здесь, а не «файл не найден» из глубины не того API (P22).
 */

import { runDocDelete } from '../core/docs/delete-op.js';
import { runDocInsert, type DocApplyOutcome } from '../core/docs/insert-op.js';
import { runDocReplace } from '../core/docs/replace-op.js';
import { runDocStyle } from '../core/docs/style-op.js';
import type { DocTextStyle } from '../core/docs/types.js';
import { runDocTable } from '../core/docs/table-op.js';
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
  const outcome = await dispatchDocOperation(client, snapshot, operation, options);
  return { ...outcome, target: { id: resolved.id, alias: resolved.alias } };
}

/** Разводка по doc-операциям — соответствие семейств, а не логика. */
function dispatchDocOperation(
  client: Awaited<ReturnType<ToolDeps['docs']>>,
  snapshot: Awaited<ReturnType<Awaited<ReturnType<ToolDeps['docs']>>['getDocument']>>,
  operation: DocOperation,
  options: Parameters<typeof runDocInsert>[3],
): Promise<DocApplyOutcome> {
  switch (operation.op) {
    case 'appendText':
    case 'insertText':
    case 'insertPageBreak':
    case 'insertInlineImage':
      return runDocInsert(client, snapshot, insertRequest(operation), options);
    case 'deleteParagraph':
    case 'deleteRange':
      return runDocDelete(client, snapshot, deleteRequest(operation), options);
    case 'replaceText':
    case 'replaceAllText':
      return runDocReplace(client, snapshot, replaceRequest(operation), options);
    default:
      return isStyleOperation(operation)
        ? runDocStyle(client, snapshot, styleRequest(operation), options)
        : runDocTable(client, snapshot, operation, options);
  }
}

type StyleOperation = Extract<
  DocOperation,
  {
    op:
      'updateTextStyle' | 'setParagraphStyle' | 'createParagraphBullets' | 'deleteParagraphBullets';
  }
>;

const isStyleOperation = (operation: DocOperation): operation is StyleOperation =>
  operation.op === 'updateTextStyle' ||
  operation.op === 'setParagraphStyle' ||
  operation.op === 'createParagraphBullets' ||
  operation.op === 'deleteParagraphBullets';

const insertRequest = (
  operation: Extract<
    DocOperation,
    { op: 'appendText' | 'insertText' | 'insertPageBreak' | 'insertInlineImage' }
  >,
): Parameters<typeof runDocInsert>[2] => ({
  op: operation.op,
  tab: operation.tab,
  ...(operation.op === 'appendText'
    ? { text: operation.text, afterHeading: operation.afterHeading }
    : operation.op === 'insertText'
      ? { text: operation.text, where: operation.where }
      : operation.op === 'insertInlineImage'
        ? { uri: operation.uri, where: operation.where }
        : { where: operation.where }),
});

const deleteRequest = (
  operation: Extract<DocOperation, { op: 'deleteParagraph' | 'deleteRange' }>,
): Parameters<typeof runDocDelete>[2] => ({
  op: operation.op,
  tab: operation.tab,
  ...(operation.op === 'deleteParagraph'
    ? { where: operation.where }
    : { startIndex: operation.startIndex, endIndex: operation.endIndex }),
});

const replaceRequest = (
  operation: Extract<DocOperation, { op: 'replaceText' | 'replaceAllText' }>,
): Parameters<typeof runDocReplace>[2] => ({
  op: operation.op,
  tab: operation.tab,
  find: operation.find,
  replace: operation.replace,
  ...(operation.op === 'replaceText' ? { where: operation.where } : {}),
});

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

const styleRequest = (
  operation: Extract<
    DocOperation,
    {
      op:
        | 'updateTextStyle'
        | 'setParagraphStyle'
        | 'createParagraphBullets'
        | 'deleteParagraphBullets';
    }
  >,
): Parameters<typeof runDocStyle>[2] => ({
  op: operation.op,
  tab: operation.tab,
  where: operation.where,
  count: operation.count,
  // Чистка undefined-ключей: exactOptionalPropertyTypes различает «поля нет» и undefined.
  ...(operation.op === 'updateTextStyle' ? { style: cleanStyle(operation.style) } : {}),
  ...(operation.op === 'setParagraphStyle' ? { namedStyle: operation.namedStyle } : {}),
});

const cleanStyle = (style: Record<string, unknown>): DocTextStyle =>
  Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined));
