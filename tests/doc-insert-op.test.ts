/**
 * Вставка текста в документ и её откат (уровень 3, слайс 4): P1, P2, P3, P4.
 * Контур D-16: превью с кодом → подпись → однократность; предусловие — серверное.
 */

import { describe, expect, it } from 'vitest';

import { runDocInsert, type DocRunOptions } from '../src/core/docs/insert-op.js';
import { undoDocLast, textInRange } from '../src/core/undo-docs.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';

const journalled: WriteRecord[] = [];
const source = (): JournalSource => ({
  recent: () => Promise.resolve([...journalled]),
});
const options = (over: Partial<DocRunOptions> = {}): DocRunOptions => ({
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: source(),
  account: 'default',
  alias: 'forecast',
  ...over,
});

const freshClient = () => {
  journalled.length = 0;
  return new FakeDocsClient(forecastDoc());
};

/** Превью → запись тем же кодом — как это делает человек. */
async function confirmed(client: FakeDocsClient, request: Parameters<typeof runDocInsert>[2]) {
  const snapshot = await client.getDocument();
  const preview = await runDocInsert(client, snapshot, request, options({ dryRun: true }));
  expect(preview.status).toBe('preview');
  const written = await runDocInsert(
    client,
    await client.getDocument(),
    request,
    options({ dryRun: false, confirm: preview.planId! }),
  );
  return { preview, written };
}

describe('P1, P2 — appendText в конец раздела: план с якорем, запись по коду', () => {
  it('превью называет якорь и не пишет; запись с кодом кладёт строку журнала', async () => {
    const client = freshClient();
    const { preview, written } = await confirmed(client, {
      op: 'appendText',
      text: 'Судья: Раморенко',
      tab: 'Прогноз',
      afterHeading: 'Составы',
    });
    expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(preview.changes[0]!.anchor).toContain('в конец раздела «Составы»');
    expect(written.status).toBe('ok');
    expect(written.revisionAfter).toBe('rev-forecast-1+1');

    const after = await client.getDocument();
    const paragraphs = after.tabs[0]!.paragraphs;
    const added = paragraphs.find((p) => p.text === 'Судья: Раморенко')!;
    const heading = paragraphs.find((p) => p.text === 'Прогноз')!;
    const table = after.tabs[0]!.tables[0]!;
    // Раздел «Составы» кончается таблицей: «в конец раздела» — ПОСЛЕ таблицы и перед
    // «Прогнозом» (находка читателя 2026-10-01: раньше абзац вставал ПЕРЕД таблицей, а
    // оракул проверял только «раньше следующего заголовка»).
    expect(added.startIndex).toBe(table.endIndex);
    expect(added.endIndex).toBe(heading.startIndex);
    expect(added.namedStyle).toBe('NORMAL_TEXT');
    expect(heading.namedStyle).toBe('HEADING_2');

    expect(journalled).toHaveLength(1);
    const record = journalled[0]!;
    expect(record.op).toBe('appendText');
    expect(record.doc?.inserted).toBe('Судья: Раморенко\n');
    expect(record.revisionBefore).toBe('rev-forecast-1');
    expect(record.revisionAfter).toBe('rev-forecast-1+1');
  });

  it('запись без кода — confirm_required с планом; голая повторная запись тем же кодом — plan_already_applied', async () => {
    const client = freshClient();
    const request = { op: 'appendText', text: 'Х', tab: 'Черновики' } as const;
    const bare = await runDocInsert(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false }),
    );
    expect(bare.status).toBe('confirm_required');
    expect(bare.planId).toMatch(/^[0-9a-f]{6}$/);

    const { written } = await confirmed(client, request);
    expect(written.status).toBe('ok');
    await expect(
      runDocInsert(
        client,
        await client.getDocument(),
        request,
        options({ dryRun: false, confirm: written.planId! }),
      ),
    ).rejects.toMatchObject({ payload: { code: 'plan_already_applied' } });
  });

  it('код плана привязан к ревизии: после чужой правки прежний код не принимается', async () => {
    const client = freshClient();
    const snapshot = await client.getDocument();
    const request = { op: 'appendText', text: 'Х', tab: 'Черновики' } as const;
    const preview = await runDocInsert(client, snapshot, request, options({ dryRun: true }));
    // Чужая правка между превью и записью: ревизия ушла.
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't2', at: 1, text: 'чужое ' }],
      'rev-forecast-1',
    );
    const second = await runDocInsert(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: preview.planId! }),
    );
    // Не doc_changed от сервера, а новый план ОТ ПОДПИСИ: межвызовный дрейф ловит код.
    expect(second.status).toBe('confirm_required');
    expect(second.planId).not.toBe(preview.planId);
  });
});

describe('insertText — вставка после абзаца-якоря', () => {
  it('вставляет новый абзац после якоря; неоднозначный якорь — вопрос (P10)', async () => {
    const client = freshClient();
    const { written } = await confirmed(client, {
      op: 'insertText',
      text: 'Погода: дождь',
      tab: 'Прогноз',
      where: { textStartsWith: 'Ставим на победу' },
    });
    expect(written.status).toBe('ok');
    const after = await client.getDocument();
    const texts = after.tabs[0]!.paragraphs.map((p) => p.text);
    expect(texts[texts.indexOf('Ставим на победу Fluminense со счётом 2:1.') + 1]).toBe(
      'Погода: дождь',
    );

    const vague = await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertText', text: 'х', tab: 'Прогноз', where: { textContains: 'прогноз' } },
      options(),
    );
    expect(vague.status).toBe('needs_clarification');
    expect(vague.questions[0]!.candidates.length).toBeGreaterThan(1);
  });

  it('якорь в ячейке таблицы — отказ с советом, два условия в селекторе — вопрос', async () => {
    const client = freshClient();
    const inTable = await runDocInsert(
      client,
      await client.getDocument(),
      { op: 'insertText', text: 'х', tab: 'Прогноз', where: { textStartsWith: 'Иванов' } },
      options(),
    );
    expect(inTable.status).toBe('needs_clarification');
    expect(inTable.questions[0]!.detail).toContain('таблиц');

    const twoKeys = await runDocInsert(
      client,
      await client.getDocument(),
      {
        op: 'insertText',
        text: 'х',
        tab: 'Прогноз',
        where: { paragraphIndex: 2, textContains: 'форму' },
      },
      options(),
    );
    expect(twoKeys.status).toBe('needs_clarification');
    expect(twoKeys.questions[0]!.detail).toContain('оставь одно');
  });
});

