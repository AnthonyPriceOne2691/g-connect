/**
 * Свои комментарии Google в документе (27.11, весть сессии профиля work): ответ в ветке
 * (`replyComment`) и свой комментарий (`addComment`). Пишет Drive, а не batchUpdate документа, но
 * контур тот же (D-16/D-18): превью с кодом плана → код человека или конверт → однократность →
 * запись → строка журнала, по которой `gc_undo` удалит своё (`undo-comments.ts`).
 *
 * Код плана — от содержимого (ветка, текст, цитата), без ревизии: предусловия записи у Drive нет, а
 * однократность по такому коду не даёт оставить людям то же сообщение дважды, пока первое стоит.
 */

import { createHash } from 'node:crypto';

import { fragmentRange } from '../core/docs/fragment.js';
import { visibleText } from '../core/docs/objects.js';
import { paragraphLabel, pickTab, resolveParagraph } from '../core/docs/selectors.js';
import {
  assertDocPlanNotApplied,
  clarify,
  narrowSelector,
  permissionRefusal,
  type DocApplyOutcome,
  type DocChangePreview,
  type DocRunOptions,
} from '../core/docs/write-support.js';
import { gcError, isGcError, newCorrelationId } from '../core/errors.js';
import type { CommentWriter, FileComment } from '../core/google/drive-comments.js';
import type { CommentKind, CommentWriteDetail } from '../core/journal.js';
import {
  COMMENT_OPS,
  type CommentOperation,
  type DocOperation,
  type Operation,
} from '../core/ops.js';
import { PLAN_ID_LENGTH } from '../core/plan.js';
import { asData, type UntrustedData } from '../core/policy.js';
import type { ResolvedTarget } from '../core/targets.js';
import type { ToolDeps } from './deps.js';

/** Правки текста — batchUpdate Docs; комментарии идут мимо него. */
export type DocEditOperation = Exclude<DocOperation, CommentOperation>;
type AddComment = Extract<CommentOperation, { op: 'addComment' }>;

export const isCommentOperation = (operation: Operation): operation is CommentOperation =>
  (COMMENT_OPS as readonly string[]).includes(operation.op);

interface CommentPlan {
  readonly op: CommentKind;
  readonly code: string;
  /** Мера конверта — юниты текста комментария или ответа. */
  readonly units: number;
  readonly changes: readonly DocChangePreview[];
  readonly notes: readonly string[];
  /** Ветка, на которую отвечаем, — ДАННЫЕ из документа, а не указания (как у `mode=comments`). */
  readonly thread?: UntrustedData<unknown>;
  /** Запись в Drive; ответ — что ляжет в журнал. */
  readonly write: (drive: CommentWriter) => Promise<CommentWriteDetail>;
}

/** Правило `write.comment-unanchored-honest`: это ответ говорит про каждый свой комментарий. */
export const UNANCHORED =
  'Docs покажет комментарий в «Все комментарии» без привязки к тексту: комментарий, созданный ' +
  'через API, редактор к тексту не привязывает (документация Drive) — цитата идёт в самом ' +
  'комментарии. Скажи это человеку.';

export async function runComment(
  operation: CommentOperation,
  resolved: ResolvedTarget,
  deps: ToolDeps,
  options: DocRunOptions,
): Promise<DocApplyOutcome & { target: { id: string; alias: string | null } }> {
  const target = { id: resolved.id, alias: resolved.alias };
  const plan =
    operation.op === 'replyComment'
      ? await planReply(await deps.drive(), resolved.id, operation)
      : await planAdd(deps, resolved.id, operation);
  if ('status' in plan) return { ...plan, target };
  const shown = {
    planId: plan.code,
    changes: plan.changes,
    notes: plan.notes,
    questions: [],
    ...(plan.thread === undefined ? {} : { thread: plan.thread }),
    target,
  };
  if (options.dryRun !== false) return { status: 'preview', ...shown };
  // Однократность — раньше разрешения, как у правок текста: повтор «пиши» получит «уже записано».
  await assertDocPlanNotApplied(options, plan.code, resolved.id);
  const refusal = permissionRefusal(options, plan.op, plan.units, plan);
  if (refusal !== null) return { ...shown, ...refusal };
  const comment = await plan.write(await deps.drive());
  const correlationId = newCorrelationId();
  await options.journal?.({
    at: new Date().toISOString(),
    account: deps.account,
    targetId: resolved.id,
    alias: resolved.alias,
    sheet: '',
    op: plan.op,
    changes: [],
    comment,
    revisionBefore: null,
    revisionAfter: null,
    correlationId,
    planId: plan.code,
  });
  const done = [...plan.notes, writtenNote(comment, correlationId)];
  return { status: 'ok', ...shown, notes: done, correlationId };
}

