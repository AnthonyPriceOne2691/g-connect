/**
 * Замены текста (уровень 3, слайс 6b): `replaceText` — в пределах одного абзаца,
 * `replaceAllText` — по табу или всему документу.
 *
 * Откат — НЕ обратная замена: она затронула бы вхождения строки-замены, бывшие в тексте
 * до правки (P7). Снимок позиций и оригинальных прогонов строится ДО правки, позиции в
 * журнале — ПОСЛЕ неё, откат идёт с конца, чтобы сдвиги не портили адреса предыдущих.
 *
 * Названная непокрытость: вхождения в ЯЧЕЙКАХ ТАБЛИЦ не заменяются этой поставкой — они
 * считаются и называются в превью, а правка ячеек остаётся точечной. Живой прогон решит,
 * расширять ли (арифметика внутренностей таблиц — наше прочтение документации).
 */

import { exactStyleRequests } from './style-restore.js';
import { gcError } from '../errors.js';
import type { DocReplacement } from '../journal.js';
import { docPlanId, type DocPlanChange, type DocPlanShape } from './plan.js';
import { paragraphLabel, pickTab } from './selectors.js';
import { sliceParagraphRuns } from './delete-op.js';
import type {
  DocParagraph,
  DocRequest,
  DocSnapshot,
  DocTab,
  DocTextStyle,
  DocsClient,
} from './types.js';
import {
  assertDocPlanNotApplied,
  commitDocWrite,
  destructiveNote,
  type DocApplyOutcome,
  type DocChangePreview,
  type DocRunOptions,
  type DocWhere,
  namedConfirmRefusal,
  permissionRefusal,
  resolveBodyParagraph,
} from './write-support.js';

export interface DocReplaceRequest {
  readonly op: 'replaceText' | 'replaceAllText';
  readonly tab?: string | undefined;
  /** `replaceText`: в каком абзаце. */
  readonly where?: DocWhere | undefined;
  readonly find: string;
  readonly replace: string;
}

interface Occurrence {
  readonly tab: DocTab;
  readonly paragraph: DocParagraph;
  /** Позиция вхождения ДО правки, в юнитах тела таба. */
  readonly at: number;
  /** Стиль первого заменяемого знака — его получит замена (так ведёт себя и Google). */
  readonly style?: DocTextStyle | undefined;
}

/** Стиль прогона, в который попадает смещение абзаца. */
function styleAt(paragraph: DocParagraph, offset: number): DocTextStyle | undefined {
  let cursor = 0;
  for (const run of paragraph.runs) {
    if (offset < cursor + run.text.length) return run.style;
    cursor += run.text.length;
  }
  return undefined;
}

/** Вхождения в body-абзацах (порядок документа); в ячейках таблиц — только счёт. */
function findOccurrences(
  tabs: readonly DocTab[],
  find: string,
  scope?: DocParagraph,
): { hits: Occurrence[]; inTables: number } {
  const hits: Occurrence[] = [];
  let inTables = 0;
  for (const tab of tabs) {
    for (const paragraph of tab.paragraphs) {
      if (scope !== undefined && paragraph.index !== scope.index) continue;
      let from = 0;
      for (;;) {
        const found = paragraph.text.indexOf(find, from);
        if (found === -1) break;
        if (paragraph.inTable === undefined) {
          hits.push({
            tab,
            paragraph,
            at: paragraph.startIndex + found,
            style: styleAt(paragraph, found),
          });
        } else {
          inTables += 1;
        }
        from = found + find.length;
      }
    }
  }
  return { hits, inTables };
}

/** Запросы замены: с конца к началу, чтобы сдвиги не портили адреса предыдущих. */
function replaceRequests(hits: readonly Occurrence[], find: string, replace: string): DocRequest[] {
  const requests: DocRequest[] = [];
  for (const hit of [...hits].reverse()) {
    requests.push({
      kind: 'deleteRange',
      tabId: hit.tab.tabId,
      startIndex: hit.at,
      endIndex: hit.at + find.length,
    });
    requests.push({ kind: 'insertText', tabId: hit.tab.tabId, at: hit.at, text: replace });
    // Вставка наследует стиль соседа СЛЕВА: жирное «Fluminense» становилось обычным
    // «Fluminense FC» (находка читателя 2026-10-01). Замена получает точный стиль первого
    // заменённого знака.
    requests.push(
      ...exactStyleRequests(hit.tab.tabId, hit.at, [
        hit.style === undefined ? { text: replace } : { text: replace, style: hit.style },
      ]),
    );
  }
  return requests;
}

/**
 * Снимок вхождений с позициями ПОСЛЕ правки: i-е вхождение сдвинуто на i×Δ
 * предыдущими заменами (внутри одного таба; между табами сдвига нет).
 */
function replacementsAfter(
  hits: readonly Occurrence[],
  find: string,
  replace: string,
): DocReplacement[] {
  const delta = replace.length - find.length;
  const shiftByTab = new Map<string, number>();
  return hits.map((hit) => {
    const shift = shiftByTab.get(hit.tab.tabId) ?? 0;
    shiftByTab.set(hit.tab.tabId, shift + delta);
    const start = hit.at + shift;
    return {
      tab: hit.tab.title,
      startIndex: start,
      endIndex: start + replace.length,
      runs: sliceParagraphRuns(hit.paragraph, hit.at, hit.at + find.length),
      written: replace,
    };
  });
}

