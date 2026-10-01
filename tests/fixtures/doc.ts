/**
 * Фикстурный документ из spec.md («Прогноз на матч») и фейковый DocsClient.
 *
 * Индексы фикстура СЧИТАЕТ по правилам Docs API, а не расставляет руками:
 * - индексы — UTF-16 code units (`.length` JS-строки; эмодзи = 2 юнита);
 * - тело сегмента начинается с 1 (нулевой юнит занят началом сегмента);
 * - абзац занимает `[start, start + text.length + 1)` — плюс завершающий `\n`;
 * - таблица: 1 юнит на вход в таблицу, затем на каждую строку 1 юнит и на каждую
 *   ячейку 1 юнит + её абзацы, и ещё 1 юнит в КОНЦЕ таблицы.
 *   Сверено живьём 2026-10-01: пустая 3×3 со стартом 16 — строки [17,24) [24,31)
 *   [31,38), таблица [16,39); абзацы пустых ячеек начинаются в cellStart + 1. До
 *   прогона фейк не держал закрывающий юнит — всё после таблиц стояло на 1 левее Google.
 */

import { gcError } from '../../src/core/errors.js';
import { OBJECT_MARK } from '../../src/core/docs/types.js';
import type {
  DocParagraph,
  DocRequest,
  DocSnapshot,
  DocTab,
  DocTable,
  DocTextRun,
  DocTextStyle,
  DocsClient,
  ParagraphNamedStyle,
} from '../../src/core/docs/types.js';

/** Описание абзаца в билдере: строка или прогоны со стилем. */
export interface ParagraphSpec {
  readonly runs: readonly DocTextRun[];
  readonly style?: ParagraphNamedStyle | undefined;
  readonly bulleted?: boolean | undefined;
}

export const p = (text: string, style?: ParagraphNamedStyle): ParagraphSpec =>
  style === undefined ? { runs: [{ text }] } : { runs: [{ text }], style };

export const runs = (...parts: DocTextRun[]): ParagraphSpec => ({ runs: parts });

/** Ячейка в билдере: строка или прогоны (`\n` внутри прогона — новый абзац ячейки). */
export type CellSpec = string | readonly DocTextRun[];

export interface TableSpec {
  readonly table: readonly (readonly CellSpec[])[];
}

export interface TabSpec {
  readonly title: string;
  readonly content: readonly (ParagraphSpec | TableSpec)[];
}

const isTable = (item: ParagraphSpec | TableSpec): item is TableSpec => 'table' in item;

/** Ячейка → её абзацы (прогоны режутся по `\n`). */
function cellParagraphs(cell: CellSpec): DocTextRun[][] {
  if (typeof cell === 'string')
    return cell.split('\n').map((text) => (text === '' ? [] : [{ text }]));
  const out: DocTextRun[][] = [[]];
  for (const run of cell) {
    run.text.split('\n').forEach((piece, i) => {
      if (i > 0) out.push([]);
      if (piece !== '') out[out.length - 1]!.push({ ...run, text: piece });
    });
  }
  return out;
}

