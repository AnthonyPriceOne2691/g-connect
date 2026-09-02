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
import { limitOf } from './policy.js';
import { lastUndoable, type JournalSink, type JournalSource, type WriteRecord } from './journal.js';
import { parseA1, sameCell, valueAt } from './sheets/a1.js';
import type { SheetsClient } from './sheets/types.js';

export interface UndoOptions {
  readonly account?: string;
  /** Откатить КОНКРЕТНУЮ запись по её id — способ дотянуться до старой осознанно. */
  readonly correlationId?: string;
  /** Сколько последних записей откатить. Больше одной — редкий случай, но он законен. */
  readonly last?: number;
  /** Ревизия сейчас — только для записи в журнал; решение об откате принимается по ячейкам. */
  readonly currentRevision?: string | null;
  /** Откатить, даже если наши ячейки изменили. Только по явному решению человека. */
  readonly force?: boolean;
  readonly journal?: JournalSink;
}

/**
 * Почему откатывать нечего. Три разных состояния раньше выглядели снаружи одинаково,
 * и модель дописывала причину сама: в живом прогоне B13 она сказала «журнал пуст»,
 * когда в журнале лежали четыре строки, просто все записи были уже откачены.
 */
export type NothingToUndoReason = 'journal_empty' | 'all_undone' | 'id_not_found';

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
  /** Заполнено только при `nothing_to_undo`. */
  readonly reason?: NothingToUndoReason;
  /** Причина человеческим текстом — её показывают, а не ветвят. */
  readonly detail?: string;
}

function reasonFor(history: readonly WriteRecord[], options: UndoOptions): NothingToUndoReason {
  if (options.correlationId !== undefined) return 'id_not_found';
  return history.length === 0 ? 'journal_empty' : 'all_undone';
}

function nothingToUndo(
  reason: NothingToUndoReason,
  seen: number,
  correlationId: string | undefined,
): UndoOutcome {
  const detail =
    reason === 'journal_empty'
      ? 'По этой цели журнала нет: ни одной записи через ядро не проходило.'
      : reason === 'all_undone'
        ? `В журнале по этой цели записей: ${seen}, и все уже откачены — возвращать нечего.`
        : `Записи с id ${correlationId ?? '—'} среди последних ${seen} по этой цели нет.`;
  return {
    status: 'nothing_to_undo',
    restored: [],
    undoneCorrelationId: null,
    at: null,
    reason,
    detail,
  };
}

export { parseA1 };

const same = sameCell;

/**
 * Безопасен ли откат. Сверяем НАШИ ячейки, а не версию файла.
 *
 * Почему не версия: `version` Drive растёт и от нашей же записи (замерено: 16 → 17 → 18
 * за один цикл), поэтому равенство версий почти никогда не выполнялось, и откат
 * отказывал всегда — гейт, который срабатывает на всём, бесполезен так же, как гейт,
 * который не срабатывает никогда. Содержательный вопрос другой: изменил ли кто-то то,
 * что мы записали. На него и отвечаем.
 */
async function assertSafeToUndo(
  client: SheetsClient,
  targetId: string,
  record: WriteRecord,
  options: UndoOptions,
): Promise<void> {
  if (options.force === true) return;
  const snapshot = await client.getSpreadsheet(targetId, { sheet: record.sheet });
  for (const change of record.changes) {
    const current = valueAt(snapshot, change.a1);
    if (same(current, change.after)) continue;
    throw gcError('revision_conflict', {
      detail:
        `Ячейку ${change.a1} (${change.column}) после записи изменили: мы записали ` +
        `«${String(change.after ?? '')}», сейчас там «${String(current ?? '')}». Откат перетёр бы ` +
        'чужую правку, поэтому не выполнен: перечитай документ и реши, что вернуть.',
      cause: 'cell_changed_after_write',
    });
  }
}

/**
 * Откат не уходит в историю молча.
 *
 * Замерено на живой таблице: два «откати» подряд вернули не только свою правку, но и
 * запись ЧУЖОЙ сессии сорокаминутной давности — формально «последняя неоткаченная», по
 * сути потеря чужой работы. «Последняя» должна означать «только что», иначе человек
 * теряет то, о чём не думал. Старую запись откатить можно, но назвав её id явно.
 */
function assertRecent(record: WriteRecord, options: UndoOptions): void {
  if (options.force === true || options.correlationId !== undefined) return;
  const maxMinutes = limitOf('undo.recency-minutes', 60);
  const ageMinutes = (Date.now() - new Date(record.at).getTime()) / 60_000;
  if (ageMinutes <= maxMinutes) return;
  throw gcError('revision_conflict', {
    detail:
      `Последняя неоткаченная запись сделана ${new Date(record.at).toLocaleString('ru-RU')} ` +
      `(${Math.round(ageMinutes)} мин назад) и меняла ${record.changes.map((c) => c.a1).join(', ')}. ` +
      'Откат без уточнения работает только на свежих записях: если нужна именно эта, ' +
      `назови её id — ${record.correlationId}.`,
    cause: 'undo_target_too_old',
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
  const record =
    options.correlationId === undefined
      ? lastUndoable(history)
      : (history.find((r) => r.correlationId === options.correlationId) ?? null);

  if (record === null) {
    return nothingToUndo(reasonFor(history, options), history.length, options.correlationId);
  }
  assertRecent(record, options);
  await assertSafeToUndo(client, targetId, record, options);

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
    // Код плана откаченной записи: по нему видно, ЧТО именно вернули, и по нему же
    // проверка однократности снова разрешает эту правку (B20, B21).
    ...(record.planId === undefined ? {} : { planId: record.planId }),
  });

  return { status: 'ok', restored, undoneCorrelationId: record.correlationId, at: record.at };
}
