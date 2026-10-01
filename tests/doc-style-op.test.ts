/**
 * Стили документа (уровень 3, слайс 7): P11, P12. Текст не меняется; откат накатывает
 * ПРЕЖНИЕ поля безусловно — включая NORMAL_TEXT и «без списка».
 */

import { describe, expect, it } from 'vitest';

import { runDocStyle } from '../src/core/docs/style-op.js';
import { undoDocLast } from '../src/core/undo-docs.js';
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
  account: 'default',
  alias: 'forecast',
  authorize: () => ({ authorized: true }),
  ...over,
});
const fresh = (doc = forecastDoc()) => {
  journalled.length = 0;
  return new FakeDocsClient(doc);
};

describe('P11 — заголовок ↔ обычный текст', () => {
  it('план говорит «было HEADING_2 → станет NORMAL_TEXT»; откат возвращает заголовок', async () => {
    const client = fresh();
    const preview = await runDocStyle(
      client,
      await client.getDocument(),
      {
        op: 'setParagraphStyle',
        tab: 'Прогноз',
        where: { textStartsWith: 'Составы' },
        namedStyle: 'NORMAL_TEXT',
      },
      options(),
    );
    expect(preview.status).toBe('preview');
    expect(preview.changes[0]!.before).toContain('HEADING_2');
    expect(preview.changes[0]!.after).toBe('NORMAL_TEXT');

    const written = await runDocStyle(
      client,
      await client.getDocument(),
      {
        op: 'setParagraphStyle',
        tab: 'Прогноз',
        where: { textStartsWith: 'Составы' },
        namedStyle: 'NORMAL_TEXT',
      },
      options({ dryRun: false }),
    );
    expect(written.status).toBe('ok');
    const styled = (await client.getDocument()).tabs[0]!.paragraphs.find(
      (x) => x.text === 'Составы',
    )!;
    expect(styled.namedStyle).toBe('NORMAL_TEXT');

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(undone.docUndone).toContain('текст не тронут');
    const restored = (await client.getDocument()).tabs[0]!.paragraphs.find(
      (x) => x.text === 'Составы',
    )!;
    expect(restored.namedStyle).toBe('HEADING_2');
  });

  it('жирность абзаца ставится и откатывается: прежние прогоны без стиля вернулись без него', async () => {
    const client = fresh();
    await runDocStyle(
      client,
      await client.getDocument(),
      {
        op: 'updateTextStyle',
        tab: 'Прогноз',
        where: { textStartsWith: 'Ставим на победу' },
        style: { bold: true },
      },
      options({ dryRun: false }),
    );
    const bolded = (await client.getDocument()).tabs[0]!.paragraphs.find((x) =>
      x.text.startsWith('Ставим'),
    )!;
    expect(bolded.runs.every((r) => r.style?.bold === true)).toBe(true);

    await undoDocLast(client, 'doc-fixture', source(), {});
    const restored = (await client.getDocument()).tabs[0]!.paragraphs.find((x) =>
      x.text.startsWith('Ставим'),
    )!;
    expect(restored.runs.some((r) => r.style?.bold === true)).toBe(false);
    expect(restored.text).toBe('Ставим на победу Fluminense со счётом 2:1.');
  });
});

describe('P12 — список из нескольких абзацев', () => {
  it('count расширяет правку; откат снимает буллеты, текст цел', async () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [p('Прогноз', 'HEADING_2'), p('первый'), p('второй'), p('третий'), p('хвост')],
        },
      ],
    });
    const client = fresh(doc);
    const written = await runDocStyle(
      client,
      await client.getDocument(),
      { op: 'createParagraphBullets', where: { textStartsWith: 'первый' }, count: 3 },
      options({ dryRun: false }),
    );
    expect(written.status).toBe('ok');
    expect(written.changes).toHaveLength(3);
    const after = (await client.getDocument()).tabs[0]!.paragraphs;
    expect(after.filter((x) => x.bulleted === true).map((x) => x.text)).toEqual([
      'первый',
      'второй',
      'третий',
    ]);

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    const restored = (await client.getDocument()).tabs[0]!.paragraphs;
    expect(restored.every((x) => x.bulleted !== true)).toBe(true);
    expect(restored.map((x) => x.text)).toEqual(['Прогноз', 'первый', 'второй', 'третий', 'хвост']);
  });

  it('документ правили после стилей — откат отказывает ревизией', async () => {
    const client = fresh();
    const written = await runDocStyle(
      client,
      await client.getDocument(),
      {
        op: 'updateTextStyle',
        tab: 'Черновики',
        where: { firstParagraph: true },
        style: { italic: true },
      },
      options({ dryRun: false }),
    );
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: 1, text: 'сдвиг ' }],
      written.revisionAfter!,
    );
    await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
      payload: { cause: 'doc_moved_after_style' },
    });
  });
});

describe('откат возвращает стиль ПОЛЕ В ПОЛЕ (находки читателя 2026-10-01)', () => {
  it('ссылка, цвет и кегль, поставленные правкой, откатом снимаются', async () => {
    // Раньше откат слал явными только 4 флага: ссылка и цвет оставались, а ответ говорил
    // «стили возвращены».
    const client = fresh();
    const where = { textStartsWith: 'Ставим на победу' } as const;
    await runDocStyle(
      client,
      await client.getDocument(),
      {
        op: 'updateTextStyle',
        tab: 'Прогноз',
        where,
        style: { link: 'https://example.com', color: '#ff0000', fontSize: 18 },
      },
      options({ dryRun: false }),
    );
    await undoDocLast(client, 'doc-fixture', source(), {});
    const restored = (await client.getDocument()).tabs[0]!.paragraphs.find((x) =>
      x.text.startsWith('Ставим'),
    )!;
    expect(restored.runs.map((r) => r.style ?? null)).toEqual([null]);
  });
});
