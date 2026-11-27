/**
 * Фраза внутри абзаца (`fragment.ts`, 27.11) — позиция для подсветки и своего комментария.
 * Индексы — UTF-16 юниты Google: объект — один юнит, эмодзи — два.
 */

import { describe, expect, it } from 'vitest';

import { fragmentRange } from '../src/core/docs/fragment.js';
import { OBJECT_MARK, type DocParagraph } from '../src/core/docs/types.js';
import { buildDoc, p, runs } from './fixtures/doc.js';

const paragraphs = (): readonly DocParagraph[] =>
  buildDoc({
    tabs: [
      {
        title: 'Т',
        content: [
          p('Основа выйдет без ротации, Fluminense FC подтвердил заявку.'),
          runs(
            { text: 'Фото ' },
            { text: OBJECT_MARK, object: 'image' },
            { text: ' 😀 подпись к фото' },
          ),
          p('ааа'),
        ],
      },
    ],
  }).tabs[0]?.paragraphs ?? [];

const nth = (n: number): DocParagraph => {
  const found = paragraphs()[n - 1];
  if (found === undefined) throw new Error(`нет абзаца ${n}`);
  return found;
};

describe('фраза внутри абзаца — позиция в документе', () => {
  it('позиция фразы — от начала абзаца, в юнитах Google', () => {
    const paragraph = nth(1);
    const at = paragraph.text.indexOf('Fluminense FC');
    expect(fragmentRange(paragraph, 'Fluminense FC')).toEqual({
      startIndex: paragraph.startIndex + at,
      endIndex: paragraph.startIndex + at + 'Fluminense FC'.length,
    });
  });

  it('после картинки (1 юнит) и эмодзи (2 юнита) позиция не съезжает', () => {
    const paragraph = nth(2);
    // «Фото » (5) + объект (1) + « » (1) + эмодзи (2) + « » (1) = 10 юнитов до «подпись».
    expect(fragmentRange(paragraph, 'подпись')).toEqual({
      startIndex: paragraph.startIndex + 10,
      endIndex: paragraph.startIndex + 17,
    });
  });

  it('фраза с первого знака абзаца', () => {
    const paragraph = nth(1);
    expect(fragmentRange(paragraph, 'Основа')).toEqual({
      startIndex: paragraph.startIndex,
      endIndex: paragraph.startIndex + 6,
    });
  });

  it('нет фразы или она пустая — fragment_not_found с № абзаца', () => {
    for (const fragment of ['Palmeiras', '']) {
      expect(() => fragmentRange(nth(1), fragment)).toThrow(
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'bad_request', cause: 'fragment_not_found' }),
        }),
      );
    }
    expect(() => fragmentRange(nth(1), 'Palmeiras')).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          detail:
            'В абзаце 1 нет фразы «Palmeiras». Фраза берётся из текста абзаца как есть — сверь с gc_read mode=text.',
        }),
      }),
    );
  });

  it('фраза не одна — fragment_ambiguous, в том числе внахлёст', () => {
    expect(() => fragmentRange(nth(3), 'аа')).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({ code: 'bad_request', cause: 'fragment_ambiguous' }),
      }),
    );
    expect(() => fragmentRange(nth(2), 'фото')).not.toThrow();
    expect(() => fragmentRange(nth(1), 'о')).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          detail:
            'Фраза «о» в абзаце 1 встречается не один раз — возьми фразу длиннее, чтобы она была в абзаце одна.',
        }),
      }),
    );
  });
});
