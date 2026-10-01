/**
 * Удаление абзаца/диапазона и откат снимком (уровень 3, слайс 6a): P8, P9, P18, P6b-класс.
 * Порядок охранников (L11): бюджет — ДО подтверждения; голое «да» не проходит (D-20).
 */

import { describe, expect, it } from 'vitest';

import { runDocDelete, snapshotRange } from '../src/core/docs/delete-op.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import type { DocRunOptions } from '../src/core/docs/insert-op.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, buildDoc, forecastDoc, p, runs } from './fixtures/doc.js';

const journalled: WriteRecord[] = [];
const source = (): JournalSource => ({ recent: () => Promise.resolve([...journalled]) });
const options = (over: Partial<DocRunOptions> = {}): DocRunOptions => ({
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: source(),
  account: 'default',
  alias: 'forecast',
  ...over,
});

const styledDoc = () =>
  buildDoc({
    tabs: [
      {
        title: 'Т',
        content: [
          p('Шапка', 'HEADING_2'),
          runs({ text: 'Обычный ' }, { text: 'жирный', style: { bold: true } }, { text: ' хвост' }),
          { runs: [{ text: 'пункт списка' }], bulleted: true },
          p('последний'),
        ],
      },
    ],
  });

const fresh = (doc = forecastDoc()) => {
  journalled.length = 0;
  return new FakeDocsClient(doc);
};

describe('P8 — план удаления: текст целиком, подтверждение названием', () => {
  it('превью показывает текст абзаца и фразу; голое «да» не проходит; фраза с предметом пишет', async () => {
    const client = fresh();
    const request = {
      op: 'deleteParagraph',
      tab: 'Черновики',
      where: { textStartsWith: 'Устаревший прогноз' },
    } as const;
    const preview = await runDocDelete(client, await client.getDocument(), request, options());
    expect(preview.status).toBe('preview');
    expect(preview.changes[0]!.before).toContain('Устаревший прогноз на прошлый тур');
    expect(preview.notes.join(' ')).toContain('удаляю абзац Устаревший');

    const bareYes = await runDocDelete(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да' }),
    );
    expect(bareYes.status).toBe('confirm_required');
    expect(bareYes.notes.join(' ')).toContain('предметом правки не называет');

    const named = await runDocDelete(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да, удаляю абзац Устаревший прогноз на прошлый' }),
    );
    expect(named.status).toBe('ok');
    const after = await client.getDocument();
    expect(after.tabs[1]!.paragraphs.map((x) => x.text).join(' ')).not.toContain('Устаревший');
    expect(journalled[0]!.doc?.snapshot?.runs.map((r) => r.text).join('')).toContain(
      'Устаревший прогноз',
    );
  });

  it('чужой код плана — plan-стиль отказа, а не «одного да недостаточно»', async () => {
    const client = fresh();
    const request = {
      op: 'deleteParagraph',
      tab: 'Черновики',
      where: { textStartsWith: 'Черновик заметки' },
    } as const;
    const outcome = await runDocDelete(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'ffffff' }),
    );
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('а у этого плана код');
  });
});

describe('P18 — бюджет снимка ДО подтверждения (порядок L11)', () => {
  it('большой диапазон отклоняется с обоими числами, не спрашивая подписи', async () => {
    const big = buildDoc({
      tabs: [{ title: 'Т', content: [p('а'.repeat(25000)), p('хвост')] }],
    });
    const client = fresh(big);
    await expect(
      runDocDelete(
        client,
        await client.getDocument(),
        { op: 'deleteParagraph', where: { paragraphIndex: 1 } },
        options({ dryRun: false }),
      ),
    ).rejects.toMatchObject({
      payload: { cause: 'write.snapshot-max-chars' },
    });
    expect(journalled).toHaveLength(0);
  });
});

