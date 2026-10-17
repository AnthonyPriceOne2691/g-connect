/**
 * Вставки объектов (уровень 3, хвост слайса 4): P19, P19b — разрыв страницы и картинка.
 * Источник картинки — только URL, доступный Google; локальный путь отклоняется ДО сети.
 */

import { describe, expect, it } from 'vitest';

import { runDocDelete } from '../src/core/docs/delete-op.js';
import { runDocInsert } from '../src/core/docs/insert-op.js';
import { OBJECT_MARK } from '../src/core/docs/types.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import { toDocRequest } from '../src/core/google/doc-requests.js';
import type { DocRunOptions } from '../src/core/docs/write-support.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, buildDoc, forecastDoc, p } from './fixtures/doc.js';

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

describe('объекты на живом шве (находки читателя и прогона 2026-10-01)', () => {
  const texts = async (client: FakeDocsClient, tab = 1) =>
    (await client.getDocument()).tabs[tab]!.paragraphs.map((x) => x.text);

  it('картинка с where встаёт ПОСЛЕ названного абзаца, а не в конец таба', async () => {
    const client = fresh();
    const outcome = await runDocInsert(
      client,
      await client.getDocument(),
      {
        op: 'insertInlineImage',
        tab: 'Черновики',
        uri: 'https://example.com/a.png',
        where: { textStartsWith: 'Устаревший' },
      },
      options({ dryRun: false }),
    );
    expect(outcome.status).toBe('ok');
    const [first, second] = await texts(client);
    expect(first).toBe(
      `Устаревший прогноз на прошлый тур, Fluminense тогда сыграл вничью.${OBJECT_MARK}`,
    );
    expect(second).toBe('Черновик заметки про прогноз погоды.');
  });

  it('разрыв страницы режет абзац (2 юнита), откат сшивает его без остатка и без force', async () => {
    const client = fresh();
    const before = await texts(client);
    await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertPageBreak', tab: 'Черновики', where: { textStartsWith: 'Устаревший' } },
      options({ dryRun: false }),
    );
    expect(await texts(client)).toHaveLength(before.length + 1);
    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(await texts(client)).toEqual(before);
  });

  it('удаление абзаца с картинкой отказывает ДО подписи: откат вернул бы текст без неё', async () => {
    const client = fresh();
    await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertInlineImage', tab: 'Черновики', uri: 'https://example.com/a.png' },
      options({ dryRun: false }),
    );
    const before = await texts(client);
    await expect(
      runDocDelete(
        client,
        await client.getDocument(),
        { op: 'deleteParagraph', tab: 'Черновики', where: { textStartsWith: 'Черновик заметки' } },
        options(),
      ),
    ).rejects.toMatchObject({ payload: { cause: 'docs.objects-not-destroyed' } });
    expect(await texts(client)).toEqual(before);
  });

  it('пустой абзац называется номером: «да, удаляю абзац» его не подписывает', async () => {
    const client = new FakeDocsClient(
      buildDoc({ tabs: [{ title: 'Т', content: [p('первый'), p(''), p('третий')] }] }),
    );
    journalled.length = 0;
    const request = { op: 'deleteParagraph', where: { paragraphIndex: 2 } } as const;
    const preview = await runDocDelete(client, await client.getDocument(), request, options());
    expect(preview.notes.join(' ')).toContain('удаляю абзац № 2');
    const vague = await runDocDelete(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да, удаляю абзац', planId: preview.planId! }),
    );
    expect(vague.status).toBe('confirm_required');
    expect((await client.getDocument()).tabs[0]!.paragraphs).toHaveLength(3);
  });
});
