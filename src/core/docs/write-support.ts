/**
 * Общее у doc-операций записи: селектор запроса, вопросы, хвост записи (уровень 3).
 *
 * Хвост записи один на вставки, удаления и будущие замены — гейт копипаста нашёл три
 * копии, и он прав: разъехавшись, журнал и ответ описывали бы правку по-разному, а
 * расхождение всплыло бы только на откате (класс L14).
 */

import { gcError, newCorrelationId } from '../errors.js';
import { looksLikePlanCode, namesTheSubject } from '../sheets/write-guards.js';
import type { DocWriteDetail, JournalSink, JournalSource } from '../journal.js';
import type { EnvelopeDecision, OperationKind, Question } from '../sheets/write-types.js';
import { paragraphLabel, resolveParagraph } from './selectors.js';
import type { DocParagraph, DocRequest, DocSnapshot, DocTab, DocsClient } from './types.js';

export interface DocChangePreview {
  readonly kind: string;
  readonly tab: string;
  /** Якорь, которым правку читает человек. */
  readonly anchor: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface DocApplyOutcome {
  readonly status: 'preview' | 'ok' | 'confirm_required' | 'needs_clarification' | 'no_change';
  readonly planId: string | null;
  readonly changes: readonly DocChangePreview[];
  readonly notes: readonly string[];
  readonly questions: readonly Question[];
  readonly correlationId?: string;
  readonly revisionBefore?: string | null;
  readonly revisionAfter?: string | null;
}

export interface DocRunOptions {
  readonly dryRun?: boolean;
  readonly confirm?: string;
  readonly force?: boolean;
  readonly journal?: JournalSink;
  readonly journalSource?: JournalSource;
  readonly account?: string;
  readonly alias?: string | null;
  /** Судья конверта (D-18): разрешает ли цель эту правку с первой фразы, мера — юниты. */
  readonly authorize?: (op: OperationKind, charCount: number) => EnvelopeDecision;
}

/** Селектор абзаца на внешней границе — ровно один ключ (проверяет `narrowSelector`). */
export interface DocWhere {
  readonly paragraphIndex?: number | undefined;
  readonly textStartsWith?: string | undefined;
  readonly textContains?: string | undefined;
  readonly firstParagraph?: true | undefined;
  readonly lastParagraph?: true | undefined;
}

export const clarify = (questions: readonly Question[]): DocApplyOutcome => ({
  status: 'needs_clarification',
  planId: null,
  changes: [],
  notes: [],
  questions,
});

/** Селектор схемы → селектор ядра: ровно один ключ, иначе вопрос, а не догадка. */
export function narrowSelector(where: DocWhere): Parameters<typeof resolveParagraph>[1] | Question {
  const keys = Object.entries(where).filter(([, v]) => v !== undefined);
  if (keys.length === 1) {
    return Object.fromEntries(keys) as Parameters<typeof resolveParagraph>[1];
  }
  return {
    field: 'where',
    reason: 'ambiguous',
    detail:
      keys.length === 0
        ? 'Селектор пуст: скажи, какой абзац.'
        : `В селекторе ${keys.length} условия сразу (${keys.map(([k]) => k).join(', ')}) — оставь одно.`,
    candidates: [],
    available: [
      'paragraphIndex',
      'textStartsWith',
      'textContains',
      'firstParagraph',
      'lastParagraph',
    ],
  };
}

export interface DocCommit {
  readonly op: string;
  readonly tabTitle: string;
  readonly code: string;
  readonly changes: readonly DocChangePreview[];
  readonly notes: readonly string[];
  readonly requests: readonly DocRequest[];
  /** Что ляжет в журнал: диапазон после правки и снимок «до», если он есть. */
  readonly doc: DocWriteDetail;
}

/** Хвост записи: запрос под серверным предусловием, строка журнала, ok-ответ. */
export async function commitDocWrite(
  client: DocsClient,
  snapshot: DocSnapshot,
  commit: DocCommit,
  options: DocRunOptions,
): Promise<DocApplyOutcome> {
  const { revisionId: revisionAfter } = await client.batchUpdate(
    snapshot.docId,
    commit.requests,
    snapshot.revisionId,
  );
  const correlationId = newCorrelationId();
  if (options.journal !== undefined) {
    await options.journal({
      at: new Date().toISOString(),
      account: options.account ?? 'default',
      targetId: snapshot.docId,
      alias: options.alias ?? null,
      sheet: commit.tabTitle,
      op: commit.op as never,
      changes: [],
      doc: commit.doc,
      revisionBefore: snapshot.revisionId,
      revisionAfter,
      correlationId,
      planId: commit.code,
    });
  }
  return {
    status: 'ok',
    planId: commit.code,
    changes: commit.changes,
    notes: commit.notes,
    questions: [],
    correlationId,
    revisionBefore: snapshot.revisionId,
    revisionAfter,
  };
}

export interface PlannedPreview {
  readonly code: string;
  readonly changes: readonly DocChangePreview[];
  readonly notes: readonly string[];
}

/**
 * Подтверждение названием (D-20) — один текст отказа на все разрушающие doc-операции:
 * голое «да», чужой код и молчание различены (класс находки живого прогона 2026-09-04).
 * `null` — предмет назван (или дан код этого плана), запись разрешена.
 */
export function namedConfirmRefusal(
  given: string | undefined,
  phrase: string,
  planned: PlannedPreview,
): DocApplyOutcome | null {
  if (given !== undefined && namesTheSubject(given, phrase, planned.code)) return null;
  const mismatch = given !== undefined && looksLikePlanCode(given);
  return {
    status: 'confirm_required',
    planId: planned.code,
    changes: planned.changes,
    notes: [
      ...planned.notes,
      mismatch
        ? `Подтверждён код ${given ?? ''}, а у этого плана код ${planned.code}. Записи не было. ` +
          `Подтверди, назвав предмет: «${phrase}» — или кодом плана.`
        : `Записи не было. Подтверди правку, назвав её предмет: «${phrase}» ` +
          `(или кодом плана ${planned.code}). ${
            given === undefined
              ? 'Подтверждения не было вовсе'
              : `«${given}» предметом правки не называет`
          }.`,
    ],
    questions: [],
  };
}

/**
 * Кто разрешил НЕразрушающую запись: код плана или конверт (D-16/D-18), мера — юниты.
 * `null` — разрешена.
 */
export function permissionRefusal(
  options: DocRunOptions,
  op: OperationKind,
  charCount: number,
  planned: PlannedPreview,
): DocApplyOutcome | null {
  if (options.confirm === planned.code) return null;
  const decision = options.authorize?.(op, charCount);
  if (decision?.authorized === true) return null;
  return {
    status: 'confirm_required',
    planId: planned.code,
    changes: planned.changes,
    notes: [
      ...planned.notes,
      ...(decision === undefined ? [] : [decision.reason]),
      `Запись — по коду плана: подтверди «пиши ${planned.code}».`,
    ],
    questions: [],
  };
}

/**
 * Body-абзац по селектору запроса: один ключ, найден, и НЕ в ячейке таблицы —
 * общий шаг всех операций, адресующих абзац.
 */
export function resolveBodyParagraph(
  tab: DocTab,
  where: DocWhere | undefined,
  inTableAdvice: string,
): { paragraph: DocParagraph } | { outcome: DocApplyOutcome } {
  const selector = narrowSelector(where ?? {});
  if ('field' in selector) return { outcome: clarify([selector]) };
  const hit = resolveParagraph(tab, selector);
  if (hit.status === 'question') return { outcome: clarify([hit.question]) };
  if (hit.value.inTable !== undefined) {
    throw gcError('bad_request', {
      detail: `Абзац ${paragraphLabel(hit.value)} живёт в ячейке таблицы — ${inTableAdvice}`,
    });
  }
  return { paragraph: hit.value };
}
