/**
 * Удаление текста из документа (уровень 3, слайс 6): `deleteParagraph`, `deleteRange`.
 *
 * Это первые doc-операции, которые УНИЧТОЖАЮТ текст, поэтому здесь всё строго по D-19/D-20:
 * снимок диапазона (текст, стили прогонов, вид абзацев) — или отказ, если снимок больше
 * бюджета; подтверждение НАЗВАНИЕМ предмета — голое «да» не проходит; порядок охранников
 * закреплён (урок L11): вид цели → бюджет → однократность → подтверждение → запись.
 */

import { objectLabels, shownText, visibleText } from './objects.js';
import { gcError } from '../errors.js';
import { limitOf } from '../policy.js';
import { docPlanId, type DocPlanShape } from './plan.js';
import { paragraphLabel, pickTab } from './selectors.js';
import type {
  DocParagraph,
  DocRangeSnapshot,
  DocSnapshot,
  DocTab,
  DocTextRun,
  DocsClient,
  SnapshotParagraph,
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
  resolveBodyParagraph,
} from './write-support.js';

export interface DocDeleteRequest {
  readonly op: 'deleteParagraph' | 'deleteRange';
  readonly tab?: string | undefined;
  /** `deleteParagraph`: какой абзац. */
  readonly where?: DocWhere | undefined;
  /** `deleteRange`: явные индексы — escape hatch (§4). */
  readonly startIndex?: number | undefined;
  readonly endIndex?: number | undefined;
}

/** Прогоны абзаца, попавшие в [from, to), плюс завершающий `\n`, если он захвачен. */
export function sliceParagraphRuns(
  paragraph: DocParagraph,
  from: number,
  to: number,
): DocTextRun[] {
  const out: DocTextRun[] = [];
  let cursor = paragraph.startIndex;
  for (const run of paragraph.runs) {
    const runEnd = cursor + run.text.length;
    const sliceFrom = Math.max(from, cursor);
    const sliceTo = Math.min(to, runEnd);
    if (sliceTo > sliceFrom) {
      out.push({ ...run, text: run.text.slice(sliceFrom - cursor, sliceTo - cursor) });
    }
    cursor = runEnd;
  }
  if (to === paragraph.endIndex) out.push({ text: '\n' });
  return out;
}

/** Снимок диапазона: прогоны с переносами между абзацами и вид каждого абзаца. */
export function snapshotRange(tab: DocTab, start: number, end: number): DocRangeSnapshot | null {
  const runs: DocTextRun[] = [];
  const paragraphs: SnapshotParagraph[] = [];
  let covered = start;
  for (const paragraph of tab.paragraphs) {
    if (paragraph.endIndex <= start || paragraph.startIndex >= end) continue;
    if (paragraph.inTable !== undefined) return null;
    const from = Math.max(start, paragraph.startIndex);
    if (from !== covered) return null;
    if (from === paragraph.startIndex) {
      paragraphs.push({
        offset: from - start,
        namedStyle: paragraph.namedStyle,
        ...(paragraph.bulleted === true ? { bulleted: true } : {}),
      });
    }
    const to = Math.min(end, paragraph.endIndex);
    runs.push(...sliceParagraphRuns(paragraph, from, to));
    covered = to;
  }
  if (covered !== end) return null;
  return { tab: tab.title, startIndex: start, endIndex: end, runs, paragraphs };
}

/** Какой диапазон удаляется и как назвать предмет человеку. */
type RangeChoice =
  | { start: number; end: number; subject: string; shownText: string; caveat?: string }
  | { outcome: DocApplyOutcome };

function explicitRange(request: DocDeleteRequest): RangeChoice {
  const { startIndex, endIndex } = request;
  if (startIndex === undefined || endIndex === undefined || endIndex <= startIndex) {
    throw gcError('bad_request', {
      detail: 'deleteRange требует startIndex и endIndex (полуинтервал, endIndex больше).',
    });
  }
  return {
    start: startIndex,
    end: endIndex,
    subject: `диапазон ${startIndex}–${endIndex}`,
    shownText: '',
  };
}

/**
 * Диапазон удаления абзаца. Перенос ВПЛОТНУЮ к таблице Google удалить не даёт (живьём
 * 2026-10-01: «Invalid deletion range. Cannot delete the requested range») — у абзаца
 * перед таблицей и у последнего абзаца после неё уходит только текст, строка остаётся, и
 * план говорит это заранее. Последний абзац сегмента без таблицы перед ним уводит
 * диапазон на перенос ПРЕДЫДУЩЕГО абзаца (приём из документации).
 */
function paragraphSpan(tab: DocTab, paragraph: DocParagraph): [number, number, string?] {
  const textOnly =
    'Перенос вплотную к таблице Google удалить не даёт: уйдёт текст абзаца, пустая строка останется.';
  if (tab.tables.some((t) => t.startIndex === paragraph.endIndex)) {
    return [paragraph.startIndex, paragraph.endIndex - 1, textOnly];
  }
  const body = tab.paragraphs.filter((p) => p.inTable === undefined);
  const last = body[body.length - 1];
  if (last === undefined || paragraph.index !== last.index || paragraph.startIndex <= 1) {
    return [paragraph.startIndex, paragraph.endIndex];
  }
  if (tab.tables.some((t) => t.endIndex === paragraph.startIndex)) {
    return [paragraph.startIndex, paragraph.endIndex - 1, textOnly];
  }
  return [paragraph.startIndex - 1, paragraph.endIndex - 1];
}

