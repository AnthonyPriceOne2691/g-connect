/**
 * Пробы правил записи комментариев Google (27.11) — отдельным модулем, как `header-probes.ts`:
 * реестр проб в policy.test.ts у предела длины. Структурный оракул «у КАЖДОГО правила есть проба —
 * и наоборот» судит реестр целиком.
 */

import type { drive_v3 } from 'googleapis';
import { expect } from 'vitest';

import { GoogleDriveClient } from '../../src/core/google/drive.js';
import type { CommentReply, FileComment } from '../../src/core/google/drive-comments.js';
import type { CommentWriteDetail, WriteRecord } from '../../src/core/journal.js';
import { undoComment } from '../../src/core/undo-comments.js';
import { gcApply, type ToolDeps } from '../../src/mcp/tools.js';
import { FakeDocsClient, forecastDoc } from './doc.js';
import { FakeDriveClient, ME } from './drive.js';
import { callMcp } from './protocol.js';

const DOC = 'DOC0000000000000000001';

/** Свой комментарий в ветке с этими ответами. */
const mine = (replies: readonly CommentReply[], me = true): FileComment => ({
  id: 'CMT1',
  author: ME,
  me,
  createdTime: null,
  modifiedTime: null,
  text: 'Проверьте счёт',
  resolved: false,
  replies,
});

/** Запись журнала о своём комментарии CMT1. */
const added: WriteRecord & { comment: CommentWriteDetail } = {
  at: new Date().toISOString(),
  account: 'default',
  targetId: DOC,
  alias: null,
  sheet: '',
  op: 'addComment',
  changes: [],
  comment: { commentId: 'CMT1', text: 'Проверьте счёт' },
  revisionBefore: null,
  revisionAfter: null,
  correlationId: 'gc-probe-comment',
};

export const commentWriteProbes: Record<string, () => Promise<void>> = {
  // Откат удаляет только своё: ответил другой или комментарий не наш — отказ, удаления нет; без
  // чужих ответов — свой комментарий удалён.
  'write.comment-undo-own-only': async () => {
    const drive = new FakeDriveClient();
    const options = { drive: () => Promise.resolve(drive) };
    const theirs = {
      id: 'R9',
      author: 'Заказчик',
      me: false,
      createdTime: null,
      modifiedTime: null,
    };
    const refusals = [
      [mine([{ ...theirs, text: 'Верно' }]), 'В ветке комментария CMT1 ответили другие (1)'],
      [mine([], false), 'Комментарий CMT1 оставлен не этим профилем'],
    ] as const;
    for (const [thread, why] of refusals) {
      drive.comments.set(DOC, [thread]);
      await expect(undoComment(DOC, added, options)).rejects.toMatchObject({
        payload: {
          code: 'policy_denied',
          cause: 'write.comment-undo-own-only',
          detail: expect.stringContaining(why),
        },
      });
    }
    expect(drive.calls).not.toContain('deleteComment');
    drive.comments.set(DOC, [mine([])]);
    await undoComment(DOC, added, options);
    expect(drive.comments.get(DOC)).toEqual([]);
  },

  // Свой комментарий — без якоря, цитата текстом; превью говорит, что Docs не привяжет его к тексту.
  'write.comment-unanchored-honest': async () => {
    const sent: unknown[] = [];
    const api = {
      comments: {
        create: (params: unknown) => {
          sent.push(params);
          return Promise.resolve({ data: { id: 'CMT1' } });
        },
      },
    } as unknown as drive_v3.Drive;
    await new GoogleDriveClient({ accessToken: 'нет', api }).createComment(DOC, 'Так?', 'счёт');
    expect(sent).toEqual([
      {
        fileId: DOC,
        fields: 'id,createdTime,quotedFileContent',
        requestBody: {
          content: 'Так?',
          quotedFileContent: { mimeType: 'text/plain', value: 'счёт' },
        },
      },
    ]);
    const deps: ToolDeps = {
      account: 'default',
      sheets: () => Promise.reject(new TypeError('таблиц в пробе нет')),
      docs: () => Promise.resolve(new FakeDocsClient(forecastDoc())),
      drive: () => Promise.resolve(new FakeDriveClient()),
      registry: () => Promise.resolve({ targets: [] }),
      journal: () => Promise.resolve(),
      journalSource: { recent: () => Promise.resolve([]) },
      revision: () => Promise.resolve(null),
    };
    const preview = await callMcp(
      gcApply,
      {
        op: 'addComment',
        target: `https://docs.google.com/document/d/${DOC}/edit`,
        tab: 'Прогноз',
        where: { textStartsWith: 'Ставим на победу' },
        fragment: 'со счётом 2:1',
        text: 'Так?',
      },
      deps,
    );
    const notes = (preview.data as { notes: string[] }).notes.join(' ');
    expect(notes).toContain('«Все комментарии» без привязки к тексту');
    expect(notes).toContain('цитатой «со счётом 2:1»');
  },
};