describe('P3, P4 — откат вставки', () => {
  it('P3: откат удаляет вставленное, соседний текст и стили целы', async () => {
    const client = freshClient();
    const original = await client.getDocument();
    await confirmed(client, {
      op: 'appendText',
      text: 'Судья: Раморенко',
      tab: 'Прогноз',
      afterHeading: 'Составы',
    });
    const outcome = await undoDocLast(client, 'doc-fixture', source(), {
      journal: async (r) => {
        journalled.push(r);
      },
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.docUndone).toContain('Судья: Раморенко');
    const after = await client.getDocument();
    const texts = after.tabs[0]!.paragraphs.map((p) => p.text);
    expect(texts).not.toContain('Судья: Раморенко');
    expect(texts).toContain('Основа выйдет без ротации, Fluminense FC подтвердил заявку.');
    // Жирный прогон второго абзаца пережил цикл вставка→откат.
    expect(after.tabs[0]!.paragraphs[1]!.runs.some((r) => r.style?.bold === true)).toBe(true);
    // Документ после отката РАВЕН документу до вставки — абзацы, их вид, границы и
    // таблицы: сдвиг начала удаления на +1 оставлял лишний пустой абзац при зелёном тесте
    // (находка читателя 2026-10-01).
    expect(after.tabs).toEqual(original.tabs);
  });

  it('P4: вставленное правили — отказ revision_conflict, ни одной правки', async () => {
    const client = freshClient();
    const { written } = await confirmed(client, {
      op: 'appendText',
      text: 'Судья: Раморенко',
      tab: 'Прогноз',
      afterHeading: 'Составы',
    });
    // Человек дописал внутрь вставленного абзаца.
    const doc = journalled[0]!.doc!;
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: doc.endIndex - 1, text: ' (уточнить!)' }],
      written.revisionAfter!,
    );
    await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
      payload: { code: 'revision_conflict' },
    });
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs.map((p) => p.text).join(' ')).toContain('(уточнить!)');
  });

  it('после отката запись снова видна как «нечего откатывать» с честным счётом', async () => {
    const client = freshClient();
    await confirmed(client, { op: 'appendText', text: 'Х', tab: 'Черновики' });
    const undoJournal = async (r: WriteRecord) => {
      journalled.push(r);
    };
    await undoDocLast(client, 'doc-fixture', source(), { journal: undoJournal });
    const again = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(again.status).toBe('nothing_to_undo');
    expect(again.reason).toBe('all_undone');
  });
});

describe('textInRange — сборка текста диапазона', () => {
  it('через границу абзацев собирает с переносами; таблица в диапазоне — null', () => {
    const tab = forecastDoc().tabs[1]!;
    const first = tab.paragraphs[0]!;
    const second = tab.paragraphs[1]!;
    expect(textInRange(tab, first.endIndex - 1, second.startIndex + 8)).toBe('\nЧерновик');
    const withTable = forecastDoc().tabs[0]!;
    const table = withTable.tables[0]!;
    expect(textInRange(withTable, table.startIndex - 1, table.startIndex + 3)).toBeNull();
  });
});

describe('P15, P17 на пути записи (находка читателя 2026-10-01: проверялись только чтение и шов)', () => {
  it('P15: без tab в двух табах — отказ с их перечнем; с tab — абзац встаёт именно там', async () => {
    const client = freshClient();
    await expect(
      runDocInsert(
        client,
        await client.getDocument(),
        { op: 'insertText', text: 'х', where: { textContains: 'прогноз' } },
        options({ dryRun: false, authorize: () => ({ authorized: true }) }),
      ),
    ).rejects.toMatchObject({ payload: { detail: expect.stringContaining('Прогноз, Черновики') } });
    const written = await confirmed(client, {
      op: 'insertText',
      text: 'Новая заметка',
      tab: 'Черновики',
      where: { textStartsWith: 'Черновик заметки' },
    });
    expect(written.written.status).toBe('ok');
    const after = await client.getDocument();
    expect(after.tabs[1]!.paragraphs.map((p) => p.text)).toContain('Новая заметка');
    expect(after.tabs[0]!.paragraphs.map((p) => p.text)).not.toContain('Новая заметка');
  });

  it('P17: вставка после абзаца с эмодзи — ПОСЛЕ пары, обе половины целы', async () => {
    const client = freshClient();
    await confirmed(client, {
      op: 'insertText',
      text: 'Судья: Раморенко',
      tab: 'Прогноз',
      where: { textStartsWith: 'Изучаем форму' },
    });
    const paragraphs = (await client.getDocument()).tabs[0]!.paragraphs;
    const emoji = paragraphs.find((p) => p.text.startsWith('Изучаем форму'))!;
    const added = paragraphs.find((p) => p.text === 'Судья: Раморенко')!;
    expect(emoji.text.endsWith('😀')).toBe(true);
    // Пара целиком: ни одной одинокой половины суррогата в тексте.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji.text),
    ).toBe(false);
    expect(added.startIndex).toBe(emoji.endIndex);
  });
});
