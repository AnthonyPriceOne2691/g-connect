/**
 * `DocsClient` над `googleapis`: перевод ответа Google в доменный снимок документа.
 *
 * Единственное место, где ядро видит форму Docs API. Всё остальное — карта, селекторы,
 * превью, снимки — работает с доменными типами и проверяется без сети.
 *
 * Контракты шва, взятые ИЗ ДОКУМЕНТАЦИИ (урок L3/L23 — не предполагать):
 * - индексы — UTF-16 code units; суррогатная пара — 2 юнита;
 * - `documents.get` с `includeTabsContent: true` кладёт содержимое в `tabs[]`
 *   (в том числе у документа с единственным табом), а не в `body`;
 * - текст абзаца приходит прогонами `textRun.content`, последний кончается `\n`;
 * - `null` в ответе значит «поля нет», а не «значение null».
 */

import { google, type docs_v1 } from 'googleapis';

import { fromGoogleError, gcError, type GcError } from '../errors.js';
import { toDocRequest } from './doc-requests.js';
import { authorizedClient, makeRetry, rgbToHex, type RetryReporter } from './support.js';
import {
  OBJECT_MARK,
  type DocObjectKind,
  type DocParagraph,
  type DocRequest,
  type DocSnapshot,
  type DocTab,
  type DocTable,
  type DocTextRun,
  type DocTextStyle,
  type DocsClient,
  type ParagraphNamedStyle,
} from '../docs/types.js';

/** `null` в ответе Google значит «поля нет». */
const some = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

/** Поле вида попадает в домен только когда задано явно: `undefined` и `false` — разное. */
const flag = (value: boolean | null | undefined): boolean | undefined =>
  value === undefined || value === null ? undefined : value;

/** У Docs цвет завёрнут в `OptionalColor`; доли переводит общий `rgbToHex`. */
function docColorToHex(color: docs_v1.Schema$OptionalColor | undefined): string | undefined {
  const rgb = color?.color?.rgbColor;
  return rgb === undefined || rgb === null ? undefined : rgbToHex(rgb);
}

function toStyle(style: docs_v1.Schema$TextStyle | undefined): DocTextStyle | undefined {
  if (style === undefined) return undefined;
  // Таблица полей, а не цепочка if: поле попадает в домен, только когда задано явно.
  const fields: readonly (readonly [keyof DocTextStyle, DocTextStyle[keyof DocTextStyle]])[] = [
    ['bold', flag(style.bold)],
    ['italic', flag(style.italic)],
    ['underline', flag(style.underline)],
    ['strikethrough', flag(style.strikethrough)],
    ['link', some(style.link?.url)],
    ['fontSize', some(style.fontSize?.magnitude)],
    ['color', docColorToHex(some(style.foregroundColor))],
  ];
  const out: Partial<Record<keyof DocTextStyle, DocTextStyle[keyof DocTextStyle]>> = {};
  for (const [key, value] of fields) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : (out as DocTextStyle);
}

