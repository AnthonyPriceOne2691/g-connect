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
import { addSheet, insertColumns, insertRows, renameSheet } from '../core/sheets/structure-op.js';
import type { parseOperation } from '../core/ops.js';
import type { SheetData, SheetsClient } from '../core/sheets/types.js';

/** Разводка по операциям. Вынесено: в обработчике это была четвёртая ветка подряд. */
export async function runOperation(
  client: SheetsClient,
  data: SheetData,
  operation: ReturnType<typeof parseOperation>,
  options: Parameters<typeof appendRow>[3],
): Promise<ApplyOutcome> {
  if (operation.op === 'appendRow') return appendRow(client, data, operation.values, options);
  if (operation.op === 'upsertRow') {
    return upsertRow(client, data, operation.key, operation.values, options);
  }
  if (operation.op === 'findReplace') {
    return findReplace(
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
    );
  }
  if (operation.op === 'insertRows') {
    return insertRows(client, data, operation.where, operation.count, {
      ...options,
      below: operation.below,
    });
  }
  if (operation.op === 'insertColumns') {
    return insertColumns(client, data, operation.column, operation.count, {
      ...options,
      below: operation.below,
    });
  }
  if (operation.op === 'addSheet') {
    return addSheet(client, data, operation.title, options);
  }
  if (operation.op === 'renameSheet') {
    return renameSheet(client, data, operation.title, options);
  }
  if (operation.op === 'formatCells') {
    return formatCells(client, data, operation.where, operation.columns, operation.format, {
      ...options,
      includeHeader: operation.includeHeader,
    });
  }
  return setCells(client, data, operation.where, operation.values, options);
}
