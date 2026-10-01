/**
 * Таблицы документа (уровень 3, слайс 6c): вставка и удаление таблиц, строк, колонок.
 *
 * Вставки добавляющие (конверт), их откат — обратная операция с охранником «вставленное
 * пусто». Удаления разрушающие: снимок содержимого (прогоны со стилями по ячейке),
 * бюджет ДО подтверждения, подтверждение — названием предмета (D-20). Позиции для
 * откатов считает `table-math.ts` — арифметика согласована с фикстурой и сверяется
 * живым прогоном ДО первой правки живых таблиц.
 */

import { gcError } from '../errors.js';
import { limitOf } from '../policy.js';
import { docPlanId, type DocPlanShape } from './plan.js';
import { pickTab, resolveTable, resolveTableColumn, resolveTableRow } from './selectors.js';
import { sliceParagraphRuns } from './delete-op.js';
import { emptyRowWidth, emptyTableWidth } from './table-math.js';
import type {
  DocParagraph,
  DocRequest,
  DocSnapshot,
  DocTab,
  DocTable,
  DocTextRun,
  DocsClient,
} from './types.js';
import type { DocTableDetail } from '../journal.js';
import {
  assertDocPlanNotApplied,
  clarify,
  commitDocWrite,
  destructiveNote,
  type DocApplyOutcome,
  type DocChangePreview,
  type DocRunOptions,
  type DocWhere,
  namedConfirmRefusal,
  permissionRefusal,
  resolveBodyParagraph,
} from './write-support.js';

export interface DocTableRequest {
  readonly op:
    | 'insertTable'
    | 'insertTableRow'
    | 'insertTableColumn'
    | 'deleteTable'
    | 'deleteTableRow'
    | 'deleteTableColumn';
  readonly tab?: string | undefined;
  /** Какая таблица: номер из карты или якорь по содержимому ячейки. */
  readonly table?: number | undefined;
  readonly tableWithCell?: string | undefined;
  /** `insertTable`: размер и абзац-якорь (без него — конец таба). */
  readonly rows?: number | undefined;
  readonly columns?: number | undefined;
  readonly where?: DocWhere | undefined;
  /** Строка: якорь по ячейке или 1-based номер; вставка — ниже якоря по умолчанию. */
  readonly rowWithCell?: string | undefined;
  readonly rowIndex?: number | undefined;
  readonly below?: boolean | undefined;
  /** Колонка: заголовок из первой строки или 1-based номер; вставка — правее. */
  readonly columnTitle?: string | undefined;
  readonly columnIndex?: number | undefined;
  readonly right?: boolean | undefined;
}

/** Прогоны ячейки (r, c) со стилями — снимок для отката. */
function cellRuns(tab: DocTab, table: DocTable, r: number, c: number): DocTextRun[] {
  const range = table.cellRanges[r]?.[c];
  if (range === undefined) return [];
  const runs: DocTextRun[] = [];
  for (const paragraph of tab.paragraphs) {
    if (
      paragraph.inTable?.table === table.index &&
      paragraph.startIndex >= range.startIndex &&
      paragraph.endIndex <= range.endIndex
    ) {
      if (runs.length > 0) runs.push({ text: '\n' });
      runs.push(...sliceParagraphRuns(paragraph, paragraph.startIndex, paragraph.endIndex - 1));
    }
  }
  return runs;
}

const cellsText = (cells: readonly (readonly DocTextRun[])[]): string =>
  cells.map((runs) => runs.map((r) => r.text).join('')).join(' | ');

interface TablePlan {
  readonly subject: string;
  readonly preview: DocChangePreview;
  readonly requests: Parameters<typeof commitDocWrite>[2]['requests'];
  readonly detail: DocTableDetail;
  readonly destructive: boolean;
  /** Юниты, которые правка добавляет или уничтожает, — мера конверта и бюджета. */
  readonly units: number;
  readonly planChange: { startIndex: number; endIndex: number };
}

