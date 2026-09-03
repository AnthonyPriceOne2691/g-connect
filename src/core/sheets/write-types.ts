/**
 * Типы пишущего контура. Вынесены из `rows.ts`, чтобы охранники записи
 * (`write-guards.ts`) не тянули за собой сам модуль операций: цикл импортов между
 * «что записываем» и «пускать ли записывать» разъехался бы первым же рефакторингом.
 */

import type { JournalSink, JournalSource } from '../journal.js';
import type { ResolveOptions } from '../resolver.js';
import type { CellFormat, CellValue } from './types.js';

export type RowValues = Readonly<Record<string, unknown>>;

/** Три операции записи (§5). Имя типа нужно и охранникам, и журналу. */
export type OperationKind = 'appendRow' | 'upsertRow' | 'setCells' | 'formatCells' | 'findReplace';

export interface Question {
  readonly field: string;
  readonly reason:
    'ambiguous' | 'no_match' | 'not_in_enum' | 'not_a_number' | 'not_a_date' | 'key_not_found';
  readonly detail: string;
  readonly candidates: readonly string[];
  /** Полный список доступного — чтобы человек выбирал из того, что есть (§8.2). */
  readonly available: readonly string[];
}

export interface PlannedChange {
  /** `format` — правка вида: значения такая операция не трогает вовсе (§6.2). */
  readonly kind: 'set' | 'addRow' | 'format';
  readonly a1: string;
  readonly column: string;
  readonly before: CellValue;
  readonly after: CellValue;
  /**
   * Вид «до» и «после» — только у `kind: 'format'`. Оба входят в код плана: иначе два
   * разных плана правок вида (жирный против курсива) получили бы один код, и подпись
   * человека перестала бы указывать на конкретную правку (D-16).
   */
  readonly beforeFormat?: CellFormat;
  readonly afterFormat?: CellFormat;
}

/**
 * Текст статуса `no_change`. Живёт константой: его читает человек, и он же проверяется
 * оракулом — «пустой результат объясняет причину» (§13.7).
 */
const NO_CHANGE_TAIL = 'Записи не было и строки журнала тоже — это не выполненная правка.';

export const NO_CHANGE_NOTE = `Ничего не изменится: в целевых ячейках уже такие значения. ${NO_CHANGE_TAIL}`;

/**
 * Причина «нечего менять» зависит от операции.
 *
 * Живая проверка 2026-09-03: замена, не нашедшая ни одного совпадения, сообщала «в целевых
 * ячейках уже такие значения» — то есть описывала ДРУГОЙ случай. Пустой результат обязан
 * называть свою причину, а не ближайшую похожую (§13.7).
 */
export function noChangeNote(op: OperationKind): string {
  if (op === 'findReplace') {
    return `Совпадений не найдено: ни одна ячейка не подошла под условие поиска. ${NO_CHANGE_TAIL}`;
  }
  if (op === 'formatCells') {
    return `Вид уже такой, каким его просят сделать. ${NO_CHANGE_TAIL}`;
  }
  return NO_CHANGE_NOTE;
}

export interface ApplyOutcome {
  readonly status: 'ok' | 'preview' | 'no_change' | 'plan_mismatch' | 'needs_clarification';
  readonly changes: readonly PlannedChange[];
  /** Ступень 4 резолвера: что именно мы поняли по-своему (§8.2). */
  readonly assumptions: readonly string[];
  /** Нормализации значений — «3ч» → 3, приведение регистра. */
  readonly notes: readonly string[];
  readonly questions: readonly Question[];
  /**
   * Ревизия, на которой построен план. Названа явно: поле `revisionId` в ответе на
   * успешную запись читалось как «ревизия сейчас», а было «ревизия до» — агент, взявший
   * его для следующего `expectRevision`, получал ложную проверку. Нашла живая проба.
   */
  readonly baseRevision: string | null;
  /** Ревизия после записи; `null` для превью и когда её не читали. */
  readonly revisionAfter: string | null;
  /**
   * Код плана (D-16): им человек подтверждает ИМЕННО эту правку. `null` там, где
   * подтверждать нечего — вопрос вместо плана или нулевое изменение.
   */
  readonly planId: string | null;
}

export interface RowOptions extends ResolveOptions {
  readonly dryRun?: boolean;
  /** Куда писать в журнал. Не задан — записи не журналируются (превью и тесты). */
  readonly journal?: JournalSink;
  /** Имя профиля для журнала: в журнал уходит ИМЯ, не креды. */
  readonly account?: string;
  /** Алиас цели из реестра, если он есть — по нему потом читают историю глазами. */
  readonly alias?: string | null;
  /**
   * Ревизия ПОСЛЕ записи. Отдельным колбэком, потому что API её не возвращает, а undo
   * без неё не может отличить «после нас никто не трогал» от «трогали» (§10.3).
   */
  readonly readRevision?: () => Promise<string | null>;
  readonly now?: Date;
  /** Осознанное подтверждение записи в формульную/защищённую колонку (§8.1). */
  readonly force?: boolean;
  /** Код плана из превью — подпись человека под этой правкой (D-16). */
  readonly confirm?: string;
  /** Правка вида: заодно поправить ячейку заголовка — «сделай шапку жирной». */
  readonly includeHeader?: boolean;
  /**
   * Откуда читать историю, чтобы не записать тот же план дважды. Не задан — проверка
   * повторного «пиши» не работает, и это видно в тестах, а не по молчанию.
   */
  readonly journalSource?: JournalSource;
  /** Ревизия, на которой строилась карта: защита от гонки с живой правкой (§3). */
  readonly expectRevision?: string;
}