/** Собрать таб: абзацы и таблицы с посчитанными индексами. */
function buildTab(spec: TabSpec, tabNumber: number): DocTab {
  const paragraphs: DocParagraph[] = [];
  const tables: DocTable[] = [];
  let cursor = 1; // тело сегмента начинается с 1

  const pushParagraph = (
    item: ParagraphSpec,
    inTable?: { table: number; row: number; column: number },
  ): string => {
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
    return text;
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
    const rowRanges: { startIndex: number; endIndex: number }[] = [];
    const cellRanges: { startIndex: number; endIndex: number }[][] = [];
    item.table.forEach((rowSpec, r) => {
      const rowStart = cursor;
      cursor += 1; // вход в строку
      const rowCells: string[] = [];
      const rowCellRanges: { startIndex: number; endIndex: number }[] = [];
      rowSpec.forEach((cell, c) => {
        const cellStart = cursor;
        cursor += 1; // вход в ячейку
        const texts = cellParagraphs(cell).map((cellRuns) =>
          pushParagraph({ runs: cellRuns }, { table: tableNumber, row: r + 1, column: c + 1 }),
        );
        rowCellRanges.push({ startIndex: cellStart, endIndex: cursor });
        rowCells.push(texts.join('\n'));
      });
      cells.push(rowCells);
      cellRanges.push(rowCellRanges);
      rowRanges.push({ startIndex: rowStart, endIndex: cursor });
    });
    cursor += 1; // закрывающий юнит таблицы (живое наблюдение 2026-10-01)
    tables.push({
      index: tableNumber,
      startIndex: start,
      endIndex: cursor,
      rows: item.table.length,
      columns: item.table[0]?.length ?? 0,
      cells,
      rowRanges,
      cellRanges,
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

/* ------------------------------------------------------------------------------------ */
/* Фейк записи. Семантика — из документации Docs API, а где она скупа, из ЖИВОГО прогона  */
/* 2026-10-01 (урок L23: фейк, чья семантика взята предположением, зеленит всё разом):  */
/* - `writeControl.requiredRevisionId` не совпал → отказ, ни одной правки;               */
/* - вставка сдвигает все последующие индексы ровно на length текста (UTF-16);           */
/* - вставленный текст наследует стиль run'а СЛЕВА от точки вставки, а в пустом абзаце  */
/*   — стиль его переноса (`mark`);                                                     */
/* - `\n` внутри вставки создаёт новый абзац со стилем исходного;                        */
/* - insertTable режет абзац в точке вставки: перед таблицей Google ставит `\n`, хвост  */
/*   абзаца (у вставки в конец — пустой абзац) остаётся ПОСЛЕ таблицы (живьём);          */
/* - новая строка/колонка копирует стиль текста строки/колонки-образца по ячейкам        */
/*   (живьём: под строкой с жирным «Иванов» вставленный «Петров» стал жирным);          */
/* - удаление абзаца ЦЕЛИКОМ не трогает следующий: его стиль и буллет остаются (живьём); */
/* - deleteContentRange не может частично пересекать таблицу — отказ;                    */
/* - завершающий `\n` последнего абзаца сегмента удалить нельзя — отказ.                */
/* ------------------------------------------------------------------------------------ */

interface MutableParagraph {
  runs: DocTextRun[];
  style?: ParagraphNamedStyle | undefined;
  bulleted?: boolean | undefined;
  /** Стиль переноса абзаца: его наследует вставка в ПУСТОЙ абзац. */
  mark?: DocTextStyle | undefined;
}
/** Таблица: `table[row][column]` — абзацы ячейки. */
interface MutableTable {
  table: MutableParagraph[][][];
}
type MutableBlock = MutableParagraph | MutableTable;
const isMutableTable = (b: MutableBlock): b is MutableTable => 'table' in b;

interface MutableTab {
  title: string;
  blocks: MutableBlock[];
}

/** Located-абзац: мутабельный абзац и его границы в снимке текущего состояния. */
interface LocatedParagraph {
  paragraph: MutableParagraph;
  start: number;
  end: number;
}

const toMutable = (spec: DocSpec): MutableTab[] =>
  spec.tabs.map((tab) => ({
    title: tab.title,
    blocks: tab.content.map((item) =>
      isTable(item)
        ? {
            table: item.table.map((row) =>
              row.map((cell) => cellParagraphs(cell).map((r) => ({ runs: r }))),
            ),
          }
        : { runs: item.runs.map((r) => ({ ...r })), style: item.style, bulleted: item.bulleted },
    ),
  }));

/** Абзацы ячейки → ячейка спеки (абзацы через прогон `\n`). */
function cellToSpec(cell: readonly MutableParagraph[]): DocTextRun[] {
  const out: DocTextRun[] = [];
  cell.forEach((paragraph, i) => {
    if (i > 0) out.push({ text: '\n' });
    out.push(...paragraph.runs);
  });
  return out;
}

/** Разрез списка прогонов по смещению в тексте абзаца. */
function splitRuns(runs: readonly DocTextRun[], offset: number): [DocTextRun[], DocTextRun[]] {
  const left: DocTextRun[] = [];
  const right: DocTextRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const end = cursor + run.text.length;
    if (end <= offset) left.push({ ...run });
    else if (cursor >= offset) right.push({ ...run });
    else {
      const cut = offset - cursor;
      left.push({ ...run, text: run.text.slice(0, cut) });
      right.push({ ...run, text: run.text.slice(cut) });
    }
    cursor = end;
  }
  return [left, right];
}

/** Прогоны → абзацы по `\n`; стиль абзаца у всех кусков — исходный (по документации). */
function runsToParagraphs(runs: readonly DocTextRun[], base: MutableParagraph): MutableParagraph[] {
  const fresh = (): MutableParagraph => ({
    runs: [],
    style: base.style,
    bulleted: base.bulleted,
    mark: base.mark,
  });
  const out: MutableParagraph[] = [fresh()];
  for (const run of runs) {
    const pieces = run.text.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) out.push(fresh());
      if (piece !== '') out[out.length - 1]!.runs.push({ ...run, text: piece });
    });
  }
  return out;
}

