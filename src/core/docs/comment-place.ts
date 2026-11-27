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
  let text = '';
  const pieces: Piece[] = [];
  for (const paragraph of tab.paragraphs) {
    const own = squeeze(visibleText(paragraph.text));
    if (own === '') continue;
    if (text !== '') text += ' ';
    pieces.push({ start: text.length, end: text.length + own.length, paragraph: paragraph.index });
    text += own;
  }
  return { title: tab.title, text, pieces };
}

const pieceAt = (pieces: readonly Piece[], offset: number): Piece | undefined =>
  pieces.find((piece) => offset < piece.end) ?? pieces.at(-1);

function matchesIn(tab: TabText, quote: string): PlaceMatch[] {
  const found: PlaceMatch[] = [];
  for (let at = tab.text.indexOf(quote); at !== -1; at = tab.text.indexOf(quote, at + 1)) {
    const first = pieceAt(tab.pieces, at);
    const last = pieceAt(tab.pieces, at + quote.length - 1);
    if (first === undefined || last === undefined) continue;
    found.push({
      tab: tab.title,
      paragraph: first.paragraph,
      ...(last.paragraph === first.paragraph ? {} : { toParagraph: last.paragraph }),
    });
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
