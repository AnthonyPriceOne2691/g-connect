/**
 * Карта документа — дешёвый ответ `gc_read mode=map` для doc-целей (спека P21).
 *
 * Та же философия, что у карты листа: не «прочитай тысячи строк, чтобы понять документ»,
 * а оглавление, таблицы, счётчики и ПРЕДУПРЕЖДЕНИЯ. № абзаца из карты — валюта
 * селекторов: «paragraphIndex: 7» адресует то, что человек видит здесь.
 */

import { shownText } from './objects.js';
import type { DocSnapshot, DocTab } from './types.js';

export interface DocHeadingEntry {
  /** Уровень: 1–6; 0 — TITLE/SUBTITLE. */
  readonly level: number;
  readonly text: string;
  readonly paragraph: number;
}

export interface DocTableEntry {
  readonly n: number;
  readonly rows: number;
  readonly columns: number;
  /** Первая строка таблицы — обычно шапка; по ней таблицу называют. */
  readonly firstRow: readonly string[];
}

export interface DocTabMap {
  readonly title: string;
  readonly tabId: string;
  readonly paragraphs: number;
  /** Юниты UTF-16 тела таба — бюджет снимка сверяется в тех же единицах. */
  readonly chars: number;
  readonly headings: readonly DocHeadingEntry[];
  readonly tables: readonly DocTableEntry[];
  /** Первые слова первых абзацев — чтобы узнать таб, не читая его. */
  readonly preview: readonly string[];
}

export interface DocMap {
  readonly doc: string;
  readonly revisionId: string;
  readonly tabs: readonly DocTabMap[];
  readonly warnings: readonly string[];
}

const HEADING_LEVEL: Readonly<Record<string, number>> = {
  TITLE: 0,
  SUBTITLE: 0,
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

const firstWords = (text: string, limit = 8): string => {
  const words = text.split(/\s+/).filter((w) => w !== '');
  return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}…`;
};

function tabMap(tab: DocTab): DocTabMap {
  const bodyParagraphs = tab.paragraphs.filter((p) => p.inTable === undefined);
  const headings: DocHeadingEntry[] = [];
  for (const paragraph of bodyParagraphs) {
    const level = HEADING_LEVEL[paragraph.namedStyle];
    if (level !== undefined && paragraph.text.trim() !== '') {
      headings.push({ level, text: shownText(paragraph.runs), paragraph: paragraph.index });
    }
  }
  return {
    title: tab.title,
    tabId: tab.tabId,
    paragraphs: tab.paragraphs.length,
    chars: tab.endIndex,
    headings,
    tables: tab.tables.map((t) => ({
      n: t.index,
      rows: t.rows,
      columns: t.columns,
      firstRow: t.cells[0] ?? [],
    })),
    preview: bodyParagraphs.slice(0, 3).map((p) => firstWords(shownText(p.runs))),
  };
}

export function buildDocMap(snapshot: DocSnapshot): DocMap {
  const warnings: string[] = [];
  if (snapshot.hasSuggestions) {
    warnings.push(
      'В документе есть неразрешённые предложения (suggestions): карта и правки видят ' +
        'текущий текст без них; принять или отклонить предложения можно только в интерфейсе.',
    );
  }
  const hidden: string[] = [];
  if (snapshot.headerCount > 0) hidden.push(`колонтитулы верхние: ${snapshot.headerCount}`);
  if (snapshot.footerCount > 0) hidden.push(`нижние: ${snapshot.footerCount}`);
  if (snapshot.footnoteCount > 0) hidden.push(`сноски: ${snapshot.footnoteCount}`);
  if (hidden.length > 0) {
    warnings.push(
      `Сегменты вне тела документа карта не показывает и ядро их не правит (${hidden.join(', ')}).`,
    );
  }
  const withObjects = snapshot.tabs
    .flatMap((tab) => tab.paragraphs)
    .filter((p) => p.hasInlineObject);
  if (withObjects.length > 0) {
    warnings.push(
      `Встроенных объектов (картинки, @-чипы, даты, разрывы) — в ${withObjects.length} абзац(ах): ` +
        'в тексте они показаны метками вроде «[картинка]». Удаление и замена, задевающие объект, ' +
        'отказывают: откат вернул бы текст без объекта.',
    );
  }
  if (snapshot.tabs.every((tab) => tab.paragraphs.length === 0)) {
    warnings.push('Документ пуст: ни одного абзаца с текстом.');
  }
  return {
    doc: snapshot.title,
    revisionId: snapshot.revisionId,
    tabs: snapshot.tabs.map(tabMap),
    warnings,
  };
}