describe('P9 — откат возвращает текст СО СТИЛЯМИ и видом абзацев', () => {
  it('удалённый жирный кусок вернулся жирным, заголовок — заголовком, список — списком', async () => {
    const client = fresh(styledDoc());
    // Удаляем три первых абзаца одним диапазоном (заголовок + жирный + буллет).
    const before = await client.getDocument();
    const first = before.tabs[0]!.paragraphs[0]!;
    const third = before.tabs[0]!.paragraphs[2]!;
    await runDocDelete(
      client,
      before,
      { op: 'deleteRange', startIndex: first.startIndex, endIndex: third.endIndex },
      options({
        dryRun: false,
        confirm: `да, удаляю диапазон ${first.startIndex}–${third.endIndex}`,
      }),
    );
    const gone = await client.getDocument();
    expect(gone.tabs[0]!.paragraphs.map((x) => x.text)).toEqual(['последний']);

    const outcome = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(outcome.status).toBe('ok');
    expect(outcome.docUndone).toContain('со стилями');
    const restored = await client.getDocument();
    const texts = restored.tabs[0]!.paragraphs.map((x) => x.text);
    expect(texts).toEqual(['Шапка', 'Обычный жирный хвост', 'пункт списка', 'последний']);
    expect(restored.tabs[0]!.paragraphs[0]!.namedStyle).toBe('HEADING_2');
    expect(restored.tabs[0]!.paragraphs[2]!.bulleted).toBe(true);
    const midRuns = restored.tabs[0]!.paragraphs[1]!.runs;
    expect(
      midRuns
        .filter((r) => r.style?.bold === true)
        .map((r) => r.text)
        .join(''),
    ).toBe('жирный');
  });

  it('обычный абзац перед заголовком или списком возвращается обычным, а не видом соседа', async () => {
    // Вставка наследует вид абзаца, в который вставлена: восстановленный абзац ложится в
    // начало СЛЕДУЮЩЕГО. Вид без условий — та же мысль, что у отката стилей (найдено
    // чтением 2026-10-01: две копии «вида абзаца» разошлись, класс L21).
    const client = fresh(
      buildDoc({
        tabs: [
          {
            title: 'Т',
            content: [
              p('Раздел', 'HEADING_2'),
              p('обычный перед заголовком'),
              p('Следующий', 'HEADING_2'),
              p('обычный перед списком'),
              { runs: [{ text: 'пункт' }], bulleted: true },
              p('хвост'),
            ],
          },
        ],
      }),
    );
    const view = async (text: string) => {
      const found = (await client.getDocument()).tabs[0]!.paragraphs.find((x) => x.text === text)!;
      return `${found.namedStyle}${found.bulleted === true ? ' •' : ''}`;
    };
    for (const text of ['обычный перед заголовком', 'обычный перед списком']) {
      await runDocDelete(
        client,
        await client.getDocument(),
        { op: 'deleteParagraph', where: { textStartsWith: text } },
        options({ dryRun: false, confirm: `удаляю абзац ${text}` }),
      );
      await undoDocLast(client, 'doc-fixture', source(), {});
      expect(await view(text)).toBe('NORMAL_TEXT');
    }
    expect(await view('Следующий')).toBe('HEADING_2');
    expect(await view('пункт')).toBe('NORMAL_TEXT •');
  });

  it('документ правили после удаления — откат отказывает: снимок лёг бы не туда', async () => {
    const client = fresh(styledDoc());
    const before = await client.getDocument();
    const first = before.tabs[0]!.paragraphs[0]!;
    await runDocDelete(
      client,
      before,
      { op: 'deleteParagraph', where: { paragraphIndex: 1 } },
      options({ dryRun: false, confirm: 'удаляю абзац Шапка' }),
    );
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: first.startIndex, text: 'сдвиг ' }],
      (await client.getDocument()).revisionId,
    );
    await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
      payload: { code: 'revision_conflict', cause: 'doc_moved_after_delete' },
    });
  });

  it('удаление последнего абзаца уводит диапазон на перенос предыдущего — и откатывается', async () => {
    const client = fresh(styledDoc());
    await runDocDelete(
      client,
      await client.getDocument(),
      { op: 'deleteParagraph', where: { lastParagraph: true } },
      options({ dryRun: false, confirm: 'удаляю абзац последний' }),
    );
    const gone = await client.getDocument();
    expect(gone.tabs[0]!.paragraphs.map((x) => x.text)).toEqual([
      'Шапка',
      'Обычный жирный хвост',
      'пункт списка',
    ]);
    const outcome = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(outcome.status).toBe('ok');
    expect((await client.getDocument()).tabs[0]!.paragraphs.map((x) => x.text)).toEqual([
      'Шапка',
      'Обычный жирный хвост',
      'пункт списка',
      'последний',
    ]);
  });
});

describe('снимок диапазона', () => {
  it('хранит прогоны со стилями, переносы и вид абзацев', () => {
    const tab = styledDoc().tabs[0]!;
    const first = tab.paragraphs[0]!;
    const third = tab.paragraphs[2]!;
    const snapshot = snapshotRange(tab, first.startIndex, third.endIndex)!;
    expect(snapshot.runs.map((r) => r.text).join('')).toBe(
      'Шапка\nОбычный жирный хвост\nпункт списка\n',
    );
    expect(snapshot.paragraphs).toEqual([
      { offset: 0, namedStyle: 'HEADING_2' },
      { offset: 6, namedStyle: 'NORMAL_TEXT' },
      { offset: 27, namedStyle: 'NORMAL_TEXT', bulleted: true },
    ]);
    // Диапазон через таблицу не снимается.
    const forecast = forecastDoc().tabs[0]!;
    const table = forecast.tables[0]!;
    expect(snapshotRange(forecast, table.startIndex - 2, table.startIndex + 4)).toBeNull();
  });
});
