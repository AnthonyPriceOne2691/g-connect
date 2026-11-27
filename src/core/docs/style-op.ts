/**
 * Стили документа (уровень 3, слайс 7): вид текста, вид абзаца, списки.
 *
 * Текст операции не трогают вовсе, поэтому их откат — снимок ПРЕЖНИХ полей: прогоны со
 * стилями и вид абзацев накатываются обратно без вставок и удалений (P11, P12).
 * Конвертные: обратимость полная, масштаб виден в превью. `count` расширяет правку на
 * несколько абзацев подряд («сделай список из трёх абзацев» — P12), `fragment` сужает вид
 * текста до фразы внутри одного абзаца (подсветка, 27.11).
 */

import { limitOf } from '../policy.js';
import { gcError } from '../errors.js';
import { snapshotRange } from './delete-op.js';
import { fragmentRange } from './fragment.js';
import { docPlanId, type DocPlanShape } from './plan.js';
import { paragraphLabel, pickTab } from './selectors.js';
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
  /** `updateTextStyle`: точная фраза внутри якорного абзаца — вид только на неё (27.11). */
  readonly fragment?: string | undefined;
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

/** Одна правка плана: абзац и диапазон в нём — абзац целиком или фраза. */
interface StyleSpan {
  readonly paragraph: DocParagraph;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly anchor: string;
}

/** Где правка: общий диапазон, правки плана и заметка превью о масштабе. */
interface StyleScope {
  readonly start: number;
  readonly end: number;
  readonly spans: readonly StyleSpan[];
  readonly note: string;
}

/**
 * Фраза — кусок ОДНОГО абзаца и только вида текста: у вида абзаца и списка куска нет, а с
 * `count` больше 1 неясно, в каком абзаце её искать. Отказ — до поиска фразы и до записи.
 */
function fragmentOf(request: DocStyleRequest): string | undefined {
  const { fragment } = request;
  if (fragment === undefined) return undefined;
  if (request.op !== 'updateTextStyle' || (request.count ?? 1) > 1) {
    throw gcError('bad_request', {
      cause: 'fragment_scope',
      detail:
        `fragment — фраза внутри ОДНОГО абзаца и только у updateTextStyle (сейчас ${request.op}, ` +
        `count ${request.count ?? 1}). Убери count или поставь 1; несколько фраз — ` +
        'отдельными правками.',
    });
  }
  return fragment;
}

/**
 * Диапазон правки: абзацы целиком или фраза из `fragmentRange` — её нет или она не одна,
 * и это отказ, а не первое вхождение (`docs.fragment-exact`). Предложения судятся раньше
 * фразы: текст такого абзаца — смесь, и «фразы нет» звучало бы неправдой.
 */
function styleScope(tab: DocTab, anchor: DocParagraph, request: DocStyleRequest): StyleScope {
  const fragment = fragmentOf(request);
  const paragraphs = targetParagraphs(tab, anchor, Math.max(1, request.count ?? 1));
  assertNoSuggestions(paragraphs);
  if (fragment === undefined) {
    return {
      start: anchor.startIndex,
      end: paragraphs[paragraphs.length - 1]!.endIndex,
      spans: paragraphs.map((paragraph) => ({
        paragraph,
        startIndex: paragraph.startIndex,
        endIndex: paragraph.endIndex,
        anchor: `абзац ${paragraphLabel(paragraph)}`,
      })),
      note: `Абзацев: ${paragraphs.length}, текст не меняется. Откат вернёт прежние стили и вид.`,
    };
  }
  const range = fragmentRange(anchor, fragment);
  return {
    start: range.startIndex,
    end: range.endIndex,
    spans: [
      {
        paragraph: anchor,
        ...range,
        anchor: `фраза «${fragment}» в абзаце ${paragraphLabel(anchor)}`,
      },
    ],
    note:
      `Только фраза «${fragment}» (${range.endIndex - range.startIndex} юнитов): текст не ` +
      'меняется, остальной абзац не трогается. Откат вернёт прежний вид только ей.',
  };
}

const styleWords = (style: DocTextStyle): string =>
  Object.entries(style)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');

/** Что меняем и как сказать это человеку. */
function describe(request: DocStyleRequest): {
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
  // Фраза сужает и снимок, и меру конверта: юниты правки — юниты фразы, а не абзаца.
  const scope = styleScope(tab, resolved.paragraph, request);
  const { start, end } = scope;

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
  const described = describe(request);
  const plan: DocPlanShape = {
    targetId: snapshot.docId,
    op: request.op,
    revisionId: snapshot.revisionId,
    changes: scope.spans.map((span) => ({
      kind: request.op,
      tab: tab.title,
      startIndex: span.startIndex,
      endIndex: span.endIndex,
      before: span.paragraph.namedStyle,
      after: described.after,
    })),
  };
  const code = docPlanId(plan);
  const changes: DocChangePreview[] = scope.spans.map(({ paragraph, anchor }) => ({
    kind: request.op,
    tab: tab.title,
    anchor,
    before: `${paragraph.namedStyle}${paragraph.bulleted === true ? ' + список' : ''}`,
    after: described.after,
  }));
  const notes = [scope.note];

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
