/**
 * Откат табличных правок документа (уровень 3, слайс 6c) — вынесен из `undo-docs.ts`
 * по гейту длины, и по делу: структура таблиц — свой словарь (строки, колонки, сетки),
 * а контур отката (предусловие, хвост, журнал) остаётся в `undo-docs.ts`.
 */

import { gcError } from './errors.js';
import type { WriteRecord } from './journal.js';
import { exactStyleRequests } from './docs/style-restore.js';
import {
  emptyTableWidth,
  newColumnCellInsertionPoints,
  newRowCellInsertionPoints,
  newTableCellInsertionPoints,
} from './docs/table-math.js';
import type { DocRequest, DocSnapshot, DocTab, DocTextRun } from './docs/types.js';

/** Таб и таблица записи — или честный отказ, если их сдвинули/удалили. */
function tableOf(
  snapshot: DocSnapshot,
  tabTitle: string,
  tableStart: number,
): { tab: DocTab; table: NonNullable<DocTab['tables'][number]> } {
  const tab = snapshot.tabs.find((t) => t.title === tabTitle);
  const table = tab?.tables.find((t) => t.startIndex === tableStart);
  if (tab === undefined || table === undefined) {
    throw gcError('revision_conflict', {
      detail:
        `Таблица записи (таб «${tabTitle}», позиция ${tableStart}) не найдена — документ ` +
        'изменился, и откат не знает, что возвращать. Перечитай документ.',
    });
  }
  return { tab, table };
}

/**
 * Тексты в вычисленные точки — с конца, чтобы сдвиги не портили адреса. Стиль — у
 * КАЖДОГО прогона и точный: живьём (2026-10-01, LR3-2) новая строка или колонка копирует
 * стиль ячейки-образца, и без сброса обычный текст под жирной шапкой вернулся жирным.
 */
function fillCells(
  tabId: string,
  points: readonly number[],
  cells: readonly (readonly DocTextRun[])[],
): DocRequest[] {
  const requests: DocRequest[] = [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const runs = cells[i] ?? [];
    const text = runs.map((r) => r.text).join('');
    if (text === '') continue;
    requests.push({ kind: 'insertText', tabId, at: points[i]!, text });
    requests.push(...exactStyleRequests(tabId, points[i]!, runs));
  }
  return requests;
}

/** Запросы отката по виду табличной правки — разводка, логика в per-kind функциях. */
export function tableUndoRequests(
  snapshot: DocSnapshot,
  tabTitle: string,
  detail: NonNullable<WriteRecord['doc']>['table'] & object,
): { requests: DocRequest[]; undone: string } {
  switch (detail.kind) {
    case 'insertTable':
      return undoInsertTable(snapshot, tabTitle, detail);
    case 'insertRow':
    case 'insertColumn':
      return undoInsertLine(snapshot, tabTitle, detail);
    case 'deleteRow':
    case 'deleteColumn':
      return undoDeleteLine(snapshot, tabTitle, detail);
    case 'deleteTable':
      return undoDeleteTable(snapshot, tabTitle, detail);
  }
}

type TableDetail = NonNullable<WriteRecord['doc']>['table'] & object;
type UndoPlan = { requests: DocRequest[]; undone: string };

function undoInsertTable(snapshot: DocSnapshot, tabTitle: string, detail: TableDetail): UndoPlan {
  const { tab, table } = tableOf(snapshot, tabTitle, detail.tableStart);
  assertTableEmpty(table, 'вставленная таблица');
  return {
    requests: [
      {
        kind: 'deleteRange',
        tabId: tab.tabId,
        startIndex: table.startIndex,
        endIndex: table.endIndex,
      },
      // Перед таблицей Google ставил `\n` (живьём 2026-10-01): без него абзац-якорь
      // снова один, а не «якорь + пустой хвост».
      {
        kind: 'deleteRange',
        tabId: tab.tabId,
        startIndex: table.startIndex - 1,
        endIndex: table.startIndex,
      },
    ],
    undone: `Вставленная пустая таблица ${table.rows}×${table.columns} удалена.`,
  };
}