/** План табличной правки: запросы, снимок, предмет для подтверждения. */
function planTable(
  tab: DocTab,
  request: DocTableRequest,
): TablePlan | { outcome: DocApplyOutcome } {
  if (request.op === 'insertTable') return planInsertTable(tab, request);
  const tableHit = resolveTable(tab, tableSelector(request));
  if (tableHit.status === 'question') return { outcome: clarify([tableHit.question]) };
  const table = tableHit.value;
  switch (request.op) {
    case 'insertTableRow':
    case 'insertTableColumn':
      return planInsertLine(tab, table, request);
    case 'deleteTableRow':
      return planDeleteRow(tab, table, request);
    case 'deleteTableColumn':
      return planDeleteColumn(tab, table, request);
    case 'deleteTable':
      return planDeleteTable(tab, table);
  }
}

const tableSelector = (request: DocTableRequest): Parameters<typeof resolveTable>[1] =>
  request.tableWithCell !== undefined
    ? { tableWithCell: request.tableWithCell }
    : { table: request.table ?? 1 };

function planInsertTable(
  tab: DocTab,
  request: DocTableRequest,
): TablePlan | { outcome: DocApplyOutcome } {
  const rows = request.rows ?? 0;
  const columns = request.columns ?? 0;
  if (rows < 1 || columns < 1) {
    throw gcError('bad_request', { detail: 'insertTable требует rows и columns (от 1).' });
  }
  const anchor = insertAnchor(tab, request.where);
  if ('outcome' in anchor) return anchor;
  const tableStart = anchor.paragraph.endIndex;
  const width = emptyTableWidth(rows, columns);
  // Документ вырастет на таблицу и на `\n`, который Google ставит перед ней (живьём).
  const units = width + 1;
  return {
    subject: `таблицу ${rows}×${columns}`,
    preview: {
      kind: 'insertTable',
      tab: tab.title,
      anchor: `после абзаца № ${anchor.paragraph.index}`,
      before: null,
      after: `пустая таблица ${rows}×${columns}`,
    },
    requests: [
      { kind: 'insertTable', tabId: tab.tabId, at: anchor.paragraph.endIndex - 1, rows, columns },
    ],
    detail: { kind: 'insertTable', tableStart, rows, columns },
    destructive: false,
    units,
    planChange: { startIndex: tableStart, endIndex: tableStart + width },
  };
}

function insertAnchor(
  tab: DocTab,
  where: DocWhere | undefined,
): { paragraph: DocParagraph } | { outcome: DocApplyOutcome } {
  if (where === undefined) {
    const body = tab.paragraphs.filter((p) => p.inTable === undefined);
    const last = body[body.length - 1];
    if (last === undefined) {
      throw gcError('bad_request', {
        detail: `В табе «${tab.title}» нет абзацев — вставлять не к чему.`,
      });
    }
    return { paragraph: last };
  }
  return resolveBodyParagraph(tab, where, 'якорь вставки таблицы — абзац тела.');
}

/** Словарь осей: тексты и построители различаются, форма одна. */
const AXIS = {
  insertTableRow: { noun: 'строка', acc: 'строку', gen: 'строки', fwd: 'ниже', back: 'выше' },
  insertTableColumn: {
    noun: 'колонка',
    acc: 'колонку',
    gen: 'колонки',
    fwd: 'правее',
    back: 'левее',
  },
} as const;

function insertLineRequest(
  isRow: boolean,
  tabId: string,
  tableStart: number,
  index: number,
  forward: boolean,
): DocRequest {
  return isRow
    ? { kind: 'insertTableRow', tabId, tableStart, rowIndex: index, below: forward }
    : { kind: 'insertTableColumn', tabId, tableStart, columnIndex: index, right: forward };
}

function insertLineDetail(isRow: boolean, tableStart: number, newIndex: number): DocTableDetail {
  return isRow
    ? { kind: 'insertRow', tableStart, rowIndex: newIndex }
    : { kind: 'insertColumn', tableStart, columnIndex: newIndex };
}

