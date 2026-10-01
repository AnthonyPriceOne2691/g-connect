/**
 * Стили документа (уровень 3, слайс 7): вид текста, вид абзаца, списки.
 *
 * Текст операции не трогают вовсе, поэтому их откат — снимок ПРЕЖНИХ полей: прогоны со
 * стилями и вид абзацев накатываются обратно без вставок и удалений (P11, P12).
 * Конвертные: обратимость полная, масштаб виден в превью. `count` расширяет правку на
 * несколько абзацев подряд («сделай список из трёх абзацев» — P12).
 */

import { limitOf } from '../policy.js';
import { gcError } from '../errors.js';
import { snapshotRange } from './delete-op.js';
import { docPlanId, type DocPlanShape } from './plan.js';
import { pickTab } from './selectors.js';
import type {
  DocParagraph,
  DocRequest,
  DocSnapshot,
  DocTab,
  DocTextStyle,
  DocsClient,
  ParagraphNamedStyle,
} from './types.js';
import {
  assertDocPlanNotApplied,
  assertNoSuggestions,
  commitDocWrite,
  type DocApplyOutcome,
  type DocChangePreview,
  type DocRunOptions,
  type DocWhere,
  permissionRefusal,
  resolveBodyParagraph,
} from './write-support.js';

export interface DocStyleRequest {
  readonly op:
    'updateTextStyle' | 'setParagraphStyle' | 'createParagraphBullets' | 'deleteParagraphBullets';
  readonly tab?: string | undefined;
  readonly where?: DocWhere | undefined;
  /** Сколько абзацев подряд, начиная с якорного (P12). */
  readonly count?: number | undefined;
  /** `updateTextStyle`: какие поля ставим (частичная правка, как у ячеек). */
  readonly style?: DocTextStyle | undefined;
  /** `setParagraphStyle`: во что превратить абзац. */
  readonly namedStyle?: ParagraphNamedStyle | undefined;
}

/** Абзацы правки: якорный и `count - 1` следующих body-абзацев. */
function targetParagraphs(
  tab: DocTab,
  anchor: DocParagraph,
  count: number,
): readonly DocParagraph[] {
  const body = tab.paragraphs.filter((p) => p.inTable === undefined);
  const from = body.findIndex((p) => p.index === anchor.index);
  return body.slice(from, from + count);
}

const styleWords = (style: DocTextStyle): string =>
  Object.entries(style)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');

/** Что меняем и как сказать это человеку. */
function describe(
  request: DocStyleRequest,
  paragraphs: readonly DocParagraph[],
): {
  after: string;
  requests: (tabId: string, start: number, end: number) => DocRequest[];
} {
  switch (request.op) {
    case 'updateTextStyle': {
      const style = request.style ?? {};
      if (Object.keys(style).length === 0) {
        throw gcError('bad_request', { detail: 'updateTextStyle требует непустой style.' });
      }
      return {
        after: styleWords(style),
        requests: (tabId, start, end) => [
          { kind: 'updateTextStyle', tabId, startIndex: start, endIndex: end, style },
        ],
      };
    }
    case 'setParagraphStyle': {
      const namedStyle = request.namedStyle;
      if (namedStyle === undefined) {
        throw gcError('bad_request', { detail: 'setParagraphStyle требует namedStyle.' });
      }
      return {
        after: namedStyle,
        requests: (tabId, start, end) => [
          { kind: 'updateParagraphStyle', tabId, startIndex: start, endIndex: end, namedStyle },
        ],
      };
    }
    default: {
      const bulleted = request.op === 'createParagraphBullets';
      return {
        after: bulleted ? 'список' : 'без списка',
        requests: (tabId, start, end) => [
          { kind: 'setBullets', tabId, startIndex: start, endIndex: end, bulleted },
        ],
      };
    }
  }
  void paragraphs;
}

export async function runDocStyle(
  client: DocsClient,
  snapshot: DocSnapshot,
  request: DocStyleRequest,
  options: DocRunOptions,
): Promise<DocApplyOutcome> {
  const tab = pickTab(snapshot, request.tab);
  const resolved = resolveBodyParagraph(tab, request.where, 'стили ячеек — отдельной правкой.');
  if ('outcome' in resolved) return resolved.outcome;
  const count = Math.max(1, request.count ?? 1);
  const paragraphs = targetParagraphs(tab, resolved.paragraph, count);
  assertNoSuggestions(paragraphs);
  const last = paragraphs[paragraphs.length - 1]!;
  const start = resolved.paragraph.startIndex;
  const end = last.endIndex;

  // Снимок прежних стилей уходит в журнал — тот же бюджет, что у удаления, и отказ ДО
  // подтверждения (находка читателя 2026-10-01: по коду плана в журнал ушло 60 001 юнит).
  const budget = limitOf('write.snapshot-max-chars', 20000);
  if (end - start > budget) {
    throw gcError('policy_denied', {
      detail:
        `Снимок прежних стилей не построить: диапазон ${end - start} юнитов, бюджет ${budget} ` +
        '(правило write.snapshot-max-chars). Правка не выполнена — раздели её на части.',
      cause: 'write.snapshot-max-chars',
    });
  }
  const stored = snapshotRange(tab, start, end);
  if (stored === null) {
    throw gcError('bad_request', { detail: 'Диапазон стилей рвётся о таблицу.' });
  }
  const described = describe(request, paragraphs);
  const plan: DocPlanShape = {
    targetId: snapshot.docId,
    op: request.op,
    revisionId: snapshot.revisionId,
    changes: paragraphs.map((paragraph) => ({
      kind: request.op,
      tab: tab.title,
      startIndex: paragraph.startIndex,
      endIndex: paragraph.endIndex,
      before: paragraph.namedStyle,
      after: described.after,
    })),
  };
  const code = docPlanId(plan);
  const changes: DocChangePreview[] = paragraphs.map((paragraph) => ({
    kind: request.op,
    tab: tab.title,
    anchor: `абзац № ${paragraph.index}`,
    before: `${paragraph.namedStyle}${paragraph.bulleted === true ? ' + список' : ''}`,
    after: described.after,
  }));
  const notes = [
    `Абзацев: ${paragraphs.length}, текст не меняется. Откат вернёт прежние стили и вид.`,
  ];

  if (options.dryRun !== false) {
    return { status: 'preview', planId: code, changes, notes, questions: [] };
  }
  await assertDocPlanNotApplied(options, code, snapshot.docId);
  const refusal = permissionRefusal(options, request.op, end - start, { code, changes, notes });
  if (refusal !== null) return refusal;

  return commitDocWrite(
    client,
    snapshot,
    {
      op: request.op,
      tabTitle: tab.title,
      code,
      changes,
      notes,
      requests: described.requests(tab.tabId, start, end),
      doc: { tab: tab.title, startIndex: start, endIndex: end, snapshot: stored, styled: true },
    },
    options,
  );
}
