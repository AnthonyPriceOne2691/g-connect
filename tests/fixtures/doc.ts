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

import { gcError } from '../../src/core/errors.js';
import type {
  DocParagraph,
  DocRequest,
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
  readonly style?: ParagraphNamedStyle | undefined;
  readonly bulleted?: boolean | undefined;
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
    const rowRanges: { startIndex: number; endIndex: number }[] = [];
    const cellRanges: { startIndex: number; endIndex: number }[][] = [];
    item.table.forEach((rowSpec, r) => {
      const rowStart = cursor;
      cursor += 1; // вход в строку
      const rowCells: string[] = [];
      const rowCellRanges: { startIndex: number; endIndex: number }[] = [];
      rowSpec.forEach((cellText, c) => {
        const cellStart = cursor;
        cursor += 1; // вход в ячейку
        pushParagraph(
          { runs: [{ text: cellText }] },
          { table: tableNumber, row: r + 1, column: c + 1 },
        );
        rowCellRanges.push({ startIndex: cellStart, endIndex: cursor });
        rowCells.push(cellText);
      });
      cells.push(rowCells);
      cellRanges.push(rowCellRanges);
      rowRanges.push({ startIndex: rowStart, endIndex: cursor });
    });
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
/* Фейк записи: семантика ВЗЯТА ИЗ ДОКУМЕНТАЦИИ Docs API (урок L23 — не предполагать):   */
/* - `writeControl.requiredRevisionId` не совпал → отказ, ни одной правки;               */
/* - вставка сдвигает все последующие индексы ровно на length текста (UTF-16);           */
/* - вставленный текст наследует стиль run'а СЛЕВА от точки вставки;                     */
/* - `\n` внутри вставки создаёт новый абзац со стилем исходного;                        */
/* - deleteContentRange не может частично пересекать таблицу — отказ;                    */
/* - завершающий `\n` последнего абзаца сегмента удалить нельзя — отказ.                */
/* ------------------------------------------------------------------------------------ */

interface MutableParagraph {
  runs: DocTextRun[];
  style?: ParagraphNamedStyle | undefined;
  bulleted?: boolean | undefined;
}
interface MutableTable {
  table: string[][];
}
type MutableBlock = MutableParagraph | MutableTable;
const isMutableTable = (b: MutableBlock): b is MutableTable => 'table' in b;

interface MutableTab {
  title: string;
  blocks: MutableBlock[];
}

const toMutable = (spec: DocSpec): MutableTab[] =>
  spec.tabs.map((tab) => ({
    title: tab.title,
    blocks: tab.content.map((item) =>
      isTable(item)
        ? { table: item.table.map((r) => [...r]) }
        : { runs: item.runs.map((r) => ({ ...r })), style: item.style, bulleted: item.bulleted },
    ),
  }));

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
  const out: MutableParagraph[] = [{ runs: [], style: base.style, bulleted: base.bulleted }];
  for (const run of runs) {
    const pieces = run.text.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) out.push({ runs: [], style: base.style, bulleted: base.bulleted });
      if (piece !== '') out[out.length - 1]!.runs.push({ ...run, text: piece });
    });
  }
  return out;
}

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
            ? { table: b.table }
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
      else this.applyTable(request);
    }
    this.applied.push([...requests]);
    this.bump();
    return { revisionId: this.revision };
  }

  /** Блоки таба с их границами в снимке ТЕКУЩЕГО состояния. */
  private located(tabId: string): {
    tab: MutableTab;
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
    return { tab, blocks };
  }

  private insertText(request: Extract<DocRequest, { kind: 'insertText' }>): void {
    const { tab, blocks } = this.located(request.tabId);
    const hit = blocks.find(
      (b) => !isMutableTable(b.block) && request.at >= b.start && request.at < b.end,
    );
    if (hit === undefined || isMutableTable(hit.block)) {
      // Вставка внутрь ячейки таблицы — легальна для Google: адресуем по границам ячеек.
      const inTable = blocks.find(
        (b) => isMutableTable(b.block) && request.at > b.start && request.at < b.end,
      );
      if (inTable !== undefined && isMutableTable(inTable.block)) {
        this.insertIntoCell(request, inTable.block, inTable.start);
        return;
      }
      throw gcError('bad_request', {
        detail: `Вставка по индексу ${request.at} не попадает в абзац (граница или таблица).`,
      });
    }
    const paragraph = hit.block;
    const offset = request.at - hit.start;
    const [left, right] = splitRuns(paragraph.runs, offset);
    // Стиль вставленного — стиль run'а слева от точки вставки (по документации).
    const styleSource = left[left.length - 1] ?? paragraph.runs[0];
    const inserted: DocTextRun =
      styleSource?.style === undefined
        ? { text: request.text }
        : { text: request.text, style: styleSource.style };
    const merged = [...left, inserted, ...right];
    const replacement = runsToParagraphs(merged, paragraph);
    tab.blocks.splice(tab.blocks.indexOf(paragraph), 1, ...replacement);
  }

  /** Вставка текста в ячейку: ячейка ищется по построенным границам текущего снимка. */
  private insertIntoCell(
    request: Extract<DocRequest, { kind: 'insertText' }>,
    block: MutableTable,
    blockStart: number,
  ): void {
    const snapshot = buildDoc(this.spec());
    const built = snapshot.tabs.flatMap((t) => t.tables).find((t) => t.startIndex === blockStart);
    if (built === undefined) {
      throw gcError('bad_request', { detail: 'Таблица не найдена по границам.' });
    }
    for (let r = 0; r < built.cellRanges.length; r += 1) {
      for (let c = 0; c < built.cellRanges[r]!.length; c += 1) {
        const cell = built.cellRanges[r]![c]!;
        // Текст ячейки живёт в [start+1, end): вход в ячейку — 1 юнит.
        if (request.at >= cell.startIndex + 1 && request.at < cell.endIndex) {
          const offset = request.at - (cell.startIndex + 1);
          const current = block.table[r]![c]!;
          block.table[r]![c] = current.slice(0, offset) + request.text + current.slice(offset);
          return;
        }
      }
    }
    throw gcError('bad_request', {
      detail: `Вставка по индексу ${request.at} попала между ячейками таблицы.`,
    });
  }

  /** Абзацы, пересекающие диапазон, — общий шаг трёх стилевых запросов. */
  private paragraphsIn(
    tabId: string,
    startIndex: number,
    endIndex: number,
  ): { paragraph: MutableParagraph; start: number; end: number }[] {
    const { blocks } = this.located(tabId);
    const touched = blocks.filter((b) => startIndex < b.end && endIndex > b.start);
    if (touched.some((b) => isMutableTable(b.block))) {
      throw gcError('bad_request', { detail: 'Диапазон стиля пересекает таблицу.' });
    }
    return touched.map((b) => ({
      paragraph: b.block as MutableParagraph,
      start: b.start,
      end: b.end,
    }));
  }

  private updateTextStyle(request: Extract<DocRequest, { kind: 'updateTextStyle' }>): void {
    for (const { paragraph, start, end } of this.paragraphsIn(
      request.tabId,
      request.startIndex,
      request.endIndex,
    )) {
      const from = Math.max(request.startIndex, start) - start;
      const to = Math.min(request.endIndex, end) - start;
      const [left, mid0] = splitRuns(paragraph.runs, from);
      const [mid, right] = splitRuns(mid0, to - from);
      const styled = mid.map((run) => ({
        ...run,
        style: { ...run.style, ...request.style },
      }));
      paragraph.runs = [...left, ...styled, ...right];
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
      if (hit === undefined) {
        throw gcError('bad_request', { detail: `insertTable: позиция ${request.at} вне абзаца.` });
      }
      const empty: string[][] = Array.from({ length: request.rows }, () =>
        Array.from({ length: request.columns }, () => ''),
      );
      tab.blocks.splice(tab.blocks.indexOf(hit.block) + 1, 0, { table: empty });
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
      const width = grid[0]?.length ?? 0;
      grid.splice(
        request.rowIndex + (request.below ? 1 : 0),
        0,
        Array.from({ length: width }, () => ''),
      );
    } else if (request.kind === 'insertTableColumn') {
      for (const row of grid) row.splice(request.columnIndex + (request.right ? 1 : 0), 0, '');
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
    const tailParagraph = tailSource!.block as MutableParagraph;
    const [, keepRight] = splitRuns(tailParagraph.runs, Math.max(0, e - tailSource!.start));
    const merged: MutableParagraph = {
      runs: [...keepLeft, ...keepRight],
      style: firstParagraph.style,
      bulleted: firstParagraph.bulleted,
    };
    const from = tab.blocks.indexOf(first.block);
    const to = tab.blocks.indexOf(tailSource!.block);
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
      let tableCursor = 0;
      let lastTableIndex = -1;
      for (const p of tab.paragraphs) {
        if (p.inTable !== undefined) {
          if (p.inTable.table !== lastTableIndex) {
            lastTableIndex = p.inTable.table;
            const t = tab.tables[tableCursor];
            tableCursor += 1;
            content.push({ table: t!.cells.map((r) => [...r]) });
          }
          continue;
        }
        content.push({ runs: p.runs, style: p.namedStyle, bulleted: p.bulleted });
      }
      return { title: tab.title, content };
    }),
  };
}
