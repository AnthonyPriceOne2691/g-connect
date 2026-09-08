/**
 * Шов Docs: перевод ответа `documents.get` в доменный снимок (уровень 3, слайс 1).
 *
 * Форма ответа собрана РУКАМИ ПО ДОКУМЕНТАЦИИ Docs API (урок L3): индексы — UTF-16
 * code units, тело таба начинается с 1, текст приходит прогонами, последний кончается
 * `\n`, содержимое — в `tabs[]` при `includeTabsContent`. Промах здесь — это правка
 * не того диапазона на живом документе, и тесты на снимок его не увидят.
 */

import { describe, expect, it } from 'vitest';

import { toDocSnapshot } from '../src/core/google/docs.js';
import type { docs_v1 } from 'googleapis';

/** Абзац из одного прогона, как его отдаёт Google: текст с завершающим `\n`. */
const gParagraph = (
  start: number,
  text: string,
  extra: Partial<docs_v1.Schema$Paragraph> = {},
  runExtra: Partial<docs_v1.Schema$TextRun> = {},
): docs_v1.Schema$StructuralElement => ({
  startIndex: start,
  endIndex: start + text.length + 1,
  paragraph: {
    elements: [
      {
        startIndex: start,
        endIndex: start + text.length + 1,
        textRun: { content: `${text}\n`, ...runExtra },
      },
    ],
    paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
    ...extra,
  },
});

const asDocument = (tabs: docs_v1.Schema$Tab[]): docs_v1.Schema$Document => ({
  title: 'Прогноз на матч',
  revisionId: 'rev-7',
  tabs,
});

describe('P21-основа — перевод ответа Google в доменный снимок', () => {
  it('границы абзацев — UTF-16: эмодзи считается за два юнита', () => {
    // «Гол! 😀» — 5 юнитов текста + 2 юнита суррогатной пары = 7, плюс \n.
    const doc = asDocument([
      {
        tabProperties: { tabId: 't1', title: 'Прогноз' },
        documentTab: { body: { content: [gParagraph(1, 'Гол! 😀')] } },
      },
    ]);
    const snapshot = toDocSnapshot('d1', doc);
    const paragraph = snapshot.tabs[0]!.paragraphs[0]!;
    expect(paragraph.text).toBe('Гол! 😀');
    expect(paragraph.text.length).toBe(7);
    expect(paragraph.startIndex).toBe(1);
    expect(paragraph.endIndex).toBe(9); // 1 + 7 + завершающий \n
  });

  it('прогоны сохраняют стиль, завершающий \\n абзаца в домен не попадает', () => {
    const doc = asDocument([
      {
        tabProperties: { tabId: 't1', title: 'Прогноз' },
        documentTab: {
          body: {
            content: [
              {
                startIndex: 1,
                endIndex: 20,
                paragraph: {
                  elements: [
                    { textRun: { content: 'Изучаем ' } },
                    { textRun: { content: 'форму', textStyle: { bold: true } } },
                    { textRun: { content: ' команд\n' } },
                  ],
                  paragraphStyle: { namedStyleType: 'HEADING_2' },
                },
              },
            ],
          },
        },
      },
    ]);
    const paragraph = toDocSnapshot('d1', doc).tabs[0]!.paragraphs[0]!;
    expect(paragraph.text).toBe('Изучаем форму команд');
    expect(paragraph.runs).toEqual([
      { text: 'Изучаем ' },
      { text: 'форму', style: { bold: true } },
      { text: ' команд' },
    ]);
    expect(paragraph.namedStyle).toBe('HEADING_2');
  });

  it('таблица: размер, тексты ячеек, абзацы ячеек помечены inTable', () => {
    const doc = asDocument([
      {
        tabProperties: { tabId: 't1', title: 'Прогноз' },
        documentTab: {
          body: {
            content: [
              gParagraph(1, 'Составы'),
              {
                startIndex: 9,
                endIndex: 30,
                table: {
                  rows: 1,
                  columns: 2,
                  tableRows: [
                    {
                      tableCells: [
                        { content: [gParagraph(11, 'Игрок')] },
                        { content: [gParagraph(18, 'Статус')] },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ]);
    const tab = toDocSnapshot('d1', doc).tabs[0]!;
    expect(tab.tables).toHaveLength(1);
    expect(tab.tables[0]).toMatchObject({ rows: 1, columns: 2, startIndex: 9, endIndex: 30 });
    expect(tab.tables[0]!.cells).toEqual([['Игрок', 'Статус']]);
    const inTable = tab.paragraphs.filter((p) => p.inTable !== undefined);
    expect(inTable).toHaveLength(2);
    expect(inTable[1]!.inTable).toEqual({ table: 1, row: 1, column: 2 });
  });

  it('неразрешённые предложения любого вида поднимают hasSuggestions', () => {
    const doc = asDocument([
      {
        tabProperties: { tabId: 't1', title: 'Прогноз' },
        documentTab: {
          body: {
            content: [gParagraph(1, 'Текст', {}, { suggestedInsertionIds: ['s1'] })],
          },
        },
      },
    ]);
    expect(toDocSnapshot('d1', doc).hasSuggestions).toBe(true);
    const clean = asDocument([
      {
        tabProperties: { tabId: 't1', title: 'Прогноз' },
        documentTab: { body: { content: [gParagraph(1, 'Текст')] } },
      },
    ]);
    expect(toDocSnapshot('d1', clean).hasSuggestions).toBe(false);
  });

  it('вложенные табы разворачиваются в плоский список после родителя', () => {
    const doc = asDocument([
      {
        tabProperties: { tabId: 'root', title: 'Прогноз' },
        documentTab: { body: { content: [gParagraph(1, 'Тело')] } },
        childTabs: [
          {
            tabProperties: { tabId: 'child', title: 'Черновики' },
            documentTab: { body: { content: [gParagraph(1, 'Черновик')] } },
          },
        ],
      },
    ]);
    const snapshot = toDocSnapshot('d1', doc);
    expect(snapshot.tabs.map((t) => t.title)).toEqual(['Прогноз', 'Черновики']);
  });

  it('сегменты, которые ядро не правит, считаются: headers и footnotes табов', () => {
    const doc: docs_v1.Schema$Document = {
      title: 'Док',
      revisionId: 'rev-1',
      tabs: [
        {
          tabProperties: { tabId: 't1', title: 'Один' },
          documentTab: {
            body: { content: [gParagraph(1, 'Текст')] },
            headers: { h1: {} },
            footnotes: { f1: {}, f2: {} },
          },
        },
      ],
    };
    const snapshot = toDocSnapshot('d1', doc);
    expect(snapshot.headerCount).toBe(1);
    expect(snapshot.footnoteCount).toBe(2);
  });

  it('неизвестный namedStyleType и незаполненные поля не роняют перевод', () => {
    const doc = asDocument([
      {
        tabProperties: { tabId: 't1', title: 'Прогноз' },
        documentTab: {
          body: {
            content: [
              gParagraph(1, 'Текст', { paragraphStyle: { namedStyleType: 'WEIRD_FUTURE' } }),
              { startIndex: 8, endIndex: 9, sectionBreak: {} },
            ],
          },
        },
      },
    ]);
    const tab = toDocSnapshot('d1', doc).tabs[0]!;
    expect(tab.paragraphs[0]!.namedStyle).toBe('NORMAL_TEXT');
    expect(tab.paragraphs).toHaveLength(1);
    expect(tab.endIndex).toBe(9); // sectionBreak не абзац, но границу тела двигает
  });
});