/** Вставка строки или колонки — одна форма, оси различаются словарём. */
function planInsertLine(
  tab: DocTab,
  table: DocTable,
  request: DocTableRequest,
): TablePlan | { outcome: DocApplyOutcome } {
  const isRow = request.op === 'insertTableRow';
  const axis = AXIS[isRow ? 'insertTableRow' : 'insertTableColumn'];
  const anchor = isRow ? resolveTableRow(table, request) : resolveTableColumn(table, request);
  if (anchor.status === 'question') return { outcome: clarify([anchor.question]) };
  const forward = (isRow ? request.below : request.right) ?? true;
  const newIndex = anchor.value + (forward ? 1 : 0);
  return {
    subject: `${axis.acc} в таблицу № ${table.index}`,
    preview: {
      kind: request.op,
      tab: tab.title,
      anchor: `таблица № ${table.index}, ${forward ? axis.fwd : axis.back} ${axis.gen} № ${anchor.value + 1}`,
      before: null,
      after: `пустая ${axis.noun} на месте № ${newIndex + 1}`,
    },
    requests: [insertLineRequest(isRow, tab.tabId, table.startIndex, anchor.value, forward)],
    detail: insertLineDetail(isRow, table.startIndex, newIndex),
    destructive: false,
    units: isRow ? emptyRowWidth(table.columns) : table.rows * 2,
    planChange: { startIndex: table.startIndex, endIndex: table.startIndex + newIndex },
  };
}

function planDeleteRow(
  tab: DocTab,
  table: DocTable,
  request: DocTableRequest,
): TablePlan | { outcome: DocApplyOutcome } {
  const anchor = resolveTableRow(table, request);
  if (anchor.status === 'question') return { outcome: clarify([anchor.question]) };
  const r = anchor.value;
  const range = table.rowRanges[r]!;
  const cells = table.cells[r]!.map((_, c) => cellRuns(tab, table, r, c));
  return {
    subject: `строку ${
      table.cells[r]!.filter((x) => x !== '')
        .slice(0, 3)
        .join(' ') || `№ ${r + 1}`
    }`,
    preview: {
      kind: 'deleteTableRow',
      tab: tab.title,
      anchor: `таблица № ${table.index}, строка № ${r + 1}`,
      before: cellsText(cells),
      after: null,
    },
    requests: [
      { kind: 'deleteTableRow', tabId: tab.tabId, tableStart: table.startIndex, rowIndex: r },
    ],
    detail: { kind: 'deleteRow', tableStart: table.startIndex, rowIndex: r, cells },
    destructive: true,
    units: range.endIndex - range.startIndex,
    planChange: { startIndex: range.startIndex, endIndex: range.endIndex },
  };
}

function planDeleteColumn(
  tab: DocTab,
  table: DocTable,
  request: DocTableRequest,
): TablePlan | { outcome: DocApplyOutcome } {
  const anchor = resolveTableColumn(table, request);
  if (anchor.status === 'question') return { outcome: clarify([anchor.question]) };
  const c = anchor.value;
  const cells = table.cells.map((_, r) => cellRuns(tab, table, r, c));
  const units = table.cellRanges.reduce(
    (sum, row) => sum + (row[c]!.endIndex - row[c]!.startIndex),
    0,
  );
  return {
    subject: `колонку ${table.cells[0]?.[c] ?? `№ ${c + 1}`}`,
    preview: {
      kind: 'deleteTableColumn',
      tab: tab.title,
      anchor: `таблица № ${table.index}, колонка № ${c + 1}`,
      before: cellsText(cells),
      after: null,
    },
    requests: [
      { kind: 'deleteTableColumn', tabId: tab.tabId, tableStart: table.startIndex, columnIndex: c },
    ],
    detail: { kind: 'deleteColumn', tableStart: table.startIndex, columnIndex: c, cells },
    destructive: true,
    units,
    planChange: { startIndex: table.startIndex, endIndex: table.startIndex + units },
  };
}