function undoInsertLine(snapshot: DocSnapshot, tabTitle: string, detail: TableDetail): UndoPlan {
  const { tab, table } = tableOf(snapshot, tabTitle, detail.tableStart);
  const isRow = detail.kind === 'insertRow';
  const line = isRow
    ? (table.cells[detail.rowIndex!] ?? [])
    : table.cells.map((row) => row[detail.columnIndex!] ?? '');
  if (line.some((cell) => cell !== '')) {
    throw gcError('revision_conflict', {
      detail:
        `Вставленная ${isRow ? 'строка' : 'колонка'} уже не пуста — откат уничтожил бы ` +
        'написанное туда. Осознанный откат — с force недоступен: удали содержимое явно.',
      cause: 'inserted_not_empty',
    });
  }
  return {
    requests: [
      isRow
        ? {
            kind: 'deleteTableRow',
            tabId: tab.tabId,
            tableStart: table.startIndex,
            rowIndex: detail.rowIndex!,
          }
        : {
            kind: 'deleteTableColumn',
            tabId: tab.tabId,
            tableStart: table.startIndex,
            columnIndex: detail.columnIndex!,
          },
    ],
    undone: `Вставленная пустая ${isRow ? 'строка' : 'колонка'} удалена.`,
  };
}

function undoDeleteLine(snapshot: DocSnapshot, tabTitle: string, detail: TableDetail): UndoPlan {
  const { tab, table } = tableOf(snapshot, tabTitle, detail.tableStart);
  const isRow = detail.kind === 'deleteRow';
  const cells = detail.cells ?? [];
  const index = isRow ? detail.rowIndex! : detail.columnIndex!;
  const structural: DocRequest = isRow
    ? index < table.rows
      ? {
          kind: 'insertTableRow',
          tabId: tab.tabId,
          tableStart: table.startIndex,
          rowIndex: index,
          below: false,
        }
      : {
          kind: 'insertTableRow',
          tabId: tab.tabId,
          tableStart: table.startIndex,
          rowIndex: table.rows - 1,
          below: true,
        }
    : index < table.columns
      ? {
          kind: 'insertTableColumn',
          tabId: tab.tabId,
          tableStart: table.startIndex,
          columnIndex: index,
          right: false,
        }
      : {
          kind: 'insertTableColumn',
          tabId: tab.tabId,
          tableStart: table.startIndex,
          columnIndex: table.columns - 1,
          right: true,
        };
  const points = isRow
    ? newRowCellInsertionPoints(table, index)
    : newColumnCellInsertionPoints(table, index);
  return {
    requests: [structural, ...fillCells(tab.tabId, points, cells)],
    undone:
      `Удалённая ${isRow ? 'строка' : 'колонка'} вернулась на место № ${index + 1}, ` +
      'содержимое — со стилями.',
  };
}

function undoDeleteTable(snapshot: DocSnapshot, tabTitle: string, detail: TableDetail): UndoPlan {
  const tab = snapshot.tabs.find((t) => t.title === tabTitle);
  if (tab === undefined) {
    throw gcError('revision_conflict', { detail: `Таба «${tabTitle}» больше нет.` });
  }
  const rows = detail.rows!;
  const columns = detail.columns!;
  const grid = detail.grid ?? [];
  const gridPoints = newTableCellInsertionPoints(detail.tableStart, rows, columns);
  const fills: DocRequest[] = [];
  for (let r = rows - 1; r >= 0; r -= 1) {
    fills.push(...fillCells(tab.tabId, gridPoints[r]!, grid[r] ?? []));
  }
  // Вставка в перенос предыдущего абзаца режет его: перед таблицей встаёт новый `\n`,
  // а прежний остаётся ПОСЛЕ неё пустым абзацем (живьём 2026-10-01, LR3-3). Удаляем его:
  // удаление переноса пустого абзаца не трогает следующий — стиль и буллет его (живьём).
  const tableEnd = detail.tableStart + emptyTableWidth(rows, columns);
  return {
    requests: [
      { kind: 'insertTable', tabId: tab.tabId, at: detail.tableStart - 1, rows, columns },
      { kind: 'deleteRange', tabId: tab.tabId, startIndex: tableEnd, endIndex: tableEnd + 1 },
      ...fills,
    ],
    undone: `Удалённая таблица ${rows}×${columns} восстановлена с содержимым и стилями.`,
  };
}

function assertTableEmpty(table: DocTab['tables'][number], what: string): void {
  if (table.cells.every((row) => row.every((cell) => cell === ''))) return;
  throw gcError('revision_conflict', {
    detail: `Откат удалил бы непустое: ${what} уже содержит текст. Удали его явно.`,
    cause: 'inserted_not_empty',
  });
}
