/**
 * Где в документе комментарий (27.11): № абзаца по процитированному тексту — в той же
 * нумерации, что у `gc_read mode=map/text` и селекторов правки (`paragraphIndex`).
 *
 * Позицию комментария Drive не отдаёт: якорь у документа Google — внутренние данные редактора.
 * Остаётся цитата — текст на момент комментария. Поэтому место — вывод, и вывод честный
 * (правило `read.comment-place-exact`): абзац — только при ОДНОМ вхождении цитаты; два и больше —
 * `ambiguous` со списком, ни одного — `notFound` (текст правили после комментария), цитаты нет —
 * `unanchored` (комментарий ко всему документу). Пробелы любого вида и переводы строк сравниваются
 * как один пробел: цитата через два абзаца приходит с `\n`, а неразрывный пробел выглядит обычным.
 */

import { visibleText } from './objects.js';
import type { DocTab } from './types.js';

export interface PlaceMatch {
  readonly tab: string;
  readonly paragraph: number;
  /** Цитата длиннее абзаца: по какой абзац она идёт. */
  readonly toParagraph?: number;
}

export type CommentPlace =
  | ({ readonly status: 'found' } & PlaceMatch)
  | {
      readonly status: 'ambiguous';
      readonly count: number;
      readonly matches: readonly PlaceMatch[];
    }
  | { readonly status: 'notFound' }
  | { readonly status: 'unanchored' };

/** Сколько вхождений неоднозначной цитаты назвать: дальше — только их число. */
const SHOWN_MATCHES = 5;

interface Piece {
  /** Начало и конец (не включая) текста абзаца в строке таба. */
  readonly start: number;
  readonly end: number;
  readonly paragraph: number;
}

interface TabText {
  readonly title: string;
  readonly text: string;
  readonly pieces: readonly Piece[];
}

const squeeze = (text: string): string => text.replace(/[\s\u200b]+/g, ' ').trim();

/**
 * Текст таба одной строкой: абзацы без пустых через пробел, у каждого — его отрезок. Пустой абзац
 * цитату не несёт, а с ним цитата «a\n\nb» не сошлась бы с «a b».
 */
function tabText(tab: DocTab): TabText {
  const owned = tab.paragraphs
    .map((paragraph) => ({
      paragraph: paragraph.index,
      text: squeeze(visibleText(paragraph.text)),
    }))
    .filter((entry) => entry.text !== '');
  let start = 0;
  const pieces = owned.map((entry) => {
    const piece = { start, end: start + entry.text.length, paragraph: entry.paragraph };
    start = piece.end + 1;
    return piece;
  });
  return { title: tab.title, text: owned.map((entry) => entry.text).join(' '), pieces };
}

/**
 * Абзацы вхождения `[at, end)`: первый — последний, начавшийся не позже `at`; последний — первый,
 * кончившийся не раньше `end`. Цитата сжата и обрезана, поэтому ни начало, ни конец не падают на
 * пробел-стык между абзацами.
 */
function span(pieces: readonly Piece[], at: number, end: number) {
  let paragraph = 0;
  let toParagraph = 0;
  for (const piece of pieces) {
    if (piece.start <= at) paragraph = piece.paragraph;
    if (toParagraph === 0 && end <= piece.end) toParagraph = piece.paragraph;
  }
  return toParagraph === paragraph ? { paragraph } : { paragraph, toParagraph };
}

function matchesIn(tab: TabText, quote: string): PlaceMatch[] {
  const found: PlaceMatch[] = [];
  for (let at = tab.text.indexOf(quote); at !== -1; at = tab.text.indexOf(quote, at + 1)) {
    found.push({ tab: tab.title, ...span(tab.pieces, at, at + quote.length) });
  }
  return found;
}

/** Поисковик мест по табам документа: тексты табов собираются один раз на все комментарии. */
export function placeFinder(tabs: readonly DocTab[]): (quote: string | undefined) => CommentPlace {
  const texts = tabs.map(tabText);
  return (quote) => {
    const wanted = squeeze(quote ?? '');
    if (wanted === '') return { status: 'unanchored' };
    const matches = texts.flatMap((tab) => matchesIn(tab, wanted));
    const [only] = matches;
    if (only === undefined) return { status: 'notFound' };
    if (matches.length === 1) return { status: 'found', ...only };
    return {
      status: 'ambiguous',
      count: matches.length,
      matches: matches.slice(0, SHOWN_MATCHES),
    };
  };
}
