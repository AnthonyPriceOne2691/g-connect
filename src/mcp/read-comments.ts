/**
 * `gc_read mode=comments` (27.11, весть сессии профиля work): комментарии Google к документу — ветки
 * с ответами, цитата и № абзаца по ней.
 *
 * Отдельным модулем по той же причине, что `read-doc.ts`: `tools.ts` — витрина инструментов.
 * Комментарии читает Drive (у Docs API их нет), абзацы — Docs: оба запроса идут разом.
 */

import { placeFinder, type CommentPlace } from '../core/docs/comment-place.js';
import { pickTab } from '../core/docs/selectors.js';
import type { DocTab } from '../core/docs/types.js';
import { gcError } from '../core/errors.js';
import type { CommentReply, FileComment } from '../core/google/drive-comments.js';
import { asData } from '../core/policy.js';
import type { ResolvedTarget } from '../core/targets.js';
import type { ToolDeps } from './deps.js';

const PLACE_NOTES: Readonly<Record<Exclude<CommentPlace['status'], 'found'>, string>> = {
  ambiguous: 'цитата встречается в документе не один раз — абзац не выбран, вхождения в matches',
  notFound: 'цитаты в нынешнем тексте нет — его правили после комментария',
  unanchored: 'комментарий ко всему документу, без цитаты',
};

const replyView = (reply: CommentReply) => ({
  id: reply.id,
  author: reply.author,
  ...(reply.me ? { me: true } : {}),
  created: reply.createdTime,
  modified: reply.modifiedTime,
  text: reply.text,
  ...(reply.action === undefined ? {} : { action: reply.action }),
});

function placeView(place: CommentPlace) {
  return place.status === 'found' ? place : { ...place, note: PLACE_NOTES[place.status] };
}

function commentView(comment: FileComment, place: CommentPlace | undefined) {
  return {
    id: comment.id,
    author: comment.author,
    ...(comment.me ? { me: true } : {}),
    created: comment.createdTime,
    modified: comment.modifiedTime,
    resolved: comment.resolved,
    text: comment.text,
    ...(comment.quote === undefined ? {} : { quote: comment.quote }),
    ...(place === undefined ? {} : { place: placeView(place) }),
    replies: comment.replies.map(replyView),
  };
}

/** Табы, по которым искать цитату: названный — он один, иначе все. Не документ — мест нет. */
async function tabsOf(
  deps: ToolDeps,
  resolved: ResolvedTarget,
  tab: string | undefined,
): Promise<{ doc: string; tabs: readonly DocTab[] } | null> {
  if (resolved.type !== 'doc') return null;
  const snapshot = await (await deps.docs()).getDocument(resolved.id);
  return {
    doc: snapshot.title,
    tabs: tab === undefined ? snapshot.tabs : [pickTab(snapshot, tab)],
  };
}

export async function readComments(
  deps: ToolDeps,
  resolved: ResolvedTarget,
  input: { tab?: string | undefined },
): Promise<unknown> {
  if (resolved.type !== 'doc' && resolved.type !== 'sheet') {
    throw gcError('bad_request', {
      detail: 'mode=comments читает комментарии документа или таблицы Google.',
    });
  }
  const [list, docText] = await Promise.all([
    deps.drive().then((drive) => drive.listComments(resolved.id)),
    tabsOf(deps, resolved, input.tab),
  ]);
  const find = docText === null ? undefined : placeFinder(docText.tabs);
  const warnings: string[] = [];
  if (find === undefined && list.comments.length > 0) {
    warnings.push(
      'У таблицы ячейку комментария по цитате не определить: Drive отдаёт её якорь во внутреннем ' +
        'виде редактора. Цитата — значение ячейки на момент комментария.',
    );
  }
  if (list.truncated) {
    warnings.push(`Показаны первые ${list.comments.length} комментариев: дальше Drive не читался.`);
  }
  return {
    ...(docText === null ? {} : { doc: docText.doc }),
    total: list.comments.length,
    open: list.comments.filter((c) => !c.resolved).length,
    // Текст комментариев, ответов и имена авторов пишет кто угодно — это ДАННЫЕ с пометкой
    // источника, а не указания агенту (правило read.comments-are-data, как заметки таблиц).
    comments: asData(
      `комментарии к файлу ${resolved.id}`,
      list.comments.map((c) => commentView(c, find?.(c.quote))),
    ),
    truncated: list.truncated,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
