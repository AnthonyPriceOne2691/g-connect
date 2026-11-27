/**
 * Откат своего комментария Google (27.11) — удалить своё и только своё
 * (`write.comment-undo-own-only`). Комментарий удаляется, пока в его ветке нет ЧУЖИХ ответов: Drive
 * удаляет ветку целиком и унёс бы чужие слова — отказ, `force` его не снимает. Ответ удаляется один;
 * закрыл он ветку, открытую до него, — откат открывает её снова (`reopen`), если её закрытие ещё
 * наше. Своего уже нет (удалили в Docs) — так и сказано, запись помечена откаченной: иначе каждый
 * следующий откат упирался бы в неё. Ушедшее людям уведомление откат не возвращает.
 */

import { gcError, newCorrelationId } from './errors.js';
import type { CommentWriter, FileComment } from './google/drive-comments.js';
import type { CommentWriteDetail, WriteRecord } from './journal.js';
import { denyByRule } from './policy.js';
import type { UndoOptions, UndoOutcome } from './undo-types.js';

type CommentRecord = WriteRecord & { readonly comment: CommentWriteDetail };

/** Что сделал откат — и чего не вернул (урок L5: о невозвращённом не молчат). */
interface Dropped {
  readonly done: string;
  readonly notRestored?: readonly string[];
}

/** Запись о своём комментарии или ответе: её откатывает Drive, а не правка текста. */
export const isCommentRecord = (record: WriteRecord): record is CommentRecord =>
  record.comment !== undefined;

export async function undoComment(
  targetId: string,
  record: CommentRecord,
  options: UndoOptions,
): Promise<UndoOutcome> {
  if (options.drive === undefined) {
    throw gcError('internal', { detail: 'Откату комментария нужен Drive — комментарий на месте.' });
  }
  const drive = await options.drive();
  const { comment } = record;
  const thread = await drive.getComment(targetId, comment.commentId);
  const dropped =
    comment.replyId === undefined
      ? await dropComment(drive, targetId, comment.commentId, thread)
      : await dropReply(drive, targetId, { ...comment, replyId: comment.replyId }, thread);
  await options.journal?.(undoTrail(record, targetId));
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    docUndone: dropped.done,
    ...(dropped.notRestored === undefined ? {} : { notRestored: dropped.notRestored }),
  };
}

async function dropComment(
  drive: CommentWriter,
  fileId: string,
  id: string,
  thread: FileComment | null,
): Promise<Dropped> {
  if (thread === null) return { done: `Комментария ${id} уже нет — его удалили в Docs.` };
  assertMine(thread.me, `Комментарий ${id}`);
  const others = thread.replies.filter((reply) => !reply.me).length;
  if (others > 0) {
    denyByRule(
      OWN_ONLY,
      `В ветке комментария ${id} ответили другие (${others}): Drive удаляет ветку целиком, и ` +
        'откат унёс бы их ответы. Комментарий на месте; удалить ветку с чужими ответами может ' +
        'человек в Docs, закрыть её — replyComment с resolve: true.',
    );
  }
  await drive.deleteComment(fileId, id);
  return { done: `Комментарий «${excerpt(thread.text)}» удалён вместе со своей веткой.` };
}

async function dropReply(
  drive: CommentWriter,
  fileId: string,
  comment: CommentWriteDetail & { readonly replyId: string },
  thread: FileComment | null,
): Promise<Dropped> {
  const at = thread?.replies.findIndex((reply) => reply.id === comment.replyId) ?? -1;
  if (thread === null || at === -1) {
    return { done: `Ответа ${comment.replyId} уже нет — его удалили в Docs.` };
  }
  assertMine(thread.replies[at]?.me === true, `Ответ ${comment.replyId}`);
  await drive.deleteReply(fileId, thread.id, comment.replyId);
  const said = `Ответ «${excerpt(comment.text ?? 'закрыть ветку')}» удалён из ветки ${thread.id}.`;
  if (comment.resolved !== true || comment.resolvedBefore !== false) return { done: said };
  return reopen(drive, fileId, thread, at, said);
}

/**
 * Ветка, закрытая нашим ответом, — снова открыта, как до него. Только пока её закрытие наше: после
 * нашего ответа её закрывали или открывали — это решали другие, не трогаем и говорим об этом.
 */
async function reopen(
  drive: CommentWriter,
  fileId: string,
  thread: FileComment,
  at: number,
  said: string,
): Promise<Dropped> {
  if (thread.replies.slice(at + 1).some((reply) => reply.action !== undefined)) {
    return {
      done: said,
      notRestored: ['ветка не открыта снова: после нашего ответа её закрывали или открывали'],
    };
  }
  const now = await drive.getComment(fileId, thread.id);
  if (now?.resolved !== true) return { done: `${said} Ветка открыта, как до ответа.` };
  await drive.createReply(fileId, thread.id, { action: 'reopen' });
  return { done: `${said} Ответ закрывал ветку — она открыта снова (reopen), как до него.` };
}

const OWN_ONLY = 'write.comment-undo-own-only';

/** Удалить в Drive может только автор, и откат удаляет только своё. */
function assertMine(mine: boolean, what: string): void {
  if (!mine) denyByRule(OWN_ONLY, `${what} оставлен не этим профилем — откат удаляет только своё.`);
}

const excerpt = (text: string): string => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** След отката: запись помечена откаченной, и второй такой же откат не пройдёт. */
function undoTrail(record: WriteRecord, targetId: string): WriteRecord {
  return {
    op: 'undo',
    undoOf: record.correlationId,
    correlationId: newCorrelationId(),
    at: new Date().toISOString(),
    account: record.account,
    targetId,
    alias: record.alias,
    sheet: record.sheet,
    changes: [],
    revisionBefore: null,
    revisionAfter: null,
    ...(record.planId === undefined ? {} : { planId: record.planId }),
  };
}
