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
import {
  lastUndoable,
  type JournalChange,
  type JournalSink,
  type JournalSource,
  type WriteRecord,
} from './journal.js';
import { formatAt, parseA1, sameCell, sameFormat, valueAt } from './sheets/a1.js';
import type { CellFormat, SheetsClient, SpreadsheetSnapshot } from './sheets/types.js';

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

/**
 * Строка журнала об откате. Вынесена из `undoLast`: гейт сложности считает и литерал с
 * условными полями, и он прав — оркестратор должен читаться одним экраном.
 *
 * Направление меняется местами: `before` записи становится `after` отката. Код плана
 * переносится, чтобы по нему было видно, ЧТО вернули, и чтобы проверка однократности
 * снова разрешила эту правку (B20, B21).
 */
function undoRecord(
  record: WriteRecord,
  targetId: string,
  at: string,
  options: UndoOptions,
): WriteRecord {
  return {
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
      ...(c.afterFormat === undefined ? {} : { beforeFormat: c.afterFormat }),
      ...(c.beforeFormat === undefined ? {} : { afterFormat: c.beforeFormat }),
    })),
    revisionBefore: options.currentRevision ?? null,
    revisionAfter: null,
    correlationId: newCorrelationId(),
    undoOf: record.correlationId,
    ...(record.planId === undefined ? {} : { planId: record.planId }),
  };
}

/**
 * Обратная запись: значения через values-API, вид через `batchUpdate`.
 *
 * В обратном порядке: если одна операция трогала ячейку дважды, вернуть надо самое раннее
 * состояние, а не промежуточное. Вынесено из `undoLast` — гейт сложности был прав, там
 * уже тринадцать ветвей на один оркестратор.
 */
async function restoreChanges(
  client: SheetsClient,
  targetId: string,
  sheetId: number,
  record: WriteRecord,
): Promise<{ a1: string; column: string; value: string | number | boolean | null }[]> {
  const restored: { a1: string; column: string; value: string | number | boolean | null }[] = [];
  for (const change of [...record.changes].reverse()) {
    if (change.afterFormat === undefined) {
      await client.updateValues(targetId, change.a1, [[change.before]]);
    } else {
      await client.batchUpdate(targetId, [
        { kind: 'format', sheetId, ...cellAt(change.a1), format: undoFormat(change) },
      ]);
    }
    restored.push({ a1: change.a1, column: change.column, value: change.before });
  }
  return restored;
}

/** Адрес A1 → строка и колонка для доменного запроса вида. */
function cellAt(a1: string): { row: number; column: number } {
  const parsed = parseA1(a1);
  if (parsed === null) {
    throw gcError('internal', { detail: `В журнале нечитаемый адрес ${a1}.` });
  }
  return { row: parsed.row, column: parsed.column };
}

/**
 * Вид, который надо вернуть. Для полей, которых «до» не было, ставится нейтральное
 * значение: пустого формата в Google не существует, и снять жирность можно только
 * записав `bold: false`.
 *
 * Названная непокрытость: у фона нейтральное значение — белый. Если до правки фон был
 * унаследован от темы, откат сделает его явно белым, а не вернёт наследование. Ядро судит
 * и откатывает только явный формат ячейки, и это записано в спеке.
 */
function undoFormat(change: JournalChange): CellFormat {
  const before = change.beforeFormat ?? {};
  const neutral: CellFormat = {
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    background: '#ffffff',
  };
  const keys = Object.keys(change.afterFormat ?? {});
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = key as keyof CellFormat;
    out[key] = before[field] ?? neutral[field];
  }
  return out;
}

/** Вид нашей ячейки после записи не должны были менять — иначе откат перетрёт чужое. */
function assertFormatIntact(snapshot: SpreadsheetSnapshot, change: JournalChange): void {
  const current = formatAt(snapshot, change.a1);
  if (sameFormat(current, change.afterFormat)) return;
  throw gcError('revision_conflict', {
    detail:
      `Вид ячейки ${change.a1} (${change.column}) после записи изменили. Откат перетёр бы ` +
      'чужое оформление, поэтому не выполнен: перечитай и реши, что вернуть.',
    cause: 'format_changed_after_write',
  });
}

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
function assertSafeToUndo(
  snapshot: SpreadsheetSnapshot,
  record: WriteRecord,
  options: UndoOptions,
): void {
  if (options.force === true) return;
  for (const change of record.changes) {
    // У правки вида значение не менялось — сверять надо ВИД, иначе откат затрёт чужое
    // оформление молча.
    if (change.afterFormat !== undefined) {
      assertFormatIntact(snapshot, change);
      continue;
    }
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
  const snapshot = await client.getSpreadsheet(targetId, { sheet: record.sheet });
  assertSafeToUndo(snapshot, record, options);
  const sheetId = snapshot.sheets.find((s) => s.title === record.sheet)?.sheetId ?? 0;

  const restored = await restoreChanges(client, targetId, sheetId, record);

  const at = new Date().toISOString();
  await options.journal?.(undoRecord(record, targetId, at, options));

  return { status: 'ok', restored, undoneCorrelationId: record.correlationId, at: record.at };
}
