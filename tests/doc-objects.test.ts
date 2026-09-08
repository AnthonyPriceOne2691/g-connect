/**
 * Вставки объектов (уровень 3, хвост слайса 4): P19, P19b — разрыв страницы и картинка.
 * Источник картинки — только URL, доступный Google; локальный путь отклоняется ДО сети.
 */

import { describe, expect, it } from 'vitest';

import { runDocInsert } from '../src/core/docs/insert-op.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import { toDocRequest } from '../src/core/google/doc-requests.js';
import type { DocRunOptions } from '../src/core/docs/write-support.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';

const journalled: WriteRecord[] = [];
const source = (): JournalSource => ({ recent: () => Promise.resolve([...journalled]) });
const options = (over: Partial<DocRunOptions> = {}): DocRunOptions => ({
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: source(),
  authorize: () => ({ authorized: true }),
  ...over,
});
const fresh = () => {
  journalled.length = 0;
  return new FakeDocsClient(forecastDoc());
};

describe('P19b — источник картинки судится ДО обращения к Google', () => {
  it.each([
    ['/Users/anthony/screenshot.png', 'локальный путь'],
    ['file:///tmp/a.png', 'file://'],
    ['http://example.com/a.png', 'не https'],
  ])('%s отклоняется с советом про отдельную поставку', async (uri) => {
    const client = fresh();
    await expect(
      runDocInsert(
        client,
        await client.getDocument(),
        { op: 'insertInlineImage', tab: 'Черновики', uri },
        options({ dryRun: false }),
      ),
    ).rejects.toMatchObject({ payload: { cause: 'image.local-source' } });
    expect(journalled).toHaveLength(0);
  });

  it('https-URL проходит: план называет картинку, запись кладёт объект, откат удаляет', async () => {
    const client = fresh();
    const uri = 'https://example.com/lineup.png';
    const preview = await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertInlineImage', tab: 'Черновики', uri },
      options(),
    );
    expect(preview.status).toBe('preview');
    expect(preview.changes[0]!.after).toContain(uri);

    const written = await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertInlineImage', tab: 'Черновики', uri },
      options({ dryRun: false }),
    );
    expect(written.status).toBe('ok');
    expect(journalled[0]!.doc?.inserted).toHaveLength(1); // объект — один юнит

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
  });
});

describe('P19-класс — перевод запросов объектов по документации', () => {
  it('insertPageBreak и insertInlineImage: location с tabId, uri у картинки', () => {
    expect(toDocRequest({ kind: 'insertPageBreak', tabId: 't1', at: 42 })).toEqual({
      insertPageBreak: { location: { index: 42, tabId: 't1' } },
    });
    expect(
      toDocRequest({ kind: 'insertInlineImage', tabId: 't1', at: 7, uri: 'https://x/y.png' }),
    ).toEqual({
      insertInlineImage: { location: { index: 7, tabId: 't1' }, uri: 'https://x/y.png' },
    });
  });

  it('разрыв страницы: план, запись, откат', async () => {
    const client = fresh();
    const written = await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertPageBreak', tab: 'Черновики' },
      options({ dryRun: false }),
    );
    expect(written.status).toBe('ok');
    expect(written.changes[0]!.after).toBe('разрыв страницы');
    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
  });
});