const NAMED_STYLES: ReadonlySet<ParagraphNamedStyle> = new Set([
  'NORMAL_TEXT',
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

function toNamedStyle(value: string | null | undefined): ParagraphNamedStyle {
  return NAMED_STYLES.has(value as ParagraphNamedStyle)
    ? (value as ParagraphNamedStyle)
    : 'NORMAL_TEXT';
}

/** Есть ли в узле след неразрешённого предложения. Ищем по известным полям, не глубже. */
function paragraphHasSuggestions(paragraph: docs_v1.Schema$Paragraph): boolean {
  if (Object.keys(paragraph.suggestedParagraphStyleChanges ?? {}).length > 0) return true;
  return (paragraph.elements ?? []).some((el) => {
    const run = el.textRun;
    if (run === undefined) return false;
    return (
      (run.suggestedInsertionIds ?? []).length > 0 ||
      (run.suggestedDeletionIds ?? []).length > 0 ||
      Object.keys(run.suggestedTextStyleChanges ?? {}).length > 0
    );
  });
}

/** Элемент абзаца, который занимает юниты без текста, — и как он зовётся в домене. */
const OBJECT_ELEMENTS: readonly (readonly [
  keyof docs_v1.Schema$ParagraphElement,
  DocObjectKind,
])[] = [
  ['inlineObjectElement', 'image'],
  ['person', 'person'],
  ['dateElement', 'date'],
  ['pageBreak', 'pageBreak'],
  ['columnBreak', 'columnBreak'],
  ['footnoteReference', 'footnote'],
  ['equation', 'equation'],
  ['richLink', 'richLink'],
  ['autoText', 'autoText'],
  ['horizontalRule', 'horizontalRule'],
];

/**
 * Объект — знаками OBJECT_MARK по его ширине из ответа (живьём 2026-10-01: картинка, чипы,
 * разрыв — по 1 юниту). Раньше шов брал только textRun, и текст абзаца с объектом был
 * короче его ширины: всё индексное после картинки съезжало на юнит.
 */
function objectRun(el: docs_v1.Schema$ParagraphElement): DocTextRun | undefined {
  const hit = OBJECT_ELEMENTS.find(([key]) => el[key] !== undefined && el[key] !== null);
  if (hit === undefined) return undefined;
  const width = Math.max(1, (el.endIndex ?? 0) - (el.startIndex ?? 0));
  return { text: OBJECT_MARK.repeat(width), object: hit[1] };
}

/** Прогоны абзаца и признак встроенного объекта — без завершающего `\n` последнего прогона. */
function collectRuns(paragraph: docs_v1.Schema$Paragraph): {
  runs: DocTextRun[];
  hasInlineObject: boolean;
} {
  const runs: DocTextRun[] = [];
  let hasInlineObject = false;
  for (const el of paragraph.elements ?? []) {
    const object = objectRun(el);
    if (object !== undefined) {
      runs.push(object);
      hasInlineObject = true;
      continue;
    }
    const content = some(el.textRun?.content);
    if (content === undefined) continue;
    const style = toStyle(some(el.textRun?.textStyle));
    runs.push(style === undefined ? { text: content } : { text: content, style });
  }
  trimTrailingNewline(runs);
  return { runs, hasInlineObject };
}

/** Завершающий `\n` абзаца живёт в последнем прогоне — в домене текст без него. */
function trimTrailingNewline(runs: DocTextRun[]): void {
  const last = runs.length - 1;
  if (last < 0 || !runs[last]!.text.endsWith('\n')) return;
  const trimmed = runs[last]!.text.slice(0, -1);
  if (trimmed === '') runs.pop();
  else runs[last] = { ...runs[last]!, text: trimmed };
}

interface ParagraphParts {
  readonly index: number;
  readonly element: docs_v1.Schema$StructuralElement;
  readonly paragraph: docs_v1.Schema$Paragraph;
  readonly runs: readonly DocTextRun[];
  readonly hasInlineObject: boolean;
  readonly inTable?: { table: number; row: number; column: number } | undefined;
}

function buildParagraph(parts: ParagraphParts): DocParagraph {
  const { element, paragraph, runs } = parts;
  const bulleted = paragraph.bullet !== undefined && paragraph.bullet !== null;
  return {
    index: parts.index,
    startIndex: some(element.startIndex) ?? 0,
    endIndex: some(element.endIndex) ?? 0,
    text: runs.map((r) => r.text).join(''),
    runs,
    namedStyle: toNamedStyle(paragraph.paragraphStyle?.namedStyleType),
    ...(bulleted ? { bulleted: true } : {}),
    ...(parts.inTable === undefined ? {} : { inTable: parts.inTable }),
    ...(parts.hasInlineObject ? { hasInlineObject: true } : {}),
  };
}

/** Накопитель перевода одного таба: абзацы верхнего уровня и содержимое таблиц. */
class TabReader {
  readonly paragraphs: DocParagraph[] = [];
  readonly tables: DocTable[] = [];
  hasSuggestions = false;
  endIndex = 0;

  readParagraph(
    element: docs_v1.Schema$StructuralElement,
    inTable?: { table: number; row: number; column: number },
  ): void {
    const paragraph = element.paragraph;
    if (paragraph === undefined) return;
    if (paragraphHasSuggestions(paragraph)) this.hasSuggestions = true;
    const { runs, hasInlineObject } = collectRuns(paragraph);
    this.paragraphs.push(
      buildParagraph({
        index: this.paragraphs.length + 1,
        element,
        paragraph,
        runs,
        hasInlineObject,
        inTable,
      }),
    );
  }

  readTable(element: docs_v1.Schema$StructuralElement): void {
    const table = element.table;
    if (table === undefined) return;
    const tableNumber = this.tables.length + 1;
    const cells: string[][] = [];
    const rowRanges: { startIndex: number; endIndex: number }[] = [];
    const cellRanges: { startIndex: number; endIndex: number }[][] = [];
    (table.tableRows ?? []).forEach((row, r) => {
      const rowCells: string[] = [];
      const rowCellRanges: { startIndex: number; endIndex: number }[] = [];
      rowRanges.push({
        startIndex: some(row.startIndex) ?? 0,
        endIndex: some(row.endIndex) ?? 0,
      });
      (row.tableCells ?? []).forEach((cell, c) => {
        rowCellRanges.push({
          startIndex: some(cell.startIndex) ?? 0,
          endIndex: some(cell.endIndex) ?? 0,
        });
        const before = this.paragraphs.length;
        for (const inner of cell.content ?? []) {
          this.readParagraph(inner, { table: tableNumber, row: r + 1, column: c + 1 });
        }
        rowCells.push(
          this.paragraphs
            .slice(before)
            .map((p) => p.text)
            .join('\n'),
        );
      });
      cells.push(rowCells);
      cellRanges.push(rowCellRanges);
    });
    this.tables.push({
      index: tableNumber,
      startIndex: some(element.startIndex) ?? 0,
      endIndex: some(element.endIndex) ?? 0,
      rows: some(table.rows) ?? cells.length,
      columns: some(table.columns) ?? cells[0]?.length ?? 0,
      cells,
      rowRanges,
      cellRanges,
    });
  }

  readBody(content: readonly docs_v1.Schema$StructuralElement[]): void {
    for (const element of content) {
      if (element.paragraph !== undefined) this.readParagraph(element);
      else if (element.table !== undefined) this.readTable(element);
      this.endIndex = Math.max(this.endIndex, some(element.endIndex) ?? 0);
    }
  }
}

/** Дерево табов → плоский список в порядке обхода (детей Docs показывает после родителя). */
function flattenTabs(tabs: readonly docs_v1.Schema$Tab[]): docs_v1.Schema$Tab[] {
  const out: docs_v1.Schema$Tab[] = [];
  for (const tab of tabs) {
    out.push(tab);
    out.push(...flattenTabs(tab.childTabs ?? []));
  }
  return out;
}

/** Один таб Google → доменный таб. */
function toTab(
  tab: docs_v1.Schema$Tab,
  position: number,
): { tab: DocTab; hasSuggestions: boolean } {
  const reader = new TabReader();
  reader.readBody(tab.documentTab?.body?.content ?? []);
  return {
    tab: {
      tabId: some(tab.tabProperties?.tabId) ?? `tab-${position}`,
      title: some(tab.tabProperties?.title) ?? `Таб ${position}`,
      paragraphs: reader.paragraphs,
      tables: reader.tables,
      endIndex: reader.endIndex,
    },
    hasSuggestions: reader.hasSuggestions,
  };
}

/** Сегменты вне тела: колонтитулы и сноски документа и каждого таба — ядро их не правит. */
function countSegments(
  document: docs_v1.Schema$Document,
  rawTabs: readonly docs_v1.Schema$Tab[],
): { headerCount: number; footerCount: number; footnoteCount: number } {
  const sizeOf = (map: Record<string, unknown> | null | undefined): number =>
    Object.keys(map ?? {}).length;
  const counts = {
    headerCount: sizeOf(document.headers),
    footerCount: sizeOf(document.footers),
    footnoteCount: sizeOf(document.footnotes),
  };
  for (const tab of rawTabs) {
    counts.headerCount += sizeOf(tab.documentTab?.headers);
    counts.footerCount += sizeOf(tab.documentTab?.footers);
    counts.footnoteCount += sizeOf(tab.documentTab?.footnotes);
  }
  return counts;
}

export function toDocSnapshot(docId: string, document: docs_v1.Schema$Document): DocSnapshot {
  const rawTabs = flattenTabs(document.tabs ?? []);
  const converted = rawTabs.map((tab, i) => toTab(tab, i + 1));
  return {
    docId,
    title: some(document.title) ?? '',
    revisionId: some(document.revisionId) ?? '',
    tabs: converted.map((c) => c.tab),
    hasSuggestions: converted.some((c) => c.hasSuggestions),
    ...countSegments(document, rawTabs),
  };
}

export interface GoogleDocsClientOptions {
  readonly accessToken: string;
  readonly onRetry?: RetryReporter;
  /**
   * Готовый клиент библиотеки — для оракулов шва: они судят разбор ответов Google в
   * живой форме, а фейк DocsClient этот разбор обходит целиком (урок LR3-1).
   */
  readonly api?: docs_v1.Docs;
}

export class GoogleDocsClient implements DocsClient {
  private readonly docs: docs_v1.Docs;
  private readonly retry: ReturnType<typeof makeRetry>;

  constructor(options: GoogleDocsClientOptions) {
    this.docs =
      options.api ?? google.docs({ version: 'v1', auth: authorizedClient(options.accessToken) });
    this.retry = makeRetry(options.onRetry);
  }

  async getDocument(id: string): Promise<DocSnapshot> {
    try {
      const { data } = await this.retry(() =>
        this.docs.documents.get({ documentId: id, includeTabsContent: true }),
      );
      return toDocSnapshot(id, data);
    } catch (error) {
      throw fromGoogleError(error, `Не удалось прочитать документ ${id}.`);
    }
  }

  async batchUpdate(
    id: string,
    requests: readonly DocRequest[],
    requiredRevisionId: string,
  ): Promise<{ revisionId: string }> {
    try {
      const { data } = await this.retry(async () => {
        try {
          return await this.docs.documents.batchUpdate({
            documentId: id,
            requestBody: {
              requests: requests.map(toDocRequest),
              // Предусловие произносит сервер: ревизия ушла — отказ, ни одной правки.
              writeControl: { requiredRevisionId },
            },
          });
        } catch (error) {
          // Распознаём ДО ретрая: он переводит сырую ошибку в bad_request, и текст Google
          // про ревизию после этого уже не прочитать (живой прогон 2026-10-01, LR3-1).
          throw staleRevision(error) ?? error;
        }
      });
      // Сверено живьём 2026-10-01: ответ несёт writeControl с ревизией ПОСЛЕ записи, и
      // она равна ревизии следующего чтения. Пустая строка честнее выдумки, если её нет.
      return { revisionId: data.writeControl?.requiredRevisionId ?? '' };
    } catch (error) {
      throw fromGoogleError(error, `Не удалось записать в документ ${id}.`);
    }
  }
}

/**
 * Отказ по ушедшей ревизии. Машинного кода причины у него нет: живьём (2026-10-01) это
 * 400 INVALID_ARGUMENT с текстом «The required revision ID '…' does not match the latest
 * revision.» — распознаём по статусу и упоминанию ревизии.
 */
function staleRevision(error: unknown): GcError | undefined {
  const message = String((error as { message?: unknown })?.message ?? error);
  const status = Number(
    (error as { status?: unknown; code?: unknown })?.status ?? (error as { code?: unknown })?.code,
  );
  if (status !== 400 || !/revision/i.test(message)) return undefined;
  return gcError('doc_changed', {
    detail: 'Документ изменился между превью и записью — Google отклонил запись целиком.',
    cause: message,
  });
}
