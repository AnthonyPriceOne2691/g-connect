/**
 * Подсветка фразы в документе (27.11): фон текста `background` и фраза `fragment` у
 * updateTextStyle. Drive API не привязывает свой комментарий к тексту Docs — редактор
 * показывает его без якоря, — поэтому видимая часть «своего комментария» — настоящее
 * выделение. Числа позиций — по правилам Docs API (UTF-16, объект — 1 юнит), а не из ядра.
 */

import { describe, expect, it } from 'vitest';

import { updateTextStyleOp } from '../src/core/docs/ops.js';
import { runDocStyle, type DocStyleRequest } from '../src/core/docs/style-op.js';
import {
  OBJECT_MARK,
  type DocParagraph,
  type DocSnapshot,
  type DocTextRun,
  type DocTextStyle,
} from '../src/core/docs/types.js';
import type { DocRunOptions, DocWhere } from '../src/core/docs/write-support.js';
import { toDocRequest } from '../src/core/google/doc-requests.js';
import { toDocSnapshot } from '../src/core/google/docs.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import { FakeDocsClient, buildDoc, forecastDoc, p, runs } from './fixtures/doc.js';

const journalled: WriteRecord[] = [];
const source: JournalSource = { recent: () => Promise.resolve([...journalled]) };
const write: DocRunOptions = {
  dryRun: false,
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: source,
  authorize: () => ({ authorized: true }),
};
const fresh = (doc: DocSnapshot) => {
  journalled.length = 0;
  return new FakeDocsClient(doc);
};
const style = async (client: FakeDocsClient, request: DocStyleRequest, options = write) =>
  runDocStyle(client, await client.getDocument(), request, options);
const undo = (client: FakeDocsClient) => undoDocLast(client, 'doc-fixture', source, {});

/** «Ставим на победу Fluminense со счётом 2:1.»: «Ставим на победу » — 17 юнитов. */
const STAVIM = { textStartsWith: 'Ставим' } as const;
/** Подсветка фразы в абзаце `where` таба «Прогноз»; без фразы — абзац целиком. */
const hl = (fragment?: string, where: DocWhere = STAVIM, background = '#fff2cc') =>
  ({ op: 'updateTextStyle', tab: 'Прогноз', where, style: { background }, fragment }) as const;

/** Абзац под заголовком «Итоги» [1, 7): он начинается с юнита 7, адрес — `paragraphIndex: 2`. */
const one = (...parts: DocTextRun[]) =>
  buildDoc({ tabs: [{ title: 'Прогноз', content: [p('Итоги', 'HEADING_2'), runs(...parts)] }] });
const SECOND = { paragraphIndex: 2 } as const;
const paragraphOf = async (client: FakeDocsClient, starts: string): Promise<DocParagraph> =>
  (await client.getDocument()).tabs[0]!.paragraphs.find((x) => x.text.startsWith(starts))!;

/** Вид по юнитам: фейк не сливает соседние прогоны одного вида, Google сливает — судим юниты. */
const unitStyles = (paragraph: DocParagraph) =>
  paragraph.runs.flatMap((run) => Array.from({ length: run.text.length }, () => run.style ?? null));

/** Что выделено: прогоны с фоном-цветом (`none` — прозрачный, не выделение). */
const marked = (paragraph: DocParagraph): string[] =>
  paragraph.runs.filter((r) => (r.style?.background ?? 'none') !== 'none').map((r) => r.text);

/** Доменный запрос вида и его форма в библиотеке — по документации Docs API. */
const restyle = (startIndex: number, endIndex: number, style: DocTextStyle, exact?: true) => ({
  kind: 'updateTextStyle' as const,
  tabId: 't1',
  startIndex,
  endIndex,
  style,
  ...(exact === undefined ? {} : { exact }),
});
const google = (
  startIndex: number,
  endIndex: number,
  textStyle: object,
  fields = 'backgroundColor',
) => ({
  updateTextStyle: { range: { startIndex, endIndex, tabId: 't1' }, textStyle, fields },
});
const CREAM = { red: 1, green: 242 / 255, blue: 204 / 255 };

