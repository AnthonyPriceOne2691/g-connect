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
import type { SheetRequest, SheetSnapshot } from './sheets/types.js';
import type { CellFormat, SheetsClient, SpreadsheetSnapshot } from './sheets/types.js';

export interface UndoOptions {
  readonly account?: string;
  /** Откатить КОНКРЕТНУЮ запись по её id — способ дотянуться до старой осознанно. */
  readonly correlationId?: string;
  /** Сколько последних записей откатить. Больше одной — редкий случай, но он законен. */
  readonly last?: number;
  /** Ревизия сейчас — только для записи в журнал; решение об откате принимается по ячейкам. */
  readonly currentRevision?: string | null;
  /**
   * Ревизия ПОСЛЕ обратной записи — тем же способом, каким её читает путь записи.
   * Раньше здесь стоял литерал `null`, хотя тип `WriteRecord` и `rules.md` обещают
   * человеку обе ревизии: строка отката была заведомо неполной.
   */
  readonly readRevision?: () => Promise<string | null>;
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
  /**
   * Что вернула геометрия (D-19): «вставленная строка 4 удалена», «лист Октябрь удалён».
   * Отдельным полем, потому что `restored` описывает ячейки, а у структурной правки
   * ячеек может не быть вовсе — и молчать об этом нельзя (урок L5).
   */
  readonly structureUndone?: string;
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
  if (record.structure !== undefined) return undoStructure(client, targetId, record, options);
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

/**
 * Откат правки геометрии (D-19): обратная структурная операция.
 *
 * Снимок здесь ещё не нужен — эта половина поставки про позиционные правки, где терять
 * нечего: вставленное удаляется, имя возвращается. Но охранник нужен ровно поэтому:
 * вставленную строку человек мог успеть ЗАПОЛНИТЬ, и тогда «просто удалить вставленное»
 * уничтожит его работу. Пустое удаляем, непустое — отказ с причиной (G4).
 */
async function undoStructure(
  client: SheetsClient,
  targetId: string,
  record: WriteRecord,
  options: UndoOptions,
): Promise<UndoOutcome> {
  const structure = record.structure;
  if (structure === undefined) throw gcError('internal', { detail: 'Запись без геометрии.' });
  const book = await client.getSpreadsheet(targetId);
  const request = inverseOf(book, structure, options);
  await client.batchUpdate(targetId, [request]);
  await journalUndo(record, targetId, options);
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    structureUndone: undoneText(structure),
  };
}

/** Обратная операция и охранник к ней. Одна функция: обратная правка и её условие связаны. */
function inverseOf(
  book: SpreadsheetSnapshot,
  structure: NonNullable<WriteRecord['structure']>,
  options: UndoOptions,
): SheetRequest {
  const kind = structure.kind;
  if (kind === 'insertRows') return removeInserted(book, structure, options, 'rows');
  if (kind === 'insertColumns') return removeInserted(book, structure, options, 'columns');
  if (kind === 'addSheet') {
    const sheet = sheetByTitle(book, structure.title ?? structure.sheet);
    if (options.force !== true) assertSheetEmpty(sheet);
    return { kind: 'deleteSheet', sheetId: sheet.sheetId };
  }
  if (kind === 'renameSheet') {
    const sheet = sheetByTitle(book, structure.title ?? structure.sheet);
    return {
      kind: 'renameSheet',
      sheetId: sheet.sheetId,
      title: structure.previousTitle ?? structure.sheet,
    };
  }
  // Удаления, перемещение и сортировка приедут со своими снимками (слайсы 4-6). Пока
  // такой записи в журнале появиться негде, но молчать об этом нельзя.
  throw gcError('bad_request', {
    detail: `Откат правки «${kind}» ещё не построен: такие операции пока не пишутся.`,
    cause: 'undo_not_built',
  });
}

function sheetByTitle(book: SpreadsheetSnapshot, title: string): SheetSnapshot {
  const sheet = book.sheets.find((s) => s.title === title);
  if (sheet !== undefined) return sheet;
  throw gcError('revision_conflict', {
    detail: `Листа «${title}» в книге больше нет — откатывать нечего, перечитай документ.`,
    cause: 'sheet_gone',
  });
}

/** Вставленное всё ещё пусто? Иначе откат удалил бы то, что человек туда написал. */
function assertInsertedEmpty(
  sheet: SheetSnapshot,
  dimension: 'rows' | 'columns',
  structure: NonNullable<WriteRecord['structure']>,
): void {
  const start = (structure.at ?? 1) - 1;
  const count = structure.count ?? 1;
  const cells =
    dimension === 'rows'
      ? sheet.rows.slice(start, start + count).flat()
      : sheet.rows.flatMap((row) => row.slice(start, start + count));
  const filled = cells.filter((cell) => cell !== undefined && !isBlank(cell));
  if (filled.length === 0) return;
  throw gcError('revision_conflict', {
    detail:
      `Во вставленное после записи что-то написали (${filled.length} ` +
      'непустых ячеек). Откат удалил бы эти данные, поэтому не выполнен: перечитай и реши, ' +
      'что вернуть. Если удалить всё равно — откат с force.',
    cause: 'inserted_not_empty',
  });
}

/** Лист, созданный нами, всё ещё пуст? Удалять заполненный людьми лист откат не вправе. */
function assertSheetEmpty(sheet: SheetSnapshot): void {
  const filled = sheet.rows.flat().filter((cell) => cell !== undefined && !isBlank(cell));
  if (filled.length === 0) return;
  throw gcError('revision_conflict', {
    detail:
      `На листе «${sheet.title}» после создания появились данные (${filled.length} ` +
      'непустых ячеек). Откат удалил бы лист вместе с ними, поэтому не выполнен.',
    cause: 'sheet_not_empty',
  });
}

const isBlank = (cell: { value: unknown; formula?: string }): boolean =>
  (cell.value === null || cell.value === '') && cell.formula === undefined;

/** Что сказать человеку про откат геометрии. Текст, а не ветвление на стороне клиента. */
function undoneText(structure: NonNullable<WriteRecord['structure']>): string {
  const count = structure.count ?? 1;
  if (structure.kind === 'insertRows') {
    return `Вставленные строки удалены: ${count} шт. начиная с ${structure.at ?? 1}-й.`;
  }
  if (structure.kind === 'insertColumns') {
    return `Вставленные колонки удалены: ${count} шт. начиная с ${structure.at ?? 1}-й.`;
  }
  if (structure.kind === 'addSheet') {
    return `Лист «${structure.title ?? structure.sheet}» удалён — он был пуст.`;
  }
  return `Лист переименован обратно: «${structure.title ?? ''}» → «${structure.previousTitle ?? ''}».`;
}

/** Удалить вставленное — с охранником «оно ещё пусто». Одна форма на строки и колонки. */
function removeInserted(
  book: SpreadsheetSnapshot,
  structure: NonNullable<WriteRecord['structure']>,
  options: UndoOptions,
  dimension: 'rows' | 'columns',
): SheetRequest {
  const sheet = sheetByTitle(book, structure.sheet);
  if (options.force !== true) assertInsertedEmpty(sheet, dimension, structure);
  return {
    kind: 'deleteDimension',
    sheetId: sheet.sheetId,
    dimension,
    at: structure.at ?? 1,
    count: structure.count ?? 1,
  };
}
