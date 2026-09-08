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
      else this.deleteRange(request);
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

  private deleteRange(request: Extract<DocRequest, { kind: 'deleteRange' }>): void {
    const { tab, blocks } = this.located(request.tabId);
    const { startIndex: s, endIndex: e } = request;
    const touched = blocks.filter((b) => s < b.end && e > b.start);
    if (touched.length === 0) {
      throw gcError('bad_request', { detail: `Диапазон [${s}, ${e}) вне тела таба.` });
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
