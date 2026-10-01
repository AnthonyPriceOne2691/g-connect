/**
 * Замены (уровень 3, слайс 6b): P5, P6, P6b, P7. Откат по снимку позиций, не обратной
 * заменой; «Fluminense FC», бывший в тексте ДО правки, не тронут.
 */

import { describe, expect, it } from 'vitest';

import { runDocReplace } from '../src/core/docs/replace-op.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import type { DocRunOptions } from '../src/core/docs/write-support.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';
import { named } from './fixtures/named.js';

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
const fresh = () => {
  journalled.length = 0;
  return new FakeDocsClient(forecastDoc());
};

describe('P5 — превью массовой замены: счёт по табам, вхождения с контекстом', () => {
  it('считает вхождения по табам и просит название; записи нет даже в конверте', async () => {
    const client = fresh();
    const preview = await runDocReplace(
      client,
      await client.getDocument(),
      { op: 'replaceAllText', find: 'Fluminense', replace: 'Fluminense FC' },
      options({
        dryRun: false,
        authorize: () => ({ authorized: true }),
      }),
    );
    expect(preview.status).toBe('confirm_required');
    expect(preview.notes.join(' ')).toContain('Прогноз: 4');
    expect(preview.notes.join(' ')).toContain('Черновики: 1');
    expect(journalled).toHaveLength(0);
  });

  it('P6b-класс: голое «да» не проходит, чужой код различён', async () => {
    const client = fresh();
    const bare = await runDocReplace(
      client,
      await client.getDocument(),
      { op: 'replaceAllText', find: 'Fluminense', replace: 'FC' },
      options({ dryRun: false, confirm: 'да' }),
    );
    expect(bare.status).toBe('confirm_required');
    expect(bare.notes.join(' ')).toContain('заменяю Fluminense');
    const wrongCode = await runDocReplace(
      client,
      await client.getDocument(),
      { op: 'replaceAllText', find: 'Fluminense', replace: 'FC' },
      options({ dryRun: false, confirm: 'ffffff' }),
    );
    expect(wrongCode.notes.join(' ')).toContain('а у этого плана код');
  });
});

describe('поправка D-20 (2026-10-01): фраза пишет только с кодом плана из превью', () => {
  const request = { op: 'replaceAllText', find: 'Fluminense', replace: 'Fluminense FC' } as const;
  const docText = async (client: FakeDocsClient) =>
    (await client.getDocument()).tabs.flatMap((t) => t.paragraphs.map((x) => x.text)).join('\n');

  it('повтор «да, заменяю Fluminense» с кодом прежнего превью второй замены не делает', async () => {
    // Находка читателя: фраза — не код, и охранник «один план — одна запись» её не видел;
    // второй вызов давал «Fluminense FC FC» по всем табам.
    const client = fresh();
    const preview = await runDocReplace(client, await client.getDocument(), request, options());
    const first = await runDocReplace(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да, заменяю Fluminense', planId: preview.planId! }),
    );
    expect(first.status).toBe('ok');
    // «Fluminense FC» был в тексте ДО правки — одна замена законно даёт там «FC FC»;
    // вторая дала бы «FC FC FC» и задела бы всё остальное.
    const once = await docText(client);
    expect(once).not.toContain('FC FC FC');

    await expect(
      runDocReplace(
        client,
        await client.getDocument(),
        request,
        options({ dryRun: false, confirm: 'да, заменяю Fluminense', planId: preview.planId! }),
      ),
    ).rejects.toMatchObject({ payload: { code: 'plan_already_applied' } });
    expect(await docText(client)).toBe(once);
  });

  it('фраза без кода плана — записи нет, ответ просит приложить код', async () => {
    const client = fresh();
    const before = await docText(client);
    const outcome = await runDocReplace(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да, заменяю Fluminense' }),
    );
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('не приложен код плана');
    expect(await docText(client)).toBe(before);
  });

  it('документ правили между превью и записью — фраза со старым кодом не пишет', async () => {
    const client = fresh();
    const preview = await runDocReplace(client, await client.getDocument(), request, options());
    const doc = await client.getDocument();
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: 1, text: 'чужая правка ' }],
      doc.revisionId,
    );
    const before = await docText(client);
    const outcome = await runDocReplace(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: 'да, заменяю Fluminense', planId: preview.planId! }),
    );
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('план изменился с превью');
    expect(outcome.planId).not.toBe(preview.planId);
    expect(await docText(client)).toBe(before);
  });
});