describe('Z6 — фон ставится фразе: запрос, маска, превью', () => {
  it('Z6: фон только на фразе — её диапазон, backgroundColor и маска в запросе Google', async () => {
    const client = fresh(forecastDoc());
    const at = (await paragraphOf(client, 'Ставим')).startIndex + 17;
    expect((await style(client, hl('Fluminense'))).status).toBe('ok');
    expect(client.applied).toEqual([[restyle(at, at + 10, { background: '#fff2cc' })]]);
    expect(toDocRequest(client.applied[0]![0]!)).toEqual(
      google(at, at + 10, { backgroundColor: { color: { rgbColor: CREAM } } }),
    );
    expect(marked(await paragraphOf(client, 'Ставим'))).toEqual(['Fluminense']);
  });

  it('Z6: превью называет фразу и её юниты; код плана не равен коду абзаца целиком', async () => {
    const client = fresh(forecastDoc());
    const piece = await style(client, hl('Fluminense'), {});
    const whole = await style(client, hl(), {});
    expect(piece.planId).not.toBe(whole.planId);
    expect(piece.changes[0]!.anchor).toMatch(/^фраза «Fluminense» в абзаце № \d+: Ставим на/);
    expect(piece.notes).toEqual([
      'Только фраза «Fluminense» (10 юнитов): текст не меняется, остальной абзац не трогается. ' +
        'Откат вернёт прежний вид только ей.',
    ]);
    expect(whole.notes).toEqual([
      'Абзацев: 1, текст не меняется. Откат вернёт прежние стили и вид.',
    ]);
  });

  it('Z6: "none" снимает выделение — фон без цвета в той же маске; откат возвращает прежний', async () => {
    const was = { background: '#ffff00', bold: true };
    const client = fresh(one({ text: 'Важно: ' }, { text: 'срок', style: was }));
    await style(client, hl('срок', SECOND, 'none'));
    expect(toDocRequest(client.applied[0]![0]!)).toEqual(google(14, 18, { backgroundColor: {} }));
    expect(marked(await paragraphOf(client, 'Важно'))).toEqual([]);
    await undo(client);
    expect((await paragraphOf(client, 'Важно')).runs[1]).toEqual({ text: 'срок', style: was });
  });
});

describe('Z7 — позиция фразы в юнитах Google', () => {
  const image: DocTextRun = { text: OBJECT_MARK, object: 'image' };
  it.each([
    ['картинки: объект — 1 юнит', [{ text: 'Фото ' }, image, { text: ' подпись' }], 'подпись', 14],
    ['эмодзи: суррогатная пара — 2 юнита', [{ text: 'Счёт 😀 победа' }], 'победа', 15],
  ])('Z7: фраза после %s', async (_name, parts, fragment, start) => {
    const client = fresh(one(...parts));
    await style(client, hl(fragment, SECOND));
    const end = start + fragment.length;
    expect(client.applied).toEqual([[restyle(start, end, { background: '#fff2cc' })]]);
    expect(marked(await paragraphOf(client, parts[0]!.text))).toEqual([fragment]);
  });
});

describe('Z8 — откат подсветки', () => {
  it('Z8: прежний фон и вид возвращаются по юнитам, и только в диапазоне фразы', async () => {
    const client = fresh(
      one(
        { text: 'Итог: счёт ' },
        { text: '2:1', style: { background: '#00ff00' } },
        { text: ' в пользу хозяев', style: { italic: true } },
      ),
    );
    const original = await paragraphOf(client, 'Итог:');
    await style(client, hl('счёт 2:1 в', SECOND));
    expect(marked(await paragraphOf(client, 'Итог:'))).toEqual(['счёт ', '2:1', ' в']);
    const undone = await undo(client);
    // Фраза — юниты 13…23 (абзац с 7, «Итог: » — 6): откат шлёт точный вид ровно её прогонов,
    // без абзацных запросов — остальной абзац он не трогает вовсе.
    expect(client.applied[1]).toEqual([
      restyle(13, 18, {}, true),
      restyle(18, 21, { background: '#00ff00' }, true),
      restyle(21, 23, { italic: true }, true),
    ]);
    expect(unitStyles(await paragraphOf(client, 'Итог:'))).toEqual(unitStyles(original));
    expect(undone.docUndone).toBe(
      'Стили возвращены: фраза «счёт 2:1 в» — остальной абзац не трогался, текст не тронут.',
    );
  });

  it('Z8: откат подсветки абзаца целиком снимает фон и называет абзацы', async () => {
    const client = fresh(forecastDoc());
    const original = await paragraphOf(client, 'Ставим');
    await style(client, hl());
    expect(marked(await paragraphOf(client, 'Ставим'))).toEqual([original.text]);
    const undone = await undo(client);
    expect(unitStyles(await paragraphOf(client, 'Ставим'))).toEqual(unitStyles(original));
    expect(undone.docUndone).toBe('Стили возвращены: 1 абзац(ев), текст не тронут.');
  });

  it('Z8: точный вид отката — backgroundColor в маске: фона не было, он сбрасывается', () => {
    const mask =
      'bold,italic,underline,strikethrough,link,fontSize,foregroundColor,backgroundColor';
    expect(toDocRequest(restyle(3, 5, {}, true))).toEqual(google(3, 5, {}, mask));
    // Цвет текста идёт тем же переводом долей, что фон: #00ff80 — каналы по своим местам.
    const none = toDocRequest(restyle(3, 5, { background: 'none', color: '#00ff80' }, true));
    const green = { color: { rgbColor: { red: 0, green: 1, blue: 128 / 255 } } };
    expect(none).toEqual(google(3, 5, { backgroundColor: {}, foregroundColor: green }, mask));
  });
});

