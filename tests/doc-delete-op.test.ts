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

    const written = await named(
      runDocDelete,
      client,
      request,
      'да, удаляю абзац Устаревший прогноз на прошлый',
      options,
    );
    expect(written.status).toBe('ok');
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
    await named(
      runDocDelete,
      client,
      { op: 'deleteRange', startIndex: first.startIndex, endIndex: third.endIndex },
      `да, удаляю диапазон ${first.startIndex}–${third.endIndex}`,
      options,
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
      await named(
        runDocDelete,
        client,
        { op: 'deleteParagraph', where: { textStartsWith: text } },
        `удаляю абзац ${text}`,
        options,
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
    await named(
      runDocDelete,
      client,
      { op: 'deleteParagraph', where: { paragraphIndex: 1 } },
      'удаляю абзац Шапка',
      options,
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
    await named(
      runDocDelete,
      client,
      { op: 'deleteParagraph', where: { lastParagraph: true } },
      'удаляю абзац последний',
      options,
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

describe('абзац вплотную к таблице (живьём 2026-10-01: Google не даёт удалить перенос)', () => {
  const docWithTable = () =>
    buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [p('до'), p('Перед таблицей'), { table: [['а', 'б']] }, p('Последний')],
        },
      ],
    });
  const body = async (client: FakeDocsClient) =>
    (await client.getDocument()).tabs[0]!.paragraphs.filter((x) => x.inTable === undefined).map(
      (x) => x.text,
    );

  it.each([
    ['Перед таблицей', ['до', '', 'Последний']],
    ['Последний', ['до', 'Перед таблицей', '']],
  ])(
    '«%s»: уходит текст, строка остаётся, план это говорит; откат возвращает',
    async (text, gone) => {
      const client = fresh(docWithTable());
      const request = { op: 'deleteParagraph', where: { textStartsWith: text } } as const;
      const preview = await runDocDelete(client, await client.getDocument(), request, options());
      expect(preview.notes.join(' ')).toContain('Google удалить не даёт');
      const written = await named(runDocDelete, client, request, `удаляю абзац ${text}`, options);
      expect(written.status).toBe('ok');
      expect(await body(client)).toEqual(gone);
      expect((await client.getDocument()).tabs[0]!.tables[0]!.cells).toEqual([['а', 'б']]);
      await undoDocLast(client, 'doc-fixture', source(), {});
      expect(await body(client)).toEqual(['до', 'Перед таблицей', 'Последний']);
    },
  );
});

describe('цепочка откатов (находки читателя 2026-10-01)', () => {
  const undoJournal = { journal: async (r: WriteRecord) => void journalled.push(r) };
  const texts = async (client: FakeDocsClient) =>
    (await client.getDocument()).tabs[0]!.paragraphs.map((x) => x.text);

  it('два удаления → два «откати» подряд проходят без force: свой откат — не чужая правка', async () => {
    const client = fresh(styledDoc());
    const original = await texts(client);
    for (const text of ['последний', 'пункт списка']) {
      await named(
        runDocDelete,
        client,
        { op: 'deleteParagraph', where: { textStartsWith: text } },
        `удаляю абзац ${text}`,
        options,
      );
    }
    expect((await undoDocLast(client, 'doc-fixture', source(), undoJournal)).status).toBe('ok');
    // Раньше: revision_conflict «после удаления документ правили» — правили МЫ, откатом.
    expect((await undoDocLast(client, 'doc-fixture', source(), undoJournal)).status).toBe('ok');
    expect(await texts(client)).toEqual(original);
  });

  it('откат по id уже откаченной записи — «уже откачена», и force этого не меняет', async () => {
    const client = fresh(styledDoc());
    await named(
      runDocDelete,
      client,
      { op: 'deleteParagraph', where: { textStartsWith: 'последний' } },
      'удаляю абзац последний',
      options,
    );
    const id = journalled[0]!.correlationId;
    await undoDocLast(client, 'doc-fixture', source(), undoJournal);
    const before = await texts(client);
    const again = await undoDocLast(client, 'doc-fixture', source(), {
      ...undoJournal,
      correlationId: id,
      force: true,
    });
    expect(again.status).toBe('nothing_to_undo');
    expect(again.reason).toBe('already_undone');
    expect(await texts(client)).toEqual(before);
  });

  it('старую запись без id не откатывает и force; по id — откатывает', async () => {
    const client = fresh(styledDoc());
    await named(
      runDocDelete,
      client,
      { op: 'deleteParagraph', where: { textStartsWith: 'последний' } },
      'удаляю абзац последний',
      options,
    );
    const old = { ...journalled[0]!, at: new Date(Date.now() - 2 * 3600_000).toISOString() };
    journalled[0] = old;
    await expect(
      undoDocLast(client, 'doc-fixture', source(), { ...undoJournal, force: true }),
    ).rejects.toMatchObject({ payload: { cause: 'undo_target_too_old' } });
    const byId = await undoDocLast(client, 'doc-fixture', source(), {
      ...undoJournal,
      correlationId: old.correlationId,
    });
    expect(byId.status).toBe('ok');
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
