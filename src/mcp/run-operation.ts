/**
 * Какая операция ядра отвечает на какую операцию схемы.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: определения инструментов
 * отвечают на «что умеет сервер», а этот файл на «кто исполняет запрошенное». Со
 * структурными операциями (2.5b) разводка стала девятиветочной, и держать её рядом со
 * схемами инструментов значило бы смешивать два разных вопроса.
 */

import { appendRow, upsertRow, type ApplyOutcome } from '../core/sheets/rows.js';
import { findReplace } from '../core/sheets/find-replace-op.js';
import { formatCells } from '../core/sheets/format-op.js';
import { setCells } from '../core/sheets/set-cells-op.js';
import { autoFill, copyRange, cutRange, duplicateSheet } from '../core/sheets/range-op.js';
import {
  addSheet,
  deleteColumns,
  deleteRows,
  deleteSheet,
  insertColumns,
  insertRows,
  renameSheet,
} from '../core/sheets/structure-op.js';
import { moveRows, sortRange } from '../core/sheets/order-op.js';
import type { parseOperation } from '../core/ops.js';
import type { SheetData, SheetsClient } from '../core/sheets/types.js';

/** Разводка по операциям. Вынесено: в обработчике это была четвёртая ветка подряд. */
/**
 * Операции НАД ТАБЛИЦЕЙ. Создание файлов Drive сюда не входит: у него нет ни листа, ни
 * карты, и разводится он раньше — в обработчике `gc_apply`, до чтения таблицы.
 */
type Operation = Exclude<
  ReturnType<typeof parseOperation>,
  { op: 'createSheet' | 'createDoc' | 'createFolder' | 'appendText' | 'insertText' }
>;
type Options = Parameters<typeof upsertRow>[4];

/**
 * Таблица вместо девяти ветвей подряд: гейт сложности отклонил цепочку `if`, и он прав —
 * разводка это соответствие, а не логика. Каждый обработчик берёт из операции ровно те
 * поля, которые ему нужны; типизация сужается по `op`, поэтому лишнего поля не взять.
 */
const HANDLERS: {
  [K in Operation['op']]: (
    client: SheetsClient,
    data: SheetData,
    operation: Extract<Operation, { op: K }>,
    options: Options,
  ) => Promise<ApplyOutcome>;
} = {
  appendRow: (client, data, operation, options) =>
    appendRow(client, data, operation.values, options),
  upsertRow: (client, data, operation, options) =>
    upsertRow(client, data, operation.key, operation.values, options),
  setCells: (client, data, operation, options) =>
    setCells(client, data, operation.where, operation.values, options),
  formatCells: (client, data, operation, options) =>
    formatCells(client, data, operation.where, operation.columns, operation.format, {
      ...options,
      includeHeader: operation.includeHeader,
    }),
  findReplace: (client, data, operation, options) =>
    findReplace(
      client,
      data,
      {
        find: operation.find,
        replace: operation.replace,
        ...(operation.columns === undefined ? {} : { columns: operation.columns }),
        matchCase: operation.matchCase,
        matchEntireCell: operation.matchEntireCell,
        searchByRegex: operation.searchByRegex,
      },
      options,
    ),
  insertRows: (client, data, operation, options) =>
    insertRows(client, data, operation.where, operation.count, {
      ...options,
      below: operation.below,
    }),
  insertColumns: (client, data, operation, options) =>
    insertColumns(client, data, operation.column, operation.count, {
      ...options,
      below: operation.below,
    }),
  deleteRows: (client, data, operation, options) =>
    deleteRows(client, data, operation.where, options),
  deleteColumns: (client, data, operation, options) =>
    deleteColumns(client, data, operation.column, options),
  deleteSheet: (client, data, _operation, options) => deleteSheet(client, data, options),
  addSheet: (client, data, operation, options) => addSheet(client, data, operation.title, options),
  renameSheet: (client, data, operation, options) =>
    renameSheet(client, data, operation.title, options),
  copyRange: (client, data, operation, options) =>
    copyRange(
      client,
      data,
      { column: operation.column, toColumn: operation.toColumn, paste: operation.paste },
      options,
    ),
  cutRange: (client, data, operation, options) =>
    cutRange(
      client,
      data,
      { column: operation.column, toColumn: operation.toColumn, paste: operation.paste },
      options,
    ),
  moveRows: (client, data, operation, options) =>
    moveRows(client, data, operation.where, operation.before, options),
  sortRange: (client, data, operation, options) =>
    sortRange(client, data, operation.column, { ...options, descending: operation.descending }),
  autoFill: (client, data, operation, options) => autoFill(client, data, operation.column, options),
  duplicateSheet: (client, data, operation, options) =>
    duplicateSheet(client, data, operation.title, options),
};

export function runOperation(
  client: SheetsClient,
  data: SheetData,
  operation: Operation,
  options: Options,
): Promise<ApplyOutcome> {
  // Приведение здесь одно и названо: сузить `Operation` до `Extract<…, {op: K}>` внутри
  // индексации TypeScript не умеет, а таблица гарантирует, что ключ и обработчик совпали.
  const handler = HANDLERS[operation.op] as (
    c: SheetsClient,
    d: SheetData,
    o: Operation,
    p: Options,
  ) => Promise<ApplyOutcome>;
  return handler(client, data, operation, options);
}
