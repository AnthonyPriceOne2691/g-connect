/**
 * Вставка текста в документ (уровень 3, слайс 4): `appendText`, `insertText`.
 *
 * Обе вставляют НОВЫЙ АБЗАЦ: `insertText` — после абзаца-якоря, `appendText` — в конец
 * таба или раздела. Механика одна: `'\n' + text` на позицию ПЕРЕД завершающим переносом
 * якорного абзаца — так новый абзац наследует стиль якоря, а вставленный диапазон
 * симметрично удаляется откатом.
 *
 * Контур тот же, что у таблиц (D-16/D-17): превью с кодом плана → подпись → однократность
 * → запись. Предусловие здесь серверное: ревизия превью входит в код плана, и её же
 * требует `writeControl` — межвызовный дрейф ловит подпись, гонку внутри вызова — сервер.
 */

import { newCorrelationId } from '../errors.js';
import type { JournalSink, JournalSource } from '../journal.js';
import { assertPlanNotApplied } from '../sheets/write-guards.js';
import type { EnvelopeDecision, OperationKind, Question } from '../sheets/write-types.js';
import { docPlanId, type DocPlanChange, type DocPlanShape } from './plan.js';
import { paragraphLabel, pickTab, resolveParagraph, resolveSection } from './selectors.js';
import type { DocParagraph, DocSnapshot, DocTab, DocsClient } from './types.js';

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

export interface DocInsertRequest {
  readonly op: 'appendText' | 'insertText';
  readonly text: string;
  readonly tab?: string | undefined;
  readonly afterHeading?: string | undefined;
  readonly where?:
    | {
        readonly paragraphIndex?: number | undefined;
        readonly textStartsWith?: string | undefined;
        readonly textContains?: string | undefined;
        readonly firstParagraph?: true | undefined;
        readonly lastParagraph?: true | undefined;
      }
    | undefined;
}

const clarify = (questions: readonly Question[]): DocApplyOutcome => ({
  status: 'needs_clarification',
  planId: null,
  changes: [],
  notes: [],
  questions,
});