function paragraphRange(tab: DocTab, request: DocDeleteRequest): RangeChoice {
  const resolved = resolveBodyParagraph(
    tab,
    request.where,
    'удаление строк таблицы — deleteTableRow; текст ячеек ядро не правит.',
  );
  if ('outcome' in resolved) return resolved;
  const paragraph = resolved.paragraph;
  const [start, end, caveat] = paragraphSpan(tab, paragraph);
  if (start === end) {
    throw gcError('bad_request', {
      detail:
        `Абзац ${paragraphLabel(paragraph)} пуст и стоит вплотную к таблице: его перенос Google ` +
        'удалить не даёт, а текста в нём нет — удалять нечего.',
    });
  }
  const words = visibleText(paragraph.text)
    .split(/\s+/)
    .filter((w) => w !== '');
  return {
    start,
    end,
    // Абзац без слов (пустой) называется номером: иначе предметом стало бы «абзац », и его
    // «называло» бы любое «да, удаляю абзац» (находка читателя 2026-10-01).
    subject:
      words.length === 0 ? `абзац № ${paragraph.index}` : `абзац ${words.slice(0, 4).join(' ')}`,
    shownText: shownText(paragraph.runs),
    ...(caveat === undefined ? {} : { caveat }),
  };
}

const rangeOf = (tab: DocTab, request: DocDeleteRequest): RangeChoice =>
  request.op === 'deleteRange' ? explicitRange(request) : paragraphRange(tab, request);

/**
 * Снимок в пределах бюджета — или отказ ДО подтверждения (L11, P18): нельзя просить
 * человека подписать удаление, которое ядро не сможет вернуть.
 */
function budgetedSnapshot(tab: DocTab, start: number, end: number): DocRangeSnapshot {
  const budget = limitOf('write.snapshot-max-chars', 20000);
  if (end - start > budget) {
    throw gcError('policy_denied', {
      detail:
        `Снимок для отката не построить: диапазон ${end - start} юнитов, бюджет ${budget} ` +
        '(правило write.snapshot-max-chars). Удаление не выполнено — режь на части или ' +
        'откатывай историей версий Google.',
      cause: 'write.snapshot-max-chars',
    });
  }
  const rangeSnapshot = snapshotRange(tab, start, end);
  if (rangeSnapshot === null) {
    throw gcError('bad_request', {
      detail:
        `Диапазон ${start}–${end} рвётся о таблицу или границы тела — целиком его не снять ` +
        'и не удалить. Таблицы удаляет deleteTable, строки — deleteTableRow; текст ячеек ядро не правит.',
    });
  }
  // Объект откатом не вернуть: снимок держит текст, а не картинку или чип. Правку, которую
  // нечем вернуть, ядро не делает (находка читателя 2026-10-01: удаление абзаца с картинкой
  // уносило её, а откат объявлял «восстановлено»).
  const objects = objectLabels(rangeSnapshot.runs);
  if (objects.length > 0) {
    throw gcError('policy_denied', {
      detail:
        `В удаляемом есть встроенный объект (${objects.join(', ')}) — откат вернул бы текст ` +
        'без него. Удаление не выполнено: убери объект руками в Docs или сузь диапазон до текста.',
      cause: 'docs.objects-not-destroyed',
    });
  }
  return rangeSnapshot;
}

const paragraphOf = (tab: DocTab, at: number): DocParagraph | undefined =>
  tab.paragraphs.find((p) => at >= p.startIndex && at < p.endIndex);

export async function runDocDelete(
  client: DocsClient,
  snapshot: DocSnapshot,
  request: DocDeleteRequest,
  options: DocRunOptions,
): Promise<DocApplyOutcome> {
  const tab = pickTab(snapshot, request.tab);
  const range = rangeOf(tab, request);
  if ('outcome' in range) return range.outcome;
  const { start, end, subject, shownText, caveat } = range;

  const rangeSnapshot = budgetedSnapshot(tab, start, end);

  const confirmToken = subject;
  const plan: DocPlanShape = {
    targetId: snapshot.docId,
    op: request.op,
    revisionId: snapshot.revisionId,
    changes: [
      {
        kind: request.op,
        tab: tab.title,
        startIndex: start,
        endIndex: end,
        anchor: subject,
        before: shownText === '' ? rangeSnapshot.runs.map((r) => r.text).join('') : shownText,
      },
    ],
  };
  const code = docPlanId(plan);
  const changes: DocChangePreview[] = [
    {
      kind: request.op,
      tab: tab.title,
      anchor: subject,
      before: plan.changes[0]!.before ?? null,
      after: null,
    },
  ];
  const anchorParagraph = paragraphOf(tab, start);
  const notes = [
    `Исчезнет ${end - start} юнитов текста${
      anchorParagraph === undefined ? '' : ` (${paragraphLabel(anchorParagraph)})`
    }. Откат вернёт текст со стилями и видом абзацев.`,
    ...(caveat === undefined ? [] : [caveat]),
  ];

  if (options.dryRun !== false) {
    return {
      status: 'preview',
      planId: code,
      changes,
      notes: [...notes, destructiveNote(`удаляю ${confirmToken}`, code)],
      questions: [],
    };
  }
  await assertDocPlanNotApplied(options, code, snapshot.docId);
  const refusal = namedConfirmRefusal(options, `удаляю ${confirmToken}`, {
    code,
    changes,
    notes,
  });
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
      requests: [{ kind: 'deleteRange', tabId: tab.tabId, startIndex: start, endIndex: end }],
      doc: { tab: tab.title, startIndex: start, endIndex: start, snapshot: rangeSnapshot },
    },
    options,
  );
}