/** Вставка текста в абзац по смещению: стиль — слева, в пустом абзаце — его переноса. */
function insertIntoParagraph(
  paragraph: MutableParagraph,
  offset: number,
  text: string,
): MutableParagraph[] {
  const [left, right] = splitRuns(paragraph.runs, offset);
  const neighbour = left[left.length - 1] ?? paragraph.runs[0];
  const inherited = neighbour === undefined ? paragraph.mark : neighbour.style;
  const inserted: DocTextRun = inherited === undefined ? { text } : { text, style: inherited };
  return runsToParagraphs([...left, inserted, ...right], paragraph);
}

/** Стиль, который новая ячейка копирует у образца: стиль его первого прогона. */
const templateStyle = (cell: readonly MutableParagraph[] | undefined): DocTextStyle | undefined =>
  cell?.[0]?.runs[0]?.style ?? cell?.[0]?.mark;

/** Фейковый клиент: снимок пересобирается из мутабельных блоков после каждой правки. */
export class FakeDocsClient implements DocsClient {
  private tabs: MutableTab[];
  private revision: string;
  private readonly base: DocSpec;
  readonly applied: DocRequest[][] = [];

  constructor(spec: DocSpec | DocSnapshot) {
    const asSpec =
      'tabs' in spec && spec.tabs.length > 0 && 'content' in (spec.tabs[0] ?? {})
        ? (spec as DocSpec)
        : snapshotToSpec(spec as DocSnapshot);
    this.tabs = toMutable(asSpec);
    this.base = asSpec;
    // Ревизия исходного снимка сохраняется: gc_read обязан показывать её, а не выдумку.
    this.revision = asSpec.revisionId ?? 'rev-1';
  }

  private bump(): void {
    const numbered = /^rev-(\d+)$/.exec(this.revision);
    this.revision = numbered === null ? `${this.revision}+1` : `rev-${Number(numbered[1]) + 1}`;
  }

  private spec(): DocSpec {
    return {
      ...this.base,
      revisionId: this.revision,
      tabs: this.tabs.map((tab) => ({
        title: tab.title,
        content: tab.blocks.map((b) =>
          isMutableTable(b)
            ? { table: b.table.map((row) => row.map(cellToSpec)) }
            : { runs: b.runs, style: b.style, bulleted: b.bulleted },
        ),
      })),
    };
  }

  getDocument(): Promise<DocSnapshot> {
    return Promise.resolve(buildDoc(this.spec()));
  }

