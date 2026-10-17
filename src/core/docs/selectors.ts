/**
 * Селекторы документа: агент говорит ЧТО правит, ядро вычисляет ГДЕ (DESIGN.md §4).
 *
 * Два правила, ради которых модуль существует:
 * - неоднозначный селектор (совпало >1) — ВОПРОС с кандидатами, а не «возьму первое»:
 *   тихая правка не того места — порча документа (P10);
 * - пустое совпадение — ошибка с ближайшими кандидатами, чтобы человек выбирал из
 *   того, что есть (§8.2), а не гадал заново.
 *
 * Границы раздела ищутся по СЛЕДУЮЩЕМУ ЗАГОЛОВКУ, а не по счётчику непустых абзацев:
 * счётчик теряет блок после пропуска — урок L16.
 */

import { gcError } from '../errors.js';
import { normalizeName } from '../resolver.js';
import { shownText, visibleText } from './objects.js';
import type { Question } from '../sheets/write-types.js';
import type { DocParagraph, DocSnapshot, DocTab, DocTable } from './types.js';

export type ParagraphSelector =
  | { readonly paragraphIndex: number }
  | { readonly textStartsWith: string }
  | { readonly textContains: string }
  | { readonly firstParagraph: true }
  | { readonly lastParagraph: true };

export type TableSelector = { readonly table: number } | { readonly tableWithCell: string };

export type Resolved<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'question'; readonly question: Question };

const ok = <T>(value: T): Resolved<T> => ({ status: 'ok', value });
const ask = <T>(question: Question): Resolved<T> => ({ status: 'question', question });

/** «№ 7: первые слова…» — кандидат, по которому человек узнаёт абзац, не читая весь. */
export const paragraphLabel = (p: DocParagraph, words = 6): string => {
  const parts = shownText(p.runs)
    .split(/\s+/)
    .filter((w) => w !== '');
  const head = parts.slice(0, words).join(' ');
  return `№ ${p.index}: ${parts.length > words ? `${head}…` : head}`;
};

const bodyParagraphs = (tab: DocTab): readonly DocParagraph[] =>
  tab.paragraphs.filter((p) => p.inTable === undefined);

/** Ближайшие кандидаты при пустом совпадении: абзацы с первым токеном запроса. */
function nearMisses(tab: DocTab, wanted: string): readonly string[] {
  const token = normalizeName(wanted).split(' ')[0] ?? '';
  const near =
    token === ''
      ? []
      : tab.paragraphs.filter((p) => normalizeName(p.text).includes(token)).slice(0, 5);
  const pool = near.length > 0 ? near : bodyParagraphs(tab).slice(0, 5);
  return pool.map((p) => paragraphLabel(p));
}

function byText(
  tab: DocTab,
  wanted: string,
  match: (text: string, query: string) => boolean,
  field: string,
): Resolved<DocParagraph> {
  const query = normalizeName(wanted);
  // Объект посередине не мешает: сравниваем и без знаков объектов, и с их метками.
  const hits = tab.paragraphs.filter((p) =>
    [visibleText(p.text), shownText(p.runs)].some((t) => match(normalizeName(t), query)),
  );
  if (hits.length === 1) return ok(hits[0]!);
  if (hits.length === 0) {
    return ask({
      field,
      reason: 'no_match',
      detail: `Абзац «${wanted}» в табе «${tab.title}» не найден.`,
      candidates: nearMisses(tab, wanted),
      available: [],
    });
  }
  return ask({
    field,
    reason: 'ambiguous',
    detail: `Селектор «${wanted}» совпал с ${hits.length} абзацами в табе «${tab.title}» — уточни.`,
    candidates: hits.slice(0, 10).map((p) => paragraphLabel(p)),
    available: [],
  });
}

export function resolveParagraph(tab: DocTab, selector: ParagraphSelector): Resolved<DocParagraph> {
  if ('paragraphIndex' in selector) {
    const hit = tab.paragraphs.find((p) => p.index === selector.paragraphIndex);
    if (hit !== undefined) return ok(hit);
    return ask({
      field: 'paragraphIndex',
      reason: 'no_match',
      detail: `Абзаца № ${selector.paragraphIndex} нет: в табе «${tab.title}» их ${tab.paragraphs.length}. Номера — из gc_read mode=map.`,
      candidates: [],
      available: [],
    });
  }
  if ('textStartsWith' in selector) {
    return byText(tab, selector.textStartsWith, (t, q) => t.startsWith(q), 'textStartsWith');
  }
  if ('textContains' in selector) {
    return byText(tab, selector.textContains, (t, q) => t.includes(q), 'textContains');
  }
  const body = bodyParagraphs(tab);
  const hit = 'firstParagraph' in selector ? body[0] : body[body.length - 1];
  if (hit !== undefined) return ok(hit);
  return ask({
    field: 'firstParagraph' in selector ? 'firstParagraph' : 'lastParagraph',
    reason: 'no_match',
    detail: `В табе «${tab.title}» нет ни одного абзаца.`,
    candidates: [],
    available: [],
  });
}