/** Селектор схемы → селектор ядра: ровно один ключ, иначе вопрос, а не догадка. */
function narrowSelector(
  where: NonNullable<DocInsertRequest['where']>,
): Parameters<typeof resolveParagraph>[1] | Question {
  const keys = Object.entries(where).filter(([, v]) => v !== undefined);
  if (keys.length === 1) {
    return Object.fromEntries(keys) as Parameters<typeof resolveParagraph>[1];
  }
  return {
    field: 'where',
    reason: 'ambiguous',
    detail:
      keys.length === 0
        ? 'Селектор пуст: скажи, после какого абзаца вставлять.'
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

/** Куда вставлять и как назвать это человеку. */
function anchorOf(
  tab: DocTab,
  request: DocInsertRequest,
): { paragraph: DocParagraph; label: string } | { question: Question } {
  if (request.op === 'insertText') {
    const selector = narrowSelector(request.where ?? {});
    if ('field' in selector) return { question: selector };
    const hit = resolveParagraph(tab, selector);
    if (hit.status === 'question') return { question: hit.question };
    if (hit.value.inTable !== undefined) {
      return {
        question: {
          field: 'where',
          reason: 'no_match',
          detail:
            `Абзац ${paragraphLabel(hit.value)} живёт в ячейке таблицы — вставка абзаца ` +
            'внутрь таблицы не поддерживается: правь ячейку заменой текста.',
          candidates: [],
          available: [],
        },
      };
    }
    return { paragraph: hit.value, label: `после абзаца ${paragraphLabel(hit.value)}` };
  }
  if (request.afterHeading !== undefined) {
    const section = resolveSection(tab, request.afterHeading);
    if (section.status === 'question') return { question: section.question };
    const body = section.value.paragraphs.filter((p) => p.inTable === undefined);
    const last = body[body.length - 1] ?? section.value.heading;
    return {
      paragraph: last,
      label: `в конец раздела «${section.value.heading.text}» (${paragraphLabel(last)})`,
    };
  }
  const body = tab.paragraphs.filter((p) => p.inTable === undefined);
  const last = body[body.length - 1];
  if (last === undefined) {
    return {
      question: {
        field: 'tab',
        reason: 'no_match',
        detail: `В табе «${tab.title}» нет ни одного абзаца — дописывать не к чему.`,
        candidates: [],
        available: [],
      },
    };
  }
  return { paragraph: last, label: `в конец таба «${tab.title}» (${paragraphLabel(last)})` };
}

export async function runDocInsert(
  client: DocsClient,
  snapshot: DocSnapshot,
  request: DocInsertRequest,
  options: DocRunOptions,
): Promise<DocApplyOutcome> {
  const tab = pickTab(snapshot, request.tab);
  const anchor = anchorOf(tab, request);
  if ('question' in anchor) return clarify([anchor.question]);

  const at = anchor.paragraph.endIndex - 1;
  const inserted = `\n${request.text}`;
  const plan: DocPlanShape = {
    targetId: snapshot.docId,
    op: request.op,
    revisionId: snapshot.revisionId,
    changes: [
      {
        kind: request.op,
        tab: tab.title,
        startIndex: at,
        endIndex: at + inserted.length,
        anchor: anchor.label,
        after: request.text,
      },
    ],
  };
  const code = docPlanId(plan);
  const changes: DocChangePreview[] = [
    { kind: request.op, tab: tab.title, anchor: anchor.label, before: null, after: request.text },
  ];
  const paragraphsAdded = request.text.split('\n').length;
  const notes = [
    `Новых абзацев: ${paragraphsAdded}, ${anchor.label}. Стиль — как у якорного абзаца.`,
  ];

  if (options.dryRun !== false) {
    return { status: 'preview', planId: code, changes, notes, questions: [] };
  }
  return performInsert(
    client,
    snapshot,
    tab.tabId,
    { plan: plan.changes[0]!, code, changes, notes },
    options,
    request.op,
  );
}

/**
 * Кто разрешил запись: код плана или конверт (D-16/D-18). `null` — разрешена.
 * Конверт судит юниты вставляемого текста (maxChars, владелец 2026-09-08).
 */
function permissionRefusal(
  commit: InsertCommit,
  options: DocRunOptions,
  op: 'appendText' | 'insertText',
  charCount: number,
): DocApplyOutcome | null {
  if (options.confirm === commit.code) return null;
  const decision = options.authorize?.(op, charCount);
  if (decision?.authorized === true) return null;
  return {
    status: 'confirm_required',
    planId: commit.code,
    changes: commit.changes,
    notes: [
      ...commit.notes,
      ...(decision === undefined ? [] : [decision.reason]),
      `Запись — по коду плана: подтверди «пиши ${commit.code}».`,
    ],
    questions: [],
  };
}

interface InsertCommit {
  readonly plan: DocPlanChange;
  readonly code: string;
  readonly changes: readonly DocChangePreview[];
  readonly notes: readonly string[];
}

/** Фаза записи: разрешение (конверт или код), однократность, запись, журнал. */
async function performInsert(
  client: DocsClient,
  snapshot: DocSnapshot,
  tabId: string,
  commit: InsertCommit,
  options: DocRunOptions,
  op: 'appendText' | 'insertText',
): Promise<DocApplyOutcome> {
  const { plan, code, changes, notes } = commit;
  const inserted = `\n${plan.after ?? ''}`;
  // Однократность судится по ПЕРЕДАННОМУ коду и раньше сверки с новым планом: повтор
  // «пиши abc123» должен получить «уже записано», а не свежий код с приглашением
  // записать то же второй раз (тот же порядок, что у таблиц, B20/B21).
  await assertPlanNotApplied(options, options.confirm ?? null, snapshot.docId);
  const refusal = permissionRefusal(commit, options, op, inserted.length);
  if (refusal !== null) return refusal;

  const { revisionId: revisionAfter } = await client.batchUpdate(
    snapshot.docId,
    [{ kind: 'insertText', tabId, at: plan.startIndex, text: inserted }],
    snapshot.revisionId,
  );

  const correlationId = newCorrelationId();
  if (options.journal !== undefined) {
    await options.journal({
      at: new Date().toISOString(),
      account: options.account ?? 'default',
      targetId: snapshot.docId,
      alias: options.alias ?? null,
      sheet: plan.tab,
      op,
      changes: [],
      doc: { tab: plan.tab, startIndex: plan.startIndex, endIndex: plan.endIndex, inserted },
      revisionBefore: snapshot.revisionId,
      revisionAfter,
      correlationId,
      planId: code,
    });
  }
  return {
    status: 'ok',
    planId: code,
    changes,
    notes,
    questions: [],
    correlationId,
    revisionBefore: snapshot.revisionId,
    revisionAfter,
  };
}