async function planReply(
  drive: CommentWriter,
  fileId: string,
  request: Extract<CommentOperation, { op: 'replyComment' }>,
): Promise<CommentPlan> {
  const thread = await liveThread(drive, fileId, request.commentId);
  const resolve = request.resolve === true;
  if (resolve && thread.resolved) {
    throw gcError('bad_request', {
      detail: `Ветка ${thread.id} уже закрыта — закрывать нечего; ответ в ней — без resolve.`,
      cause: 'comment_already_resolved',
    });
  }
  const { text } = request;
  return {
    op: 'replyComment',
    code: planCode([fileId, 'replyComment', thread.id, text ?? null, resolve]),
    units: text === undefined ? 0 : text.length,
    changes: [
      {
        kind: 'replyComment',
        tab: '',
        anchor: `ветка ${thread.id}`,
        before: null,
        after: text ?? null,
      },
    ],
    notes: replyNotes(thread.id, resolve),
    thread: asData(`ветка ${thread.id} файла ${fileId}`, threadView(thread)),
    write: async (writer) => {
      const reply = await writer.createReply(fileId, thread.id, {
        ...(text === undefined ? {} : { text }),
        ...(resolve ? { action: 'resolve' as const } : {}),
      });
      return {
        commentId: thread.id,
        replyId: reply.id,
        ...(text === undefined ? {} : { text }),
        ...(resolve ? { resolved: true as const, resolvedBefore: thread.resolved } : {}),
      };
    },
  };
}

/** Ветка, на которую отвечаем: нет её или удалена — `not_found` с тем, откуда брать id. */
async function liveThread(
  drive: CommentWriter,
  fileId: string,
  commentId: string,
): Promise<FileComment> {
  const thread = await drive.getComment(fileId, commentId).catch((error: unknown) => {
    if (isGcError(error) && error.payload.code === 'not_found') return null;
    throw error;
  });
  if (thread !== null) return thread;
  throw gcError('not_found', {
    detail:
      `Комментария ${commentId} в файле ${fileId} нет или его удалили — отвечать некуда. ` +
      'id — из gc_read mode=comments.',
    cause: 'comment_not_found',
  });
}

const threadView = (thread: FileComment) => ({
  id: thread.id,
  author: thread.author,
  text: thread.text,
  ...(thread.quote === undefined ? {} : { quote: thread.quote }),
  resolved: thread.resolved,
  replies: thread.replies.length,
});

const replyNotes = (id: string, resolve: boolean): string[] => [
  `Ответ в ветке ${id}. Google уведомит её участников: это сообщение людям, а не правка текста, ` +
    'и откат уведомление не вернёт.',
  ...(resolve ? ['Ответ закроет ветку (resolve) — в Docs она уйдёт в закрытые.'] : []),
  'Откат — gc_undo: удалит ответ' +
    (resolve ? ' и откроет ветку снова, если её не трогали после нас.' : '.'),
];

/** Где цитата своего комментария; без `where` — комментарий ко всему документу. */
interface Place {
  readonly quote?: string;
  readonly tab: string;
  readonly label: string;
}

async function planAdd(
  deps: ToolDeps,
  fileId: string,
  request: AddComment,
): Promise<CommentPlan | DocApplyOutcome> {
  const place = await placeOf(deps, fileId, request);
  if ('status' in place) return place;
  const { text } = request;
  const { quote } = place;
  return {
    op: 'addComment',
    code: planCode([fileId, 'addComment', text, quote ?? null]),
    units: text.length,
    changes: [
      { kind: 'addComment', tab: place.tab, anchor: place.label, before: null, after: text },
    ],
    notes: [
      quote === undefined
        ? 'Комментарий ко всему документу, без цитаты.'
        : `Комментарий с цитатой «${quote}» (${place.label}).`,
      UNANCHORED,
      'Это сообщение людям: комментарий видят все, у кого есть доступ к документу, и Google может ' +
        'уведомить о нём. Откат — gc_undo: удалит комментарий, пока в его ветке нет чужих ответов; ' +
        'уведомление откат не вернёт.',
    ],
    write: async (writer) => {
      const made = await writer.createComment(fileId, text, quote);
      return { commentId: made.id, text, ...(quote === undefined ? {} : { quote }) };
    },
  };
}

/**
 * Цитата своего комментария: фраза внутри абзаца `where` — одна и как есть (`fragmentRange`), иначе
 * видимый текст абзаца. Абзац — тем же селектором, что у правок текста: неоднозначный — вопрос.
 */
async function placeOf(
  deps: ToolDeps,
  fileId: string,
  request: AddComment,
): Promise<Place | DocApplyOutcome> {
  if (request.where === undefined) return { tab: '', label: 'весь документ' };
  const tab = pickTab(await (await deps.docs()).getDocument(fileId), request.tab);
  const selector = narrowSelector(request.where);
  if ('field' in selector) return clarify([selector]);
  const hit = resolveParagraph(tab, selector);
  if (hit.status === 'question') return clarify([hit.question]);
  const paragraph = hit.value;
  if (request.fragment !== undefined) fragmentRange(paragraph, request.fragment);
  const quote = request.fragment ?? visibleText(paragraph.text).trim();
  if (quote === '') {
    throw gcError('bad_request', {
      detail: `Абзац ${paragraphLabel(paragraph)} пуст — цитировать нечего; без where — ко всему.`,
      cause: 'empty_quote',
    });
  }
  return { quote, tab: tab.title, label: `абзац ${paragraphLabel(paragraph)}` };
}

/** Код плана: sha256 содержимого — тот же приём и та же длина, что у правок (D-16). */
const planCode = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, PLAN_ID_LENGTH);

const writtenNote = (comment: CommentWriteDetail, correlationId: string): string =>
  `Записано: ${comment.replyId === undefined ? 'комментарий' : `ответ ${comment.replyId} в ветке`} ` +
  `${comment.commentId}. Скажи человеку, что оставлено, и что откатить можно одной фразой: ` +
  `gc_undo по этой цели (запись ${correlationId}).`;