describe('P6, P7 — запись названием и откат по снимку позиций', () => {
  it('замена пишется фразой; откат возвращает исходные вхождения, не тронув старый «Fluminense FC»', async () => {
    const client = fresh();
    const written = await named(
      runDocReplace,
      client,
      { op: 'replaceAllText', find: 'Fluminense', replace: 'Fluminense FC' },
      'да, заменяю Fluminense',
      options,
    );
    expect(written.status).toBe('ok');
    const after = await client.getDocument();
    const allText = after.tabs.map((t) => t.paragraphs.map((p) => p.text).join('\n')).join('\n');
    // Было одно «Fluminense FC» до правки — теперь «Fluminense FC FC» (замена честная),
    // остальные стали «Fluminense FC».
    expect(allText).toContain('Fluminense FC FC подтвердил заявку');
    expect(allText).toContain('матч Fluminense FC — Palmeiras');
    expect(journalled[0]!.doc?.replacements).toHaveLength(5);

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(undone.docUndone).toContain('5 вхождений');
    const restored = await client.getDocument();
    const restoredText = restored.tabs
      .map((t) => t.paragraphs.map((p) => p.text).join('\n'))
      .join('\n');
    // Всё вернулось: и обычные вхождения, и «Fluminense FC», бывший в тексте ДО правки.
    expect(restoredText).toContain('матч Fluminense — Palmeiras');
    expect(restoredText).toContain('Fluminense FC подтвердил заявку');
    expect(restoredText).not.toContain('FC FC');
  });

  it('жирный кусок внутри заменённого вхождения возвращается жирным', async () => {
    const client = fresh();
    // «Fluminense» во втором абзаце таба «Прогноз» — жирный прогон.
    await named(
      runDocReplace,
      client,
      { op: 'replaceAllText', find: 'Fluminense', replace: 'X' },
      'заменяю Fluminense',
      options,
    );
    await undoDocLast(client, 'doc-fixture', source(), {});
    const restored = await client.getDocument();
    const second = restored.tabs[0]!.paragraphs[1]!;
    expect(
      second.runs
        .filter((r) => r.style?.bold === true)
        .map((r) => r.text)
        .join(''),
    ).toBe('Fluminense');
  });

  it('документ правили после замены — откат отказывает, force открывает', async () => {
    const client = fresh();
    const written = await named(
      runDocReplace,
      client,
      { op: 'replaceAllText', find: 'прогноз', replace: 'разбор' },
      'заменяю прогноз',
      options,
    );
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: 1, text: 'сдвиг ' }],
      written.revisionAfter!,
    );
    await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
      payload: { cause: 'doc_moved_after_replace' },
    });
  });
});

describe('замена получает стиль заменённого (находка читателя 2026-10-01)', () => {
  // «Изучаем форму **Fluminense** перед дерби»: вставка наследует стиль соседа слева, и
  // без явного стиля жирное вхождение становилось обычным «Fluminense FC».
  const boldParts = async (client: FakeDocsClient) =>
    (await client.getDocument()).tabs[0]!.paragraphs[1]!.runs.filter((r) => r.style?.bold === true)
      .map((r) => r.text)
      .join('');

  it('replaceText: жирное вхождение остаётся жирным, соседи — обычными', async () => {
    const client = fresh();
    const request = {
      op: 'replaceText',
      tab: 'Прогноз',
      where: { textStartsWith: 'Изучаем форму' },
      find: 'Fluminense',
      replace: 'Fluminense FC',
    } as const;
    const preview = await runDocReplace(client, await client.getDocument(), request, options());
    const written = await runDocReplace(
      client,
      await client.getDocument(),
      request,
      options({ dryRun: false, confirm: preview.planId! }),
    );
    expect(written.status).toBe('ok');
    expect(await boldParts(client)).toBe('Fluminense FC');
  });

  it('replaceAllText: то же у каждого вхождения', async () => {
    const client = fresh();
    await named(
      runDocReplace,
      client,
      { op: 'replaceAllText', find: 'Fluminense', replace: 'Fluminense FC' },
      'да, заменяю Fluminense',
      options,
    );
    expect(await boldParts(client)).toBe('Fluminense FC');
  });
});

describe('replaceText — точечная замена в пределах абзаца', () => {
  it('конвертная: в пределах маленького конверта пишет с первой фразы, вне абзаца не трогает', async () => {
    const client = fresh();
    const outcome = await runDocReplace(
      client,
      await client.getDocument(),
      {
        op: 'replaceText',
        tab: 'Прогноз',
        where: { textStartsWith: 'Ставим на победу' },
        find: '2:1',
        replace: '3:1',
      },
      options({ dryRun: false, authorize: () => ({ authorized: true }) }),
    );
    expect(outcome.status).toBe('ok');
    const after = await client.getDocument();
    const texts = after.tabs[0]!.paragraphs.map((p) => p.text);
    expect(texts).toContain('Ставим на победу Fluminense со счётом 3:1.');
    // Другие абзацы с «Fluminense» не тронуты — область была одним абзацем.
    expect(texts.join(' ')).toContain('матч Fluminense — Palmeiras');
  });

  it('нет вхождений — no_change с честным текстом; вхождения в таблицах названы числом', async () => {
    const client = fresh();
    const outcome = await named(
      runDocReplace,
      client,
      { op: 'replaceAllText', find: 'Иванов', replace: 'Смирнов' },
      'заменяю Иванов',
      options,
    );
    expect(outcome.status).toBe('no_change');
    expect(outcome.notes.join(' ')).toContain('в ячейках таблиц: 1');
    expect(journalled).toHaveLength(0);
  });
});
