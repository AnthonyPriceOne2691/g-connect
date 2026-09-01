/**
 * Откат последней записи (DESIGN.md §10).
 *
 * В Sheets API нет undo: `batchUpdate` необратим, а история версий Google откатывает
 * документ целиком к точке во времени, а не последнее действие. Поэтому откат — это
 * ОБРАТНАЯ ЗАПИСЬ по снимку «до», который журнал сохранил вместе с изменением.
 *
 * Границы названы честно: это не транзакция. Если между записью и откатом документ правил
 * человек, слепой откат перетрёт его правки — поэтому сверяется ревизия, и при расхождении
 * откат не выполняется молча.
 */

import { gcError, newCorrelationId } from './errors.js';
import { lastUndoable, type JournalSink, type JournalSource, type WriteRecord } from './journal.js';
import type { SheetsClient } from './sheets/types.js';

export interface UndoOptions {
  readonly account?: string;
  /** Сколько последних записей откатить. Больше одной — редкий случай, но он законен. */
  readonly last?: number;
  /** Ревизия таблицы сейчас: если не совпала с той, что была после записи, откат опасен. */
  readonly currentRevision?: string | null;
  /** Откатить, даже если документ правили после записи. Только по явному решению человека. */
  readonly force?: boolean;
  readonly journal?: JournalSink;
}

export interface UndoOutcome {
  readonly status: 'ok' | 'nothing_to_undo';
  /** Что вернули: те же ячейки, но значения из снимка «до». */
  readonly restored: readonly {
    a1: string;
    column: string;
    value: string | number | boolean | null;
  }[];
  readonly undoneCorrelationId: string | null;
  readonly at: string | null;
}

/**
 * Ревизия после записи и ревизия сейчас должны совпадать. Расхождение значит, что
 * документ трогали после нас — и тогда решение принимает человек, а не ядро.
 */
function assertSafeToUndo(record: WriteRecord, options: UndoOptions): void {
  if (options.force === true) return;
  const then = record.revisionAfter;
  const now = options.currentRevision;
  if (then === null || now === null || now === undefined) return;
  if (then === now) return;
  throw gcError('revision_conflict', {
    detail:
      `После этой записи таблицу правили (ревизия была ${then}, стала ${now}). ` +
      'Откат перетрёт чужие правки, поэтому не выполнен: перечитай документ и реши, что вернуть.',
    cause: 'revision_moved_after_write',
  });
}

export async function undoLast(
  client: SheetsClient,
  targetId: string,
  source: JournalSource,
  options: UndoOptions = {},
): Promise<UndoOutcome> {
  const depth = Math.max(1, options.last ?? 1);
  const history = await source.recent(targetId, Math.max(50, depth * 10));
  const record = lastUndoable(history);

  if (record === null) {
    return { status: 'nothing_to_undo', restored: [], undoneCorrelationId: null, at: null };
  }
  assertSafeToUndo(record, options);

  const restored: { a1: string; column: string; value: string | number | boolean | null }[] = [];
  // В обратном порядке: если одна операция трогала ячейку дважды, вернуть надо
  // самое раннее состояние, а не промежуточное.
  for (const change of [...record.changes].reverse()) {
    await client.updateValues(targetId, change.a1, [[change.before]]);
    restored.push({ a1: change.a1, column: change.column, value: change.before });
  }

  const at = new Date().toISOString();
  await options.journal?.({
    at,
    account: record.account,
    targetId,
    alias: record.alias,
    sheet: record.sheet,
    op: 'undo',
    changes: record.changes.map((c) => ({
      a1: c.a1,
      column: c.column,
      before: c.after,
      after: c.before,
    })),
    revisionBefore: options.currentRevision ?? null,
    revisionAfter: null,
    correlationId: newCorrelationId(),
    undoOf: record.correlationId,
  });

  return { status: 'ok', restored, undoneCorrelationId: record.correlationId, at: record.at };
}
