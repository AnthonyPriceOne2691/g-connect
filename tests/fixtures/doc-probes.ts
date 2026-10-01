/**
 * Пробы правил документов (уровень 3) — отдельным модулем: реестр проб в policy.test.ts
 * перерос гейт длины (1029 > 1000), а доменная половина отделяется без потерь. Структурный
 * оракул «у КАЖДОГО правила есть проба — и наоборот» судит реестр целиком, как и раньше.
 */

import { expect } from 'vitest';

import { runDocDelete } from '../../src/core/docs/delete-op.js';
import { runDocInsert } from '../../src/core/docs/insert-op.js';
import { runDocReplace } from '../../src/core/docs/replace-op.js';
import { OBJECT_MARK } from '../../src/core/docs/types.js';
import type { WriteRecord } from '../../src/core/journal.js';
import { limitOf } from '../../src/core/policy.js';
import { undoDocLast } from '../../src/core/undo-docs.js';
import { FakeDocsClient, buildDoc, forecastDoc, p as docParagraph } from './doc.js';

export const docProbes: Record<string, () => Promise<void>> = {
  'write.named-confirm-bound-to-plan': async () => {
    // Фраза — подпись человека, код плана — привязка к показанному превью. Без привязки
    // повтор фразы делал массовую замену второй раз (находка читателя 2026-10-01).
    const client = new FakeDocsClient(forecastDoc());
    const journalled: WriteRecord[] = [];
    const request = { op: 'replaceAllText', find: 'Fluminense', replace: 'Fluminense FC' } as const;
    const options = (over: Record<string, unknown> = {}) => ({
      journal: async (r: WriteRecord) => {
        journalled.push(r);
      },
      journalSource: { recent: () => Promise.resolve(journalled) },
      ...over,
    });
    const text = async () =>
      (await client.getDocument()).tabs.flatMap((t) => t.paragraphs.map((x) => x.text)).join('\n');

    const bare = await runDocReplace(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да, заменяю Fluminense' }),
    );
    expect(bare.status).toBe('confirm_required');

    const preview = await runDocReplace(client, await client.getDocument(), request, options());
    const bound = options({
      dryRun: false,
      confirm: 'да, заменяю Fluminense',
      planId: preview.planId!,
    });
    expect((await runDocReplace(client, await client.getDocument(), request, bound)).status).toBe(
      'ok',
    );
    const once = await text();
    await expect(
      runDocReplace(client, await client.getDocument(), request, bound),
    ).rejects.toMatchObject({ payload: { code: 'plan_already_applied' } });
    expect(await text()).toBe(once);
  },
  'docs.objects-not-destroyed': async () => {
    // Объект откатом не вернуть: снимок держит текст. Удаление абзаца с картинкой уносило
    // её, а откат объявлял «восстановлено» (находка читателя 2026-10-01).
    const client = new FakeDocsClient(
      buildDoc({
        tabs: [
          {
            title: 'Т',
            content: [
              docParagraph('до'),
              { runs: [{ text: 'Фото: ' }, { text: OBJECT_MARK, object: 'image' as const }] },
              docParagraph('после'),
            ],
          },
        ],
      }),
    );
    await expect(
      runDocDelete(
        client,
        await client.getDocument(),
        { op: 'deleteParagraph', where: { textStartsWith: 'Фото' } },
        {},
      ),
    ).rejects.toMatchObject({ payload: { cause: 'docs.objects-not-destroyed' } });
    expect((await client.getDocument()).tabs[0]!.paragraphs).toHaveLength(3);
  },
  'docs.selector-not-guess': async () => {
    // Неоднозначность — вопрос с номерами абзацев, и ни одной правки.
    const client = new FakeDocsClient(forecastDoc());
    const outcome = await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertText', tab: 'Прогноз', text: 'х', where: { textContains: 'прогноз' } },
      { dryRun: false },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.candidates.length).toBeGreaterThan(1);
    expect(client.applied).toHaveLength(0);
  },
  'docs.write-needs-revision': async () => {
    // Ревизия ушла — сервер отклоняет пакет целиком, документ не меняется.
    const client = new FakeDocsClient(forecastDoc());
    const before = await client.getDocument();
    await expect(
      client.batchUpdate('d', [{ kind: 'insertText', tabId: 't1', at: 1, text: 'х' }], 'rev-ушла'),
    ).rejects.toMatchObject({ payload: { code: 'doc_changed' } });
    const after = await client.getDocument();
    expect(after.tabs[0]?.paragraphs[0]?.text).toBe(before.tabs[0]?.paragraphs[0]?.text);
    expect(client.applied).toHaveLength(0);
  },
  'docs.undo-restores-styles': async () => {
    // Удалили абзац с жирным фрагментом и заголовок — откат вернул и стили, и вид.
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            docParagraph('Шапка', 'HEADING_2'),
            { runs: [{ text: 'жирно', style: { bold: true } }, { text: ' обычно' }] },
            docParagraph('хвост'),
          ],
        },
      ],
    });
    const client = new FakeDocsClient(doc);
    const snapshot = await client.getDocument();
    const first = snapshot.tabs[0]!.paragraphs[0]!;
    const second = snapshot.tabs[0]!.paragraphs[1]!;
    const journalled: WriteRecord[] = [];
    const range = {
      op: 'deleteRange',
      startIndex: first.startIndex,
      endIndex: second.endIndex,
    } as const;
    const rangePreview = await runDocDelete(client, snapshot, range, {});
    await runDocDelete(client, snapshot, range, {
      dryRun: false,
      confirm: `удаляю диапазон ${first.startIndex}–${second.endIndex}`,
      planId: rangePreview.planId!,
      journal: async (r) => {
        journalled.push(r);
      },
    });
    const undone = await undoDocLast(client, 'doc-fixture', {
      recent: () => Promise.resolve(journalled),
    });
    expect(undone.status).toBe('ok');
    const restored = (await client.getDocument()).tabs[0]!.paragraphs;
    expect(restored[0]?.namedStyle).toBe('HEADING_2');
    expect(restored[1]?.runs.some((r) => r.style?.bold === true)).toBe(true);
  },
  'docs.image-source-remote': async () => {
    // Локальный источник — отказ ДО обращения к Google.
    const client = new FakeDocsClient(forecastDoc());
    try {
      await runDocInsert(
        client,
        await client.getDocument(),
        { op: 'insertInlineImage', tab: 'Черновики', uri: '/Users/anthony/shot.png' },
        { dryRun: false },
      );
      expect.unreachable('локальный источник должен быть отклонён');
    } catch (error) {
      const { payload } = error as { payload: { cause?: string; detail: string } };
      expect(payload.cause).toBe('image.local-source');
      expect(payload.detail).toContain('https');
    }
    expect(client.applied).toHaveLength(0);
  },
  'write.snapshot-max-chars': async () => {
    // Документ: правка, которую нечем вернуть, не делается. Отказ ДО подтверждения.
    const bigDoc = buildDoc({
      tabs: [{ title: 'Т', content: [docParagraph('а'.repeat(25000)), docParagraph('хвост')] }],
    });
    const docsClient = new FakeDocsClient(bigDoc);
    try {
      await runDocDelete(
        docsClient,
        await docsClient.getDocument(),
        { op: 'deleteParagraph', where: { paragraphIndex: 1 } },
        { dryRun: false },
      );
      expect.unreachable('снимок больше бюджета должен отказать');
    } catch (error) {
      const { payload } = error as { payload: { code: string; cause?: string; detail: string } };
      expect(payload.code).toBe('policy_denied');
      expect(payload.cause).toBe('write.snapshot-max-chars');
      expect(payload.detail).toContain('20000');
    }
    expect(limitOf('write.snapshot-max-chars', 0)).toBe(20000);
  },
};