const previewOf = (
  hits: readonly Occurrence[],
  find: string,
  replace: string,
): DocChangePreview[] =>
  hits.slice(0, 10).map((hit) => ({
    kind: 'replace',
    tab: hit.tab.title,
    anchor: paragraphLabel(hit.paragraph),
    before: hit.paragraph.text,
    after: hit.paragraph.text.split(find).join(replace),
  }));

export async function runDocReplace(
  client: DocsClient,
  snapshot: DocSnapshot,
  request: DocReplaceRequest,
  options: DocRunOptions,
): Promise<DocApplyOutcome> {
  assertFindable(request);
  const scoped = scopeOf(snapshot, request);
  if ('outcome' in scoped) return scoped.outcome;
  const { tabs, scope } = scoped;

  const { hits, inTables } = findOccurrences(tabs, request.find, scope);
  if (hits.length === 0) return noHits(request, inTables);
  const built = buildReplacePlan(snapshot, request, tabs, hits, inTables);

  if (options.dryRun !== false) return replacePreview(request, built);
  await assertDocPlanNotApplied(options, built.code, snapshot.docId);
  const refusal = replaceRefusal(options, request, hits.length, built);
  if (refusal !== null) return refusal;

  return commitDocWrite(
    client,
    snapshot,
    {
      op: request.op,
      tabTitle: tabs[0]?.title ?? '*',
      code: built.code,
      changes: built.changes,
      notes: built.notes,
      requests: replaceRequests(hits, request.find, request.replace),
      doc: {
        tab: tabs[0]?.title ?? '*',
        startIndex: hits[0]!.at,
        endIndex: hits[0]!.at,
        replacements: replacementsAfter(hits, request.find, request.replace),
      },
    },
    options,
  );
}

interface BuiltReplacePlan {
  readonly code: string;
  readonly changes: DocChangePreview[];
  readonly notes: string[];
}

function replacePreview(request: DocReplaceRequest, built: BuiltReplacePlan): DocApplyOutcome {
  const how =
    request.op === 'replaceAllText'
      ? destructiveNote(`заменяю ${request.find}`, built.code)
      : `Запись — по коду плана или конвертом.`;
  return {
    status: 'preview',
    planId: built.code,
    changes: built.changes,
    notes: [...built.notes, how],
    questions: [],
  };
}

/** Кто разрешил: название (массовая) либо код/конверт (точечная). `null` — разрешена. */
function replaceRefusal(
  options: DocRunOptions,
  request: DocReplaceRequest,
  hitCount: number,
  built: BuiltReplacePlan,
): DocApplyOutcome | null {
  if (request.op === 'replaceAllText') {
    return namedConfirmRefusal(options, `заменяю ${request.find}`, built);
  }
  const touched = hitCount * Math.max(request.find.length, request.replace.length);
  return permissionRefusal(options, 'replaceText', touched, built);
}

function noHits(request: DocReplaceRequest, inTables: number): DocApplyOutcome {
  return {
    status: 'no_change',
    planId: null,
    changes: [],
    notes: [
      `«${request.find}» не найдено${inTables > 0 ? ` (в ячейках таблиц: ${inTables} — эта операция их не правит)` : ''}. Ни одной правки.`,
    ],
    questions: [],
  };
}

/** План, код и превью замены — фаза планирования, отделённая от разрешения и записи. */
function buildReplacePlan(
  snapshot: DocSnapshot,
  request: DocReplaceRequest,
  tabs: readonly DocTab[],
  hits: readonly Occurrence[],
  inTables: number,
): { code: string; changes: DocChangePreview[]; notes: string[] } {
  const plan: DocPlanShape = {
    targetId: snapshot.docId,
    op: request.op,
    revisionId: snapshot.revisionId,
    changes: hits.map((hit): DocPlanChange => ({
      kind: request.op,
      tab: hit.tab.title,
      startIndex: hit.at,
      endIndex: hit.at + request.find.length,
      before: request.find,
      after: request.replace,
    })),
  };
  return {
    code: docPlanId(plan),
    changes: previewOf(hits, request.find, request.replace),
    notes: [
      `Вхождений: ${hits.length} (${countByTab(tabs, hits)})${
        inTables > 0
          ? `; в ячейках таблиц ещё ${inTables} — они НЕ заменяются: текст ячеек ядро не правит, их меняет человек в Docs`
          : ''
      }. Откат вернёт исходные вхождения по снимку, не тронув «${request.replace}», бывшие в тексте до правки.`,
    ],
  };
}

function countByTab(tabs: readonly DocTab[], hits: readonly Occurrence[]): string {
  return tabs
    .map((tab) => `${tab.title}: ${hits.filter((h) => h.tab.tabId === tab.tabId).length}`)
    .join(', ');
}

function assertFindable(request: DocReplaceRequest): void {
  if (request.find === '') {
    throw gcError('bad_request', { detail: 'Пустую строку искать нельзя.' });
  }
}

/** Область поиска: все табы, один таб или один абзац (`replaceText`). */
function scopeOf(
  snapshot: DocSnapshot,
  request: DocReplaceRequest,
): { tabs: readonly DocTab[]; scope: DocParagraph | undefined } | { outcome: DocApplyOutcome } {
  if (request.op === 'replaceAllText') {
    const tabs = request.tab === undefined ? snapshot.tabs : [pickTab(snapshot, request.tab)];
    return { tabs, scope: undefined };
  }
  const tab = pickTab(snapshot, request.tab);
  const resolved = resolveBodyParagraph(tab, request.where, 'эта операция ячейки не правит.');
  if ('outcome' in resolved) return resolved;
  return { tabs: [tab], scope: resolved.paragraph };
}