  async batchUpdate(
    _id: string,
    requests: readonly DocRequest[],
    requiredRevisionId: string,
  ): Promise<{ revisionId: string }> {
    if (requiredRevisionId !== this.revision) {
      throw gcError('doc_changed', {
        detail: 'Документ изменился между превью и записью — запись отклонена целиком.',
      });
    }
    // Пакет применяется по порядку; каждый следующий запрос видит сдвинутые индексы.
    for (const request of requests) {
      if (request.kind === 'insertText') this.insertText(request);
      else if (request.kind === 'deleteRange') this.deleteRange(request);
      else if (request.kind === 'updateTextStyle') this.updateTextStyle(request);
      else if (request.kind === 'updateParagraphStyle') this.updateParagraphStyle(request);
      else if (request.kind === 'setBullets') this.setBullets(request);
      else if (request.kind === 'insertPageBreak' || request.kind === 'insertInlineImage')
        this.insertObject(request);
      else this.applyTable(request);
    }
    this.applied.push([...requests]);
    this.bump();
    return { revisionId: this.revision };
  }

  /** Блоки таба с их границами в снимке ТЕКУЩЕГО состояния (и сам снимок таба). */
  private located(tabId: string): {
    tab: MutableTab;
    built: DocTab;
    blocks: { block: MutableBlock; start: number; end: number }[];
  } {
    const snapshot = buildDoc(this.spec());
    const index = snapshot.tabs.findIndex((t) => t.tabId === tabId);
    const tab = this.tabs[index];
    const built = snapshot.tabs[index];
    if (tab === undefined || built === undefined) {
      throw gcError('bad_request', { detail: `Таба ${tabId} нет.` });
    }
    let paragraphCursor = 0;
    let tableCursor = 0;
    const blocks = tab.blocks.map((block) => {
      if (isMutableTable(block)) {
        const t = built.tables[tableCursor];
        tableCursor += 1;
        // Абзацы ячеек в счётчик НЕ входят: он индексирует список body-абзацев.
        return { block, start: t!.startIndex, end: t!.endIndex };
      }
      const p = built.paragraphs.filter((x) => x.inTable === undefined)[paragraphCursor];
      paragraphCursor += 1;
      return { block, start: p!.startIndex, end: p!.endIndex };
    });
    return { tab, built, blocks };
  }

  /** Абзацы ячеек таблицы с их границами — по построенному снимку. */
  private cellParagraphsOf(
    built: DocTab,
    block: MutableTable,
    tableStart: number,
  ): (LocatedParagraph & { cell: MutableParagraph[]; at: number })[] {
    const table = built.tables.find((t) => t.startIndex === tableStart);
    if (table === undefined) throw gcError('bad_request', { detail: 'Таблица не найдена.' });
    const out: (LocatedParagraph & { cell: MutableParagraph[]; at: number })[] = [];
    block.table.forEach((row, r) =>
      row.forEach((cell, c) => {
        const builtCell = built.paragraphs.filter(
          (x) =>
            x.inTable?.table === table.index &&
            x.inTable.row === r + 1 &&
            x.inTable.column === c + 1,
        );
        cell.forEach((paragraph, k) => {
          const b = builtCell[k]!;
          out.push({ paragraph, start: b.startIndex, end: b.endIndex, cell, at: k });
        });
      }),
    );
    return out;
  }

  private insertText(request: Extract<DocRequest, { kind: 'insertText' }>): void {
    const { tab, built, blocks } = this.located(request.tabId);
    const hit = blocks.find((b) => request.at >= b.start && request.at < b.end);
    if (hit !== undefined && !isMutableTable(hit.block)) {
      const paragraph = hit.block;
      const replacement = insertIntoParagraph(paragraph, request.at - hit.start, request.text);
      tab.blocks.splice(tab.blocks.indexOf(paragraph), 1, ...replacement);
      return;
    }
    if (hit !== undefined && isMutableTable(hit.block)) {
      // Вставка внутрь ячейки — легальна для Google: адресуем по границам абзацев ячеек.
      const target = this.cellParagraphsOf(built, hit.block, hit.start).find(
        (x) => request.at >= x.start && request.at < x.end,
      );
      if (target !== undefined) {
        const replacement = insertIntoParagraph(
          target.paragraph,
          request.at - target.start,
          request.text,
        );
        target.cell.splice(target.at, 1, ...replacement);
        return;
      }
    }
    throw gcError('bad_request', {
      detail: `Вставка по индексу ${request.at} не попадает в абзац (граница или таблица).`,
    });
  }