describe('Z9 — отказы: ни одной записи', () => {
  it.each([
    ['Palmeiras', 'fragment_not_found', 'нет фразы «Palmeiras»'],
    ['о', 'fragment_ambiguous', 'встречается не один раз'],
  ])('Z9: фраза «%s» → %s', async (fragment, cause, detail) => {
    const client = fresh(forecastDoc());
    await expect(style(client, hl(fragment))).rejects.toMatchObject({
      payload: { code: 'bad_request', cause, detail: expect.stringContaining(detail) as string },
    });
    expect(client.applied).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });

  it('Z9: фраза с count больше 1 и у вида абзаца — отказ до поиска фразы и записи', async () => {
    const client = fresh(forecastDoc());
    const counted = style(client, { ...hl('Fluminense'), count: 3 });
    await expect(counted).rejects.toMatchObject({
      payload: {
        cause: 'fragment_scope',
        detail:
          'fragment — фраза внутри ОДНОГО абзаца и только у updateTextStyle (сейчас ' +
          'updateTextStyle, count 3). Убери count или поставь 1; несколько фраз — отдельными правками.',
      },
    });
    const asView = { ...hl('Ставим'), op: 'setParagraphStyle', namedStyle: 'TITLE' } as const;
    await expect(style(client, asView)).rejects.toMatchObject({
      payload: { cause: 'fragment_scope' },
    });
    expect(client.applied).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });

  it('Z9: абзац с предложениями отказывает раньше поиска фразы', async () => {
    const suggested = { runs: [{ text: 'Счёт: 2:13:1.' }], suggested: true };
    const client = fresh(buildDoc({ tabs: [{ title: 'Прогноз', content: [suggested] }] }));
    await expect(style(client, hl('нет такой', { firstParagraph: true }))).rejects.toMatchObject({
      payload: { cause: 'docs.suggestions-not-edited' },
    });
    expect(client.applied).toHaveLength(0);
  });

  it('Z9: граница — фон #RRGGBB или "none", фраза непустая', () => {
    const { background } = updateTextStyleOp.shape.style.shape;
    for (const value of ['#09afAF', 'none']) expect(background.safeParse(value).success).toBe(true);
    const wrong = 'yellow,#09afA,#09afAF0,x#09afAF,#09afAG,#0g0000,none!, none,#00000:'.split(',');
    for (const value of wrong) {
      const issue = background.safeParse(value).error?.issues[0]?.message;
      expect(issue, value).toBe('фон задаётся как #RRGGBB или "none" (без выделения)');
    }
    expect(updateTextStyleOp.shape.fragment.safeParse('').success).toBe(false);
  });
});

describe('шов Google: фон в живой форме ответа', () => {
  it('Z6: backgroundColor прогона — цвет; без цвета — none (прозрачный); без долей — чёрный', () => {
    const run = (startIndex: number, content: string, textStyle: object) => ({
      startIndex,
      endIndex: startIndex + content.length,
      textRun: { content, textStyle },
    });
    const elements = [
      run(1, 'Счёт ', {}),
      run(6, '2:1', {
        backgroundColor: { color: { rgbColor: { red: 1, green: 0.9490196, blue: 0.8 } } },
      }),
      run(9, ' и', { backgroundColor: {} }),
      run(11, ' ещё', { backgroundColor: { color: { rgbColor: {} } } }),
      run(15, ' хвост\n', { bold: true }),
    ];
    const body = { content: [{ startIndex: 1, endIndex: 22, paragraph: { elements } }] };
    const tabs = [{ tabProperties: { tabId: 't.0', title: 'Таб' }, documentTab: { body } }];
    const paragraph = toDocSnapshot('DOC0000000000000000001', { tabs }).tabs[0]!.paragraphs[0]!;
    expect(paragraph.runs.map((r) => r.style ?? null)).toEqual([
      null,
      { background: '#fff2cc' },
      { background: 'none' },
      { background: '#000000' },
      { bold: true },
    ]);
  });
});