const HEADING_STYLES = new Set([
  'TITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

const headingRank = (style: string): number =>
  style === 'TITLE' ? 0 : Number(style.replace('HEADING_', ''));

export interface DocSection {
  readonly heading: DocParagraph;
  /** Абзацы раздела после заголовка, включая содержимое его таблиц. */
  readonly paragraphs: readonly DocParagraph[];
  /** Конец раздела в юнитах — сюда вставляется «в конец раздела». */
  readonly endIndex: number;
}

/**
 * Раздел заголовка: от него до следующего заголовка ТОГО ЖЕ ИЛИ СТАРШЕГО уровня
 * (или до конца таба). Таблицы внутри границ принадлежат разделу.
 */
export function resolveSection(tab: DocTab, headingText: string): Resolved<DocSection> {
  const query = normalizeName(headingText);
  const headings = tab.paragraphs.filter(
    (p) => p.inTable === undefined && HEADING_STYLES.has(p.namedStyle),
  );
  const hits = headings.filter((p) => normalizeName(p.text).startsWith(query));
  if (hits.length === 0) {
    return ask({
      field: 'afterHeading',
      reason: 'no_match',
      detail: `Заголовка «${headingText}» в табе «${tab.title}» нет.`,
      candidates: headings.slice(0, 10).map((p) => paragraphLabel(p)),
      available: headings.map((p) => p.text),
    });
  }
  if (hits.length > 1) {
    return ask({
      field: 'afterHeading',
      reason: 'ambiguous',
      detail: `Заголовок «${headingText}» совпал с ${hits.length} местами — уточни.`,
      candidates: hits.map((p) => paragraphLabel(p)),
      available: headings.map((p) => p.text),
    });
  }
  const heading = hits[0]!;
  const rank = headingRank(heading.namedStyle);
  // Граница — следующий заголовок того же/старшего уровня, не счётчик (урок L16).
  const next = tab.paragraphs.find(
    (p) =>
      p.inTable === undefined &&
      p.index > heading.index &&
      HEADING_STYLES.has(p.namedStyle) &&
      headingRank(p.namedStyle) <= rank,
  );
  const section = tab.paragraphs.filter(
    (p) => p.index > heading.index && (next === undefined || p.index < next.index),
  );
  const last = section[section.length - 1];
  return ok({
    heading,
    paragraphs: section,
    endIndex: last === undefined ? heading.endIndex : Math.max(last.endIndex, heading.endIndex),
  });
}

export function resolveTable(tab: DocTab, selector: TableSelector): Resolved<DocTable> {
  if ('table' in selector) {
    const hit = tab.tables.find((t) => t.index === selector.table);
    if (hit !== undefined) return ok(hit);
    return ask({
      field: 'table',
      reason: 'no_match',
      detail: `Таблицы № ${selector.table} нет: в табе «${tab.title}» их ${tab.tables.length}.`,
      candidates: tab.tables.map((t) => `№ ${t.index}: ${t.cells[0]?.join(' | ') ?? ''}`),
      available: [],
    });
  }
  const query = normalizeName(selector.tableWithCell);
  const hits = tab.tables.filter((t) =>
    t.cells.some((row) => row.some((cell) => normalizeName(cell).includes(query))),
  );
  if (hits.length === 1) return ok(hits[0]!);
  const label = (t: DocTable): string => `№ ${t.index}: ${t.cells[0]?.join(' | ') ?? ''}`;
  if (hits.length === 0) {
    return ask({
      field: 'tableWithCell',
      reason: 'no_match',
      detail: `Ячейки с «${selector.tableWithCell}» нет ни в одной таблице таба «${tab.title}».`,
      candidates: tab.tables.map(label),
      available: [],
    });
  }
  return ask({
    field: 'tableWithCell',
    reason: 'ambiguous',
    detail: `«${selector.tableWithCell}» найдено в ${hits.length} таблицах — уточни номером.`,
    candidates: hits.map(label),
    available: [],
  });
}

/**
 * Таб по заголовку. Документ с одним табом отдаёт его без вопросов; с несколькими —
 * требует имя: «возьму первый» прочитал бы человеку не тот текст (та же неоднозначность,
 * что у селекторов §4 — вопрос, а не догадка).
 */
export function pickTab(snapshot: DocSnapshot, wanted: string | undefined): DocTab {
  const titles = snapshot.tabs.map((t) => t.title).join(', ');
  if (wanted !== undefined) {
    const matches = snapshot.tabs.filter((t) => t.title === wanted);
    if (matches.length === 1) return matches[0]!;
    throw gcError(matches.length === 0 ? 'bad_request' : 'ambiguous_target', {
      detail:
        matches.length === 0
          ? `Таба «${wanted}» в документе нет. Есть: ${titles}.`
          : `Заголовок «${wanted}» носят несколько табов (${matches.length}); адресуй по mode=map.`,
    });
  }
  const first = snapshot.tabs[0];
  if (snapshot.tabs.length === 1 && first !== undefined) return first;
  throw gcError('bad_request', {
    detail: `В документе ${snapshot.tabs.length} табов — назови tab. Есть: ${titles}.`,
  });
}

/** Строка таблицы: по содержимому ячейки или 1-based номеру. Возврат — 0-based. */
export function resolveTableRow(
  table: DocTable,
  selector: { readonly rowWithCell?: string | undefined; readonly rowIndex?: number | undefined },
): Resolved<number> {
  if (selector.rowIndex !== undefined) {
    if (selector.rowIndex >= 1 && selector.rowIndex <= table.rows) return ok(selector.rowIndex - 1);
    return ask({
      field: 'rowIndex',
      reason: 'no_match',
      detail: `Строки № ${selector.rowIndex} нет: в таблице их ${table.rows}.`,
      candidates: [],
      available: [],
    });
  }
  const wanted = normalizeName(selector.rowWithCell ?? '');
  if (wanted === '') {
    return ask({
      field: 'row',
      reason: 'no_match',
      detail: 'Скажи, какая строка: содержимым ячейки (rowWithCell) или номером (rowIndex).',
      candidates: [],
      available: [],
    });
  }
  const label = (r: number): string => `№ ${r + 1}: ${table.cells[r]!.join(' | ')}`;
  const hits = table.cells
    .map((row, r) => ({ row, r }))
    .filter(({ row }) => row.some((cell) => normalizeName(cell).includes(wanted)));
  if (hits.length === 1) return ok(hits[0]!.r);
  return ask({
    field: 'rowWithCell',
    reason: hits.length === 0 ? 'no_match' : 'ambiguous',
    detail:
      hits.length === 0
        ? `Строки с «${selector.rowWithCell}» в таблице нет.`
        : `«${selector.rowWithCell}» найдено в ${hits.length} строках — уточни.`,
    candidates: (hits.length === 0 ? table.cells.map((_, r) => ({ r })) : hits)
      .slice(0, 10)
      .map(({ r }) => label(r)),
    available: [],
  });
}

/** Колонка таблицы: по заголовку из первой строки или 1-based номеру. Возврат — 0-based. */
export function resolveTableColumn(
  table: DocTable,
  selector: {
    readonly columnTitle?: string | undefined;
    readonly columnIndex?: number | undefined;
  },
): Resolved<number> {
  if (selector.columnIndex !== undefined) {
    if (selector.columnIndex >= 1 && selector.columnIndex <= table.columns) {
      return ok(selector.columnIndex - 1);
    }
    return ask({
      field: 'columnIndex',
      reason: 'no_match',
      detail: `Колонки № ${selector.columnIndex} нет: в таблице их ${table.columns}.`,
      candidates: [],
      available: [],
    });
  }
  const header = table.cells[0] ?? [];
  const wanted = normalizeName(selector.columnTitle ?? '');
  if (wanted === '') {
    return ask({
      field: 'column',
      reason: 'no_match',
      detail: 'Скажи, какая колонка: заголовком из первой строки (columnTitle) или номером.',
      candidates: [],
      available: header.map((h) => h),
    });
  }
  const hits = header
    .map((cell, c) => ({ cell, c }))
    .filter(({ cell }) => normalizeName(cell) === wanted);
  if (hits.length === 1) return ok(hits[0]!.c);
  return ask({
    field: 'columnTitle',
    reason: hits.length === 0 ? 'no_match' : 'ambiguous',
    detail:
      hits.length === 0
        ? `Колонки «${selector.columnTitle}» в шапке таблицы нет.`
        : `Заголовок «${selector.columnTitle}» у ${hits.length} колонок — уточни номером.`,
    candidates: header.map((h, c) => `№ ${c + 1}: ${h}`),
    available: header.map((h) => h),
  });
}
