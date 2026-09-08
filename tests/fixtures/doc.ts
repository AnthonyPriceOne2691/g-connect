/**
 * Фикстурный документ из spec.md («Прогноз на матч») и фейковый DocsClient.
 *
 * Индексы фикстура СЧИТАЕТ по правилам документации Docs API, а не расставляет руками:
 * - индексы — UTF-16 code units (`.length` JS-строки; эмодзи = 2 юнита);
 * - тело сегмента начинается с 1 (нулевой юнит занят началом сегмента);
 * - абзац занимает `[start, start + text.length + 1)` — плюс завершающий `\n`;
 * - таблица: 1 юнит на вход в таблицу, затем на каждую строку 1 юнит и на каждую
 *   ячейку 1 юнит + её абзацы; после таблицы Docs держит закрывающий абзац.
 *   ⚠ Арифметика внутренностей таблиц в документации описана скупо; здесь — наше
 *   прочтение, и оно СВЕРЯЕТСЯ живым прогоном в слайсе 6 до первой правки таблиц
 *   (названо в verify-report, а не спрятано).
 */

import type {
  DocParagraph,
  DocSnapshot,
  DocTab,
  DocTable,
  DocTextRun,
  DocsClient,
  ParagraphNamedStyle,
} from '../../src/core/docs/types.js';

/** Описание абзаца в билдере: строка или прогоны со стилем. */
export interface ParagraphSpec {
  readonly runs: readonly DocTextRun[];
  readonly style?: ParagraphNamedStyle;
  readonly bulleted?: boolean;
}

export const p = (text: string, style?: ParagraphNamedStyle): ParagraphSpec =>
  style === undefined ? { runs: [{ text }] } : { runs: [{ text }], style };

export const runs = (...parts: DocTextRun[]): ParagraphSpec => ({ runs: parts });

export interface TableSpec {
  readonly table: readonly (readonly string[])[];
}

export interface TabSpec {
  readonly title: string;
  readonly content: readonly (ParagraphSpec | TableSpec)[];
}

const isTable = (item: ParagraphSpec | TableSpec): item is TableSpec => 'table' in item;

/** Собрать таб: абзацы и таблицы с посчитанными индексами. */
function buildTab(spec: TabSpec, tabNumber: number): DocTab {
  const paragraphs: DocParagraph[] = [];
  const tables: DocTable[] = [];
  let cursor = 1; // тело сегмента начинается с 1

  const pushParagraph = (
    item: ParagraphSpec,
    inTable?: { table: number; row: number; column: number },
  ): void => {
    const text = item.runs.map((r) => r.text).join('');
    paragraphs.push({
      index: paragraphs.length + 1,
      startIndex: cursor,
      endIndex: cursor + text.length + 1,
      text,
      runs: item.runs,
      namedStyle: item.style ?? 'NORMAL_TEXT',
      ...(item.bulleted === true ? { bulleted: true } : {}),
      ...(inTable === undefined ? {} : { inTable }),
    });
    cursor += text.length + 1;
  };

  for (const item of spec.content) {
    if (!isTable(item)) {
      pushParagraph(item);
      continue;
    }
    const start = cursor;
    cursor += 1; // вход в таблицу
    const tableNumber = tables.length + 1;
    const cells: string[][] = [];
    item.table.forEach((rowSpec, r) => {
      cursor += 1; // вход в строку
      const rowCells: string[] = [];
      rowSpec.forEach((cellText, c) => {
        cursor += 1; // вход в ячейку
        pushParagraph(
          { runs: [{ text: cellText }] },
          { table: tableNumber, row: r + 1, column: c + 1 },
        );
        rowCells.push(cellText);
      });
      cells.push(rowCells);
    });
    tables.push({
      index: tableNumber,
      startIndex: start,
      endIndex: cursor,
      rows: item.table.length,
      columns: item.table[0]?.length ?? 0,
      cells,
    });
  }

  return {
    tabId: `t${tabNumber}`,
    title: spec.title,
    paragraphs,
    tables,
    endIndex: cursor,
  };
}

export interface DocSpec {
  readonly title?: string;
  readonly revisionId?: string;
  readonly tabs: readonly TabSpec[];
  readonly hasSuggestions?: boolean;
  readonly headerCount?: number;
  readonly footerCount?: number;
}

export function buildDoc(spec: DocSpec): DocSnapshot {
  return {
    docId: 'doc-fixture',
    title: spec.title ?? 'Документ',
    revisionId: spec.revisionId ?? 'rev-1',
    tabs: spec.tabs.map((tab, i) => buildTab(tab, i + 1)),
    hasSuggestions: spec.hasSuggestions ?? false,
    headerCount: spec.headerCount ?? 0,
    footerCount: spec.footerCount ?? 0,
    footnoteCount: 0,
  };
}

/** Фикстура spec.md: «Прогноз на матч» — 2 таба, таблица составов, эмодзи, стили. */
export function forecastDoc(): DocSnapshot {
  return buildDoc({
    title: 'Прогноз на матч',
    revisionId: 'rev-forecast-1',
    tabs: [
      {
        title: 'Прогноз',
        content: [
          p('Прогноз на матч Fluminense — Palmeiras', 'HEADING_1'),
          runs(
            { text: 'Изучаем форму ' },
            { text: 'Fluminense', style: { bold: true } },
            { text: ' перед дерби. Настроение отличное 😀' },
          ),
          p('Составы', 'HEADING_2'),
          p('Основа выйдет без ротации, Fluminense FC подтвердил заявку.'),
          {
            table: [
              ['Игрок', 'Позиция', 'Статус'],
              ['Иванов', 'нападающий', 'в основе'],
              ['Петров', 'защитник', 'под вопросом'],
              ['Сидоров', 'вратарь', 'в основе'],
            ],
          },
          p('Прогноз', 'HEADING_2'),
          p('Ставим на победу Fluminense со счётом 2:1.'),
        ],
      },
      {
        title: 'Черновики',
        content: [
          p('Устаревший прогноз на прошлый тур, Fluminense тогда сыграл вничью.'),
          p('Черновик заметки про прогноз погоды.'),
        ],
      },
    ],
  });
}

/** Фейковый клиент: отдаёт снимок; запись появится слайсом 3 вместе с семантикой правок. */
export class FakeDocsClient implements DocsClient {
  constructor(private snapshot: DocSnapshot) {}

  getDocument(): Promise<DocSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}
