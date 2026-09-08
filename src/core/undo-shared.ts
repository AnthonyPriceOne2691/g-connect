/**
 * Общее у откатов таблиц и документов: причины «нечего откатывать» и предел свежести.
 * Модуль-низ, как `undo-types.ts`: общий код уходит вниз, а не разворачивает слой
 * импортом обратно (§2.3).
 */

import { gcError } from './errors.js';
import { limitOf } from './policy.js';
import { lastUndoable, type JournalSource, type WriteRecord } from './journal.js';
import type { NothingToUndoReason, UndoOptions, UndoOutcome } from './undo-types.js';

export function reasonFor(
  history: readonly WriteRecord[],
  options: UndoOptions,
): NothingToUndoReason {
  if (options.correlationId !== undefined) return 'id_not_found';
  return history.length === 0 ? 'journal_empty' : 'all_undone';
}

export function nothingToUndo(
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

/**
 * Откат не уходит в историю молча.
 *
 * Замерено на живой таблице: два «откати» подряд вернули не только свою правку, но и
 * запись ЧУЖОЙ сессии сорокаминутной давности — формально «последняя неоткаченная», по
 * сути потеря чужой работы. «Последняя» должна означать «только что», иначе человек
 * теряет то, о чём не думал. Старую запись откатить можно, но назвав её id явно.
 */
export function assertRecent(record: WriteRecord, options: UndoOptions): void {
  if (options.force === true || options.correlationId !== undefined) return;
  const maxMinutes = limitOf('undo.recency-minutes', 60);
  const ageMinutes = (Date.now() - new Date(record.at).getTime()) / 60_000;
  if (ageMinutes <= maxMinutes) return;
  const touched = record.changes.map((c) => c.a1).join(', ');
  throw gcError('undo_too_old', {
    detail:
      `Последняя неоткаченная запись сделана ${new Date(record.at).toLocaleString('ru-RU')} ` +
      `(${Math.round(ageMinutes)} мин назад)${touched === '' ? '' : ` и меняла ${touched}`}` +
      `${record.structure === undefined ? '' : ` (правка геометрии: ${record.structure.kind})`}. ` +
      'Откат без уточнения работает только на свежих записях. Нужна именно эта — передай ' +
      `её id в поле record: ${record.correlationId}.`,
    cause: 'undo_target_too_old',
  });
}

/**
 * Что откатывать: последняя неоткаченная запись или конкретная по id. `UndoOutcome`
 * вместо записи — честный «нечего откатывать» с причиной, различающей три случая.
 */
export async function pickUndoRecord(
  source: JournalSource,
  targetId: string,
  options: UndoOptions,
): Promise<WriteRecord | UndoOutcome> {
  const depth = Math.max(1, options.last ?? 1);
  const history = await source.recent(targetId, Math.max(50, depth * 10));
  const record =
    options.correlationId === undefined
      ? lastUndoable(history)
      : (history.find((r) => r.correlationId === options.correlationId) ?? null);
  if (record === null) {
    return nothingToUndo(reasonFor(history, options), history.length, options.correlationId);
  }
  return record;
}

/** Запись это или уже готовый отказ. */
export const isUndoOutcome = (value: WriteRecord | UndoOutcome): value is UndoOutcome =>
  'status' in value;
