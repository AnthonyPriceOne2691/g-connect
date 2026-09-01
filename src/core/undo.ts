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
import type { CellValue, SheetsClient, SheetSnapshot } from './sheets/types.js';

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

/** `Лист1!D3` → лист и индексы. Нужен, чтобы сверить именно наши ячейки. */
export function parseA1(a1: string): { sheet: string; row: number; column: number } | null {
  const match = /^(.+)!([A-Z]+)(\d+)$/.exec(a1);
  if (match === null) return null;
  const letters = match[2] ?? '';
  let column = 0;
  for (const ch of letters) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { sheet: match[1] ?? '', row: Number(match[3]), column: column - 1 };
}

function valueAt(
  snapshot: { sheets: readonly SheetSnapshot[] },
  a1: string,
): CellValue | undefined {
  const parsed = parseA1(a1);
  if (parsed === null) return undefined;
  const sheet = snapshot.sheets.find((s) => s.title === parsed.sheet);
  return sheet?.rows[parsed.row - 1]?.[parsed.column]?.value ?? null;
}

const same = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  String(a ?? '').trim() === String(b ?? '').trim();

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
    return { status: 'nothing_to_undo', restored: [], undoneCorrelationId: null, at: null };
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
  });

  return { status: 'ok', restored, undoneCorrelationId: record.correlationId, at: record.at };
}
