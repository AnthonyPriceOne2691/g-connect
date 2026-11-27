/**
 * Фраза внутри абзаца (27.11): подсветка и свой комментарий называют не абзац целиком, а кусок
 * его текста. Индексы текста абзаца равны индексам Google — объект стоит в тексте знаком
 * `OBJECT_MARK` по юниту (types.ts), — поэтому смещение фразы в тексте и есть её позиция в
 * документе. Фраза сравнивается как есть: она берётся из `gc_read mode=text`, а догадка «похожая
 * фраза» легла бы не туда.
 */

import { gcError } from '../errors.js';
import type { DocParagraph } from './types.js';

export interface DocRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

/** Позиция фразы в абзаце. Нет её или она не одна — отказ, а не первая попавшаяся. */
export function fragmentRange(paragraph: DocParagraph, fragment: string): DocRange {
  const at = fragment === '' ? -1 : paragraph.text.indexOf(fragment);
  if (at === -1) {
    throw gcError('bad_request', {
      cause: 'fragment_not_found',
      detail:
        `В абзаце ${paragraph.index} нет фразы «${fragment}». Фраза берётся из текста абзаца ` +
        'как есть — сверь с gc_read mode=text.',
    });
  }
  if (paragraph.text.indexOf(fragment, at + 1) !== -1) {
    throw gcError('bad_request', {
      cause: 'fragment_ambiguous',
      detail:
        `Фраза «${fragment}» в абзаце ${paragraph.index} встречается не один раз — возьми ` +
        'фразу длиннее, чтобы она была в абзаце одна.',
    });
  }
  return {
    startIndex: paragraph.startIndex + at,
    endIndex: paragraph.startIndex + at + fragment.length,
  };
}