  /**
   * Абзацы, пересекающие диапазон, — общий шаг трёх стилевых запросов. Внутри одной
   * таблицы диапазон легален (стиль текста ячеек); через границу таблицы — отказ.
   */
  private paragraphsIn(tabId: string, startIndex: number, endIndex: number): LocatedParagraph[] {
    const { built, blocks } = this.located(tabId);
    const touched = blocks.filter((b) => startIndex < b.end && endIndex > b.start);
    const table = touched.find((b) => isMutableTable(b.block));
    if (table !== undefined && isMutableTable(table.block)) {
      if (touched.length > 1 || startIndex < table.start || endIndex > table.end) {
        throw gcError('bad_request', { detail: 'Диапазон стиля пересекает границу таблицы.' });
      }
      return this.cellParagraphsOf(built, table.block, table.start).filter(
        (x) => startIndex < x.end && endIndex > x.start,
      );
    }
    return touched.map((b) => ({
      paragraph: b.block as MutableParagraph,
      start: b.start,
      end: b.end,
    }));
  }

  private updateTextStyle(request: Extract<DocRequest, { kind: 'updateTextStyle' }>): void {
    const restyle = (style: DocTextStyle | undefined): DocTextStyle | undefined => {
      const next = request.exact === true ? { ...request.style } : { ...style, ...request.style };
      return Object.keys(next).length === 0 ? undefined : next;
    };
    for (const { paragraph, start, end } of this.paragraphsIn(
      request.tabId,
      request.startIndex,
      request.endIndex,
    )) {
      const from = Math.max(request.startIndex, start) - start;
      const to = Math.min(request.endIndex, end) - start;
      const [left, mid0] = splitRuns(paragraph.runs, from);
      const [mid, right] = splitRuns(mid0, to - from);
      const styled = mid.map((run) => {
        const style = restyle(run.style);
        return style === undefined ? { text: run.text } : { text: run.text, style };
      });
      paragraph.runs = [...left, ...styled, ...right];
      // Диапазон накрыл перенос абзаца — меняется и стиль, который унаследует вставка.
      if (request.endIndex >= end) paragraph.mark = restyle(paragraph.mark);
    }
  }

  private updateParagraphStyle(
    request: Extract<DocRequest, { kind: 'updateParagraphStyle' }>,
  ): void {
    for (const hit of this.paragraphsIn(request.tabId, request.startIndex, request.endIndex)) {
      hit.paragraph.style = request.namedStyle;
    }
  }

  private setBullets(request: Extract<DocRequest, { kind: 'setBullets' }>): void {
    for (const hit of this.paragraphsIn(request.tabId, request.startIndex, request.endIndex)) {
      hit.paragraph.bulleted = request.bulleted ? true : undefined;
    }
  }

  /**
   * Разрыв страницы и inline-картинка — ОБЪЕКТ внутри абзаца: знак OBJECT_MARK с пометкой
   * вида, ровно как его отдаёт шов. Живьём 2026-10-01: картинка — 1 юнит; разрыв Google
   * вставляет С переводом строки, и абзац режется надвое (знак + `\n`).
   */
  private insertObject(
    request: Extract<DocRequest, { kind: 'insertPageBreak' | 'insertInlineImage' }>,
  ): void {
    const { tab, blocks } = this.located(request.tabId);
    const hit = blocks.find(
      (b) => !isMutableTable(b.block) && request.at >= b.start && request.at < b.end,
    );
    if (hit === undefined || isMutableTable(hit.block)) {
      throw gcError('bad_request', {
        detail: `Объект по индексу ${request.at} не попадает в абзац.`,
      });
    }
    const paragraph = hit.block;
    const [left, right] = splitRuns(paragraph.runs, request.at - hit.start);
    const object: DocTextRun[] =
      request.kind === 'insertPageBreak'
        ? [{ text: OBJECT_MARK, object: 'pageBreak' }, { text: '\n' }]
        : [{ text: OBJECT_MARK, object: 'image' }];
    const replacement = runsToParagraphs([...left, ...object, ...right], paragraph);
    tab.blocks.splice(tab.blocks.indexOf(paragraph), 1, ...replacement);
  }

