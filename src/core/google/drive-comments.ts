/**
 * Комментарии Drive к файлу (27.11, весть сессии профиля work): заказчик ответил в документе
 * комментариями, а `gc_read` их не видел. Здесь — чтение веток: автор, время, текст, цитата,
 * ответы.
 *
 * Отдельным модулем: `drive.ts` у предела длины, а у комментариев свои капканы. Из документации
 * Drive (guides/manage-comments, reference comments/list, сверено 27.11):
 * - `fields` ОБЯЗАТЕЛЕН у всех методов комментариев, кроме `delete`: без него Drive отвечает
 *   ошибкой, а не минимальным ответом;
 * - страница — до 100 комментариев (без `pageSize` — 20), дальше `nextPageToken`;
 * - якорь комментария к документу Google — «непрозрачные» данные редактора: позицию в тексте
 *   даёт только цитата (`quotedFileContent`), и место по ней ищет `docs/comment-place.ts`.
 */

import type { drive_v3 } from 'googleapis';

import { fromGoogleError } from '../errors.js';

export interface CommentReply {
  readonly id: string;
  readonly author: string;
  /** Автор — аккаунт этого профиля (`author.me`). */
  readonly me: boolean;
  readonly createdTime: string | null;
  readonly modifiedTime: string | null;
  readonly text: string;
  /** Ответ закрыл ветку (`resolve`) или открыл её снова (`reopen`) — у такого текста может не быть. */
  readonly action?: 'resolve' | 'reopen';
}

export interface FileComment {
  readonly id: string;
  readonly author: string;
  readonly me: boolean;
  readonly createdTime: string | null;
  readonly modifiedTime: string | null;
  readonly text: string;
  readonly resolved: boolean;
  /** Процитированный текст файла на момент комментария; нет — комментарий ко всему файлу. */
  readonly quote?: string;
  readonly replies: readonly CommentReply[];
}

export interface CommentList {
  readonly comments: readonly FileComment[];
  /** Страниц больше предела — список оборван, и это сказано, а не умолчано. */
  readonly truncated: boolean;
}

const USER = 'author(displayName,me)';
const REPLY = `id,${USER},content,createdTime,modifiedTime,action,deleted`;

/** Поля ответа: без `fields` Drive отказывает (документация comments/list). */
export const COMMENT_FIELDS =
  `nextPageToken,comments(id,${USER},content,createdTime,modifiedTime,resolved,deleted,` +
  `quotedFileContent(mimeType,value),replies(${REPLY}))`;

const PAGE_SIZE = 100;
/** 50 страниц по 100 — 5000 комментариев; дальше список оборван с `truncated: true`. */
const MAX_PAGES = 50;

type Retry = <T>(fn: () => Promise<T>) => Promise<T>;

/** Все неудалённые комментарии файла с ответами, по порядку Drive. Чтение — с повторами. */
export async function listComments(
  drive: drive_v3.Drive,
  retry: Retry,
  fileId: string,
): Promise<CommentList> {
  const comments: FileComment[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const token = pageToken;
      const { data } = await retry(() =>
        drive.comments.list({
          fileId,
          pageSize: PAGE_SIZE,
          includeDeleted: false,
          fields: COMMENT_FIELDS,
          ...(token === undefined ? {} : { pageToken: token }),
        }),
      );
      for (const raw of data.comments ?? []) {
        const comment = toComment(raw);
        if (comment !== null) comments.push(comment);
      }
      pageToken = data.nextPageToken ?? undefined;
      if (pageToken === undefined || pageToken === '') return { comments, truncated: false };
    }
  } catch (error) {
    throw fromGoogleError(error, `Drive не отдал комментарии файла ${fileId}.`);
  }
  return { comments, truncated: true };
}

/** Автор и время — общие у комментария и ответа. */
function byline(raw: drive_v3.Schema$Comment | drive_v3.Schema$Reply) {
  return {
    author: raw.author?.displayName ?? '',
    me: raw.author?.me === true,
    createdTime: raw.createdTime ?? null,
    modifiedTime: raw.modifiedTime ?? null,
  };
}

/** Удалённый или без id — пропуск: текста удалённого Drive не отдаёт. */
const gone = (raw: { deleted?: boolean | null; id?: string | null }): boolean =>
  raw.deleted === true || !raw.id;

/** Ответ Drive → комментарий домена. Удалённый (или без id) — `null`. */
export function toComment(raw: drive_v3.Schema$Comment): FileComment | null {
  if (gone(raw)) return null;
  const quote = quoteOf(raw.quotedFileContent);
  return {
    id: raw.id ?? '',
    ...byline(raw),
    text: raw.content ?? '',
    resolved: raw.resolved === true,
    ...(quote === undefined ? {} : { quote }),
    replies: (raw.replies ?? []).flatMap(toReply),
  };
}

const ACTIONS: readonly string[] = ['resolve', 'reopen'];

function toReply(raw: drive_v3.Schema$Reply): CommentReply[] {
  if (gone(raw)) return [];
  const action = ACTIONS.includes(raw.action ?? '') ? (raw.action as 'resolve' | 'reopen') : null;
  return [
    { id: raw.id ?? '', ...byline(raw), text: raw.content ?? '', ...(action ? { action } : {}) },
  ];
}

/**
 * Цитата как текст. Комментарий, оставленный в редакторе, Drive отдаёт с `mimeType: text/html`:
 * апостроф там — `&#39;`, амперсанд — `&amp;`, и сравнение с абзацем без раскодирования не сошлось
 * бы. Пустая цитата — её нет.
 */
export function quoteOf(content: drive_v3.Schema$Comment['quotedFileContent']): string | undefined {
  const value = content?.value ?? '';
  if (value.trim() === '') return undefined;
  return content?.mimeType === 'text/html' ? htmlToText(value) : value;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML цитаты → текст: `<br>` — перевод строки, прочие теги убраны, сущности раскодированы. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => decodeEntity(whole, code));
}

function decodeEntity(whole: string, code: string): string {
  if (!code.startsWith('#')) return ENTITIES[code.toLowerCase()] ?? whole;
  const hex = code[1] === 'x' || code[1] === 'X';
  const point = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
    ? String.fromCodePoint(point)
    : whole;
}
