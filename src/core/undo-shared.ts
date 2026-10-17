/**
 * Общее у откатов таблиц и документов: причины «нечего откатывать» и предел свежести.
 * Модуль-низ, как `undo-types.ts`: общий код уходит вниз, а не разворачивает слой
 * импортом обратно (§2.3).
 */

import { gcError } from './errors.js';
import { denyByRule, limitOf } from './policy.js';
import { lastUndoable, type JournalSource, type WriteRecord } from './journal.js';
import type { NothingToUndoReason, UndoOptions, UndoOutcome } from './undo-types.js';

export function reasonFor(
  history: readonly WriteRecord[],
  options: UndoOptions,
): NothingToUndoReason {
  if (options.correlationId !== undefined) return 'id_not_found';
  if (history.length === 0) return 'journal_empty';
  const own = ownRecords(history, options.project).filter((r) => r.op !== 'undo');
  return own.length === 0 ? 'only_other_projects' : 'all_undone';
}

export function nothingToUndo(
  reason: NothingToUndoReason,
  seen: number,
  correlationId: string | undefined,
): UndoOutcome {
  const id = correlationId ?? '—';
  const details: Readonly<Record<NothingToUndoReason, string>> = {
    journal_empty: 'По этой цели журнала нет: ни одной записи через ядро не проходило.',
    all_undone: `В журнале по этой цели записей: ${seen}, и все уже откачены — возвращать нечего.`,
    already_undone:
      `Запись ${id} уже откачена — второй откат вернул бы состояние, которого человек не ` +
      'выбирал. Нужна та же правка снова — сделай её заново.',
    id_not_found: `Записи с id ${id} среди последних ${seen} по этой цели нет.`,
    only_other_projects:
      `В журнале по этой цели записей: ${seen}, но своих у этого проекта нет — записи других ` +
      'проектов откатывают их сессии или владелец из терминала.',
  };
  const detail = details[reason];
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
  // Старую запись снимает ТОЛЬКО явный id — так обещают правила. force раньше обходил и
  // это: «откати с force» уносил чужую работу часовой давности (находка читателя).
  if (options.correlationId !== undefined) return;
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
  // Откат по id уже откаченной записи — не «повтор», а вторая правка: force этого не
  // меняет (находка читателя 2026-10-01: повторный откат удаления по id с force вставлял
  // абзац второй раз, хотя правила обещали «дважды один откат не проходит»).
  if (
    options.correlationId !== undefined &&
    history.some((r) => r.op === 'undo' && r.undoOf === options.correlationId)
  ) {
    return nothingToUndo('already_undone', history.length, options.correlationId);
  }
  const record =
    options.correlationId === undefined
      ? lastUndoable(history, ownRecords(history, options.project))
      : (history.find((r) => r.correlationId === options.correlationId) ?? null);
  if (record === null) {
    return nothingToUndo(reasonFor(history, options), history.length, options.correlationId);
  }
  assertOwnProject(record, options.project);
  return record;
}

/** Записи, которые видит сессия проекта (D-23); вызов из терминала видит все. */
function ownRecords(history: readonly WriteRecord[], project: string | undefined) {
  return project === undefined ? history : history.filter((r) => r.project === project);
}

/**
 * Запись чужого проекта, названная по id, — отказ, а не откат (X10): правка проекта A
 * откатывается сессией A или владельцем из терминала, а не соседом, получившим её id.
 */
function assertOwnProject(record: WriteRecord, project: string | undefined): void {
  if (project === undefined || record.project === project) return;
  denyByRule(
    'undo.own-project',
    `Запись ${record.correlationId} сделана ${
      record.project === undefined
        ? 'без проекта (из терминала или до разрешений)'
        : `из проекта ${record.project}`
    }, а откат просит ${project}. Откатить её может сессия того проекта или владелец из ` +
      'терминала.',
  );
}

/** Запись это или уже готовый отказ. */
export const isUndoOutcome = (value: WriteRecord | UndoOutcome): value is UndoOutcome =>
  'status' in value;