  /** Табличные структурные запросы: мутируют блок-таблицу, найденную по startIndex. */
  private applyTable(
    request: Extract<
      DocRequest,
      {
        kind:
          | 'insertTable'
          | 'insertTableRow'
          | 'insertTableColumn'
          | 'deleteTableRow'
          | 'deleteTableColumn';
      }
    >,
  ): void {
    const { tab, blocks } = this.located(request.tabId);
    if (request.kind === 'insertTable') {
      const hit = blocks.find(
        (b) => !isMutableTable(b.block) && request.at >= b.start && request.at < b.end,
      );
      if (hit === undefined || isMutableTable(hit.block)) {
        throw gcError('bad_request', { detail: `insertTable: позиция ${request.at} вне абзаца.` });
      }
      // Живьём: перед таблицей встаёт `\n` в точке вставки — абзац режется, его хвост
      // (у вставки в конец — пустой абзац с тем же видом) остаётся ПОСЛЕ таблицы.
      const paragraph = hit.block;
      const [left, right] = splitRuns(paragraph.runs, request.at - hit.start);
      const piece = (pieceRuns: DocTextRun[]): MutableParagraph => ({
        runs: pieceRuns,
        style: paragraph.style,
        bulleted: paragraph.bulleted,
        mark: paragraph.mark,
      });
      const empty: MutableParagraph[][][] = Array.from({ length: request.rows }, () =>
        Array.from({ length: request.columns }, () => [{ runs: [] }]),
      );
      tab.blocks.splice(
        tab.blocks.indexOf(paragraph),
        1,
        piece(left),
        { table: empty },
        piece(right),
      );
      return;
    }
    const hit = blocks.find((b) => isMutableTable(b.block) && b.start === request.tableStart);
    if (hit === undefined || !isMutableTable(hit.block)) {
      throw gcError('bad_request', {
        detail: `Таблицы со startIndex ${request.tableStart} нет — Google отклонил бы запрос.`,
      });
    }
    const grid = hit.block.table;
    if (request.kind === 'insertTableRow') {
      // Новая строка копирует стиль строки-образца по колонкам (живое наблюдение).
      const template = grid[request.rowIndex];
      grid.splice(
        request.rowIndex + (request.below ? 1 : 0),
        0,
        (template ?? []).map((cell) => [{ runs: [], mark: templateStyle(cell) }]),
      );
    } else if (request.kind === 'insertTableColumn') {
      for (const row of grid) {
        const mark = templateStyle(row[request.columnIndex]);
        row.splice(request.columnIndex + (request.right ? 1 : 0), 0, [{ runs: [], mark }]);
      }
    } else if (request.kind === 'deleteTableRow') {
      if (grid.length === 1) {
        // По документации удаление единственной строки удаляет таблицу целиком.
        tab.blocks.splice(tab.blocks.indexOf(hit.block), 1);
        return;
      }
      grid.splice(request.rowIndex, 1);
    } else {
      if ((grid[0]?.length ?? 0) === 1) {
        tab.blocks.splice(tab.blocks.indexOf(hit.block), 1);
        return;
      }
      for (const row of grid) row.splice(request.columnIndex, 1);
    }
  }