function planDeleteTable(tab: DocTab, table: DocTable): TablePlan {
  const grid = table.cells.map((row, r) => row.map((_, c) => cellRuns(tab, table, r, c)));
  return {
    subject: `таблицу ${table.cells[0]?.join(' ') ?? `№ ${table.index}`}`,
    preview: {
      kind: 'deleteTable',
      tab: tab.title,
      anchor: `таблица № ${table.index} (${table.rows}×${table.columns})`,
      before: table.cells.map((row) => row.join(' | ')).join('\n'),
      after: null,
    },
    requests: [
      {
        kind: 'deleteRange',
        tabId: tab.tabId,
        startIndex: table.startIndex,
        endIndex: table.endIndex,
      },
    ],
    detail: {
      kind: 'deleteTable',
      tableStart: table.startIndex,
      rows: table.rows,
      columns: table.columns,
      grid,
    },
    destructive: true,
    units: table.endIndex - table.startIndex,
    planChange: { startIndex: table.startIndex, endIndex: table.endIndex },
  };
}

export async function runDocTable(
  client: DocsClient,
  snapshot: DocSnapshot,
  request: DocTableRequest,
  options: DocRunOptions,
): Promise<DocApplyOutcome> {
  const tab = pickTab(snapshot, request.tab);
  const planned = planTable(tab, request);
  if ('outcome' in planned) return planned.outcome;

  assertTableBudget(planned);
  const plan: DocPlanShape = {
    targetId: snapshot.docId,
    op: request.op,
    revisionId: snapshot.revisionId,
    changes: [
      {
        kind: request.op,
        tab: tab.title,
        startIndex: planned.planChange.startIndex,
        endIndex: planned.planChange.endIndex,
        anchor: planned.preview.anchor,
        ...(planned.preview.before === null ? {} : { before: planned.preview.before }),
        ...(planned.preview.after === null ? {} : { after: planned.preview.after }),
      },
    ],
  };
  const code = docPlanId(plan);
  const changes = [planned.preview];
  const notes = [
    planned.destructive
      ? `Исчезнет ${planned.units} юнитов содержимого. Откат вернёт структуру и текст со стилями.`
      : `Добавится пустая структура (${planned.units} юнитов); откат удалит её, только пока она пуста.`,
  ];

  if (options.dryRun !== false) {
    return {
      status: 'preview',
      planId: code,
      changes,
      notes: [
        ...notes,
        planned.destructive
          ? destructiveNote(`удаляю ${planned.subject}`, code)
          : `Запись — по коду плана или конвертом.`,
      ],
      questions: [],
    };
  }
  await assertDocPlanNotApplied(options, code, snapshot.docId);
  const refusal = tableRefusal(options, request, planned, code, changes, notes);
  if (refusal !== null) return refusal;

  return commitDocWrite(
    client,
    snapshot,
    {
      op: request.op,
      tabTitle: tab.title,
      code,
      changes,
      notes,
      requests: planned.requests,
      doc: {
        tab: tab.title,
        startIndex: planned.detail.tableStart,
        endIndex: planned.detail.tableStart,
        table: planned.detail,
      },
    },
    options,
  );
}

/** Бюджет снимка — только у разрушающих, и ДО подтверждения (L11). */
function assertTableBudget(planned: TablePlan): void {
  if (!planned.destructive) return;
  const budget = limitOf('write.snapshot-max-chars', 20000);
  if (planned.units <= budget) return;
  throw gcError('policy_denied', {
    detail:
      `Снимок для отката не построить: содержимое занимает ${planned.units} юнитов, ` +
      `бюджет ${budget} (правило write.snapshot-max-chars). Правка не выполнена.`,
    cause: 'write.snapshot-max-chars',
  });
}

function tableRefusal(
  options: DocRunOptions,
  request: DocTableRequest,
  planned: TablePlan,
  code: string,
  changes: readonly DocChangePreview[],
  notes: readonly string[],
): DocApplyOutcome | null {
  const preview = { code, changes, notes };
  return planned.destructive
    ? namedConfirmRefusal(options, `удаляю ${planned.subject}`, preview)
    : permissionRefusal(options, request.op, planned.units, preview);
}
