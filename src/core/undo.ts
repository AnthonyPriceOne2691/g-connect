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
import { assertRecent, isUndoOutcome, pickUndoRecord } from './undo-shared.js';
import { undoStructure } from './undo-structure.js';
import type { UndoOptions, UndoOutcome } from './undo-types.js';

export type { NothingToUndoReason, UndoOptions, UndoOutcome } from './undo-types.js';
import type { JournalChange, JournalSource, WriteRecord } from './journal.js';
import { formatAt, parseA1, sameCell, sameFormat, valueAt } from './sheets/a1.js';
import type { CellFormat, SheetsClient, SpreadsheetSnapshot } from './sheets/types.js';

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
  revisionAfter: string | null,
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
    revisionAfter,
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
): Promise<UndoOutcome['restored'][number][]> {
  const restored: UndoOutcome['restored'][number][] = [];
  for (const change of [...record.changes].reverse()) {
    if (change.afterFormat === undefined) {
      await client.updateValues(targetId, change.a1, [[change.before]]);
      restored.push({ a1: change.a1, column: change.column, kind: 'value', value: change.before });
      continue;
    }
    const format = undoFormat(change);
    await client.batchUpdate(targetId, [{ kind: 'format', sheetId, ...cellAt(change.a1), format }]);
    // Значение здесь идёт справочно и не менялось — поэтому `kind: 'format'` стоит рядом.
    restored.push({
      a1: change.a1,
      column: change.column,
      kind: 'format',
      value: change.before,
      format,
    });
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
 *
 * У шрифта, кегля и формата числа нейтрального значения нет вовсе — шрифт листа по умолчанию у
 * каждой книги свой. Им ставится `null`: «сбросить к виду листа» (D-26), и шов пишет его полем
 * маски без значения — так ячейка возвращается к унаследованному, а не к выдуманному виду.
 */
function undoFormat(change: JournalChange): CellFormat {
  const before = change.beforeFormat ?? {};
  const neutral: CellFormat = {
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    background: '#ffffff',
    fontFamily: null,
    fontSize: null,
    numberFormat: null,
  };
  const keys = Object.keys(change.afterFormat ?? {});
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = key as keyof CellFormat;
    out[key] = before[field] ?? neutral[field];
  }
  return out;
}

/**
 * Вид нашей ячейки после записи не должны были менять — иначе откат перетрёт чужое.
 *
 * Сверяются только ключи, которые запись задала (ключи `afterFormat`): их и вернёт откат. Чтение
 * вида растёт — с D-26 оно видит шрифт, кегль и формат числа, — и запись журнала, сделанная до
 * этого, получала бы ложный `revision_conflict` на ячейке, где теперь читается `fontFamily`.
 * Чужую правку записанного ключа это не пропускает: она по-прежнему отказ.
 */
function assertFormatIntact(snapshot: SpreadsheetSnapshot, change: JournalChange): void {
  const written = change.afterFormat ?? {};
  const current = onlyKeys(formatAt(snapshot, change.a1), Object.keys(written));
  if (sameFormat(current, written)) return;
  throw gcError('revision_conflict', {
    detail:
      `Вид ячейки ${change.a1} (${change.column}) после записи изменили. Откат перетёр бы ` +
      'чужое оформление, поэтому не выполнен: перечитай и реши, что вернуть.',
    cause: 'format_changed_after_write',
  });
}

/** Вид, суженный до названных ключей: остальное в сверке отката не участвует. */
function onlyKeys(format: CellFormat | undefined, keys: readonly string[]): CellFormat {
  return Object.fromEntries(Object.entries(format ?? {}).filter(([key]) => keys.includes(key)));
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

export async function undoLast(
  client: SheetsClient,
  targetId: string,
  source: JournalSource,
  options: UndoOptions = {},
): Promise<UndoOutcome> {
  const record = await pickUndoRecord(source, targetId, options);
  if (isUndoOutcome(record)) return record;
  assertRecent(record, options);
  if (record.structure !== undefined) {
    return undoStructure(client, targetId, record, options, journalUndo);
  }
  const snapshot = await client.getSpreadsheet(targetId, { sheet: record.sheet });
  assertSafeToUndo(snapshot, record, options);
  const sheetId = snapshot.sheets.find((s) => s.title === record.sheet)?.sheetId ?? 0;

  const restored = await restoreChanges(client, targetId, sheetId, record);

  await journalUndo(record, targetId, options);

  return { status: 'ok', restored, undoneCorrelationId: record.correlationId, at: record.at };
}

/**
 * След отката в журнале: время, ревизия после обратной записи, обратные изменения.
 *
 * Вынесено из `undoLast` не для красоты — гейт сложности отклонил одиннадцатую ветвь в
 * оркестраторе, и он прав: «что откатывать» и «как записать след» это разные вопросы,
 * а в `undoLast` уже тринадцать ветвей на первый из них.
 */
async function journalUndo(
  record: WriteRecord,
  targetId: string,
  options: UndoOptions,
): Promise<void> {
  if (options.journal === undefined) return;
  const at = new Date().toISOString();
  const revisionAfter = (await options.readRevision?.()) ?? null;
  await options.journal(undoRecord(record, targetId, at, options, revisionAfter));
}