  private deleteRange(request: Extract<DocRequest, { kind: 'deleteRange' }>): void {
    const { tab, blocks } = this.located(request.tabId);
    const { startIndex: s, endIndex: e } = request;
    const touched = blocks.filter((b) => s < b.end && e > b.start);
    if (touched.length === 0) {
      throw gcError('bad_request', { detail: `Диапазон [${s}, ${e}) вне тела таба.` });
    }
    // Полный охват ровно одной таблицы удаляет её целиком (так делает и Google).
    if (
      touched.length === 1 &&
      isMutableTable(touched[0]!.block) &&
      s <= touched[0]!.start &&
      e >= touched[0]!.end
    ) {
      tab.blocks.splice(tab.blocks.indexOf(touched[0]!.block), 1);
      return;
    }
    if (touched.some((b) => isMutableTable(b.block))) {
      throw gcError('bad_request', {
        detail: 'Диапазон пересекает таблицу — Google отклоняет такое удаление.',
      });
    }
    const last = touched[touched.length - 1]!;
    const lastBodyBlock = blocks[blocks.length - 1]!;
    if (e >= last.end && last === lastBodyBlock) {
      throw gcError('bad_request', {
        detail: 'Завершающий перенос последнего абзаца сегмента удалить нельзя.',
      });
    }
    const first = touched[0]!;
    const firstParagraph = first.block as MutableParagraph;
    const [keepLeft] = splitRuns(firstParagraph.runs, Math.max(0, s - first.start));
    const tailSource = e >= last.end ? blocks[blocks.indexOf(last) + 1] : last;
    if (tailSource === undefined || isMutableTable(tailSource.block)) {
      // Документация: перенос ПЕРЕД таблицей удалить нельзя, не удалив саму таблицу.
      throw gcError('bad_request', {
        detail: 'Перенос перед таблицей удалить нельзя — Google отклоняет такое удаление.',
      });
    }
    const tailParagraph = tailSource.block;
    const [, keepRight] = splitRuns(tailParagraph.runs, Math.max(0, e - tailSource.start));
    // Первый абзац удалён ЦЕЛИКОМ — следующий остаётся собой: стиль и буллет его
    // (живьём 2026-10-01). Частичный захват первого — вид первого (прочтение, не замер).
    const keeper = s <= first.start ? tailParagraph : firstParagraph;
    const merged: MutableParagraph = {
      runs: [...keepLeft, ...keepRight],
      style: keeper.style,
      bulleted: keeper.bulleted,
      mark: tailParagraph.mark,
    };
    const from = tab.blocks.indexOf(first.block);
    const to = tab.blocks.indexOf(tailSource.block);
    tab.blocks.splice(from, to - from + 1, merged);
  }
}

/** Снимок → спека фейка: чтобы тесты могли стартовать с готового `DocSnapshot`. */
function snapshotToSpec(snapshot: DocSnapshot): DocSpec {
  return {
    title: snapshot.title,
    revisionId: snapshot.revisionId,
    hasSuggestions: snapshot.hasSuggestions,
    headerCount: snapshot.headerCount,
    footerCount: snapshot.footerCount,
    tabs: snapshot.tabs.map((tab) => {
      const content: (ParagraphSpec | TableSpec)[] = [];
      let lastTableIndex = -1;
      for (const p of tab.paragraphs) {
        if (p.inTable !== undefined) {
          if (p.inTable.table !== lastTableIndex) {
            lastTableIndex = p.inTable.table;
            const t = tab.tables.find((x) => x.index === p.inTable!.table)!;
            // Ячейки — прогонами своих абзацев: стили ячеек не теряются при переходе.
            content.push({
              table: t.cells.map((row, r) =>
                row.map((_, c) =>
                  cellToSpec(
                    tab.paragraphs
                      .filter(
                        (x) =>
                          x.inTable?.table === t.index &&
                          x.inTable.row === r + 1 &&
                          x.inTable.column === c + 1,
                      )
                      .map((x) => ({ runs: [...x.runs] })),
                  ),
                ),
              ),
            });
          }
          continue;
        }
        content.push({ runs: p.runs, style: p.namedStyle, bulleted: p.bulleted });
      }
      return { title: tab.title, content };
    }),
  };
}
