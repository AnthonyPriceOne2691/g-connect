/**
 * Откат правок документа (уровень 3). Пока одна форма: вставка — откат удаляет
 * вставленный диапазон.
 *
 * Охранник — ТЕКСТ, а не ревизия (тот же принцип, что у ячеек, §10.3): перечитываем
 * документ и сверяем текущий текст диапазона с тем, что вставляли. Совпал — удаляем
 * с `writeControl` на ПРОЧИТАННОЙ ревизии, и гонку между сверкой и удалением закрывает
 * сервер. Не совпал — вставленное правили, и слепой откат унёс бы чужое (P4).
 */

import { gcError, newCorrelationId } from './errors.js';
import type { JournalSource, WriteRecord } from './journal.js';
import { assertRecent, isUndoOutcome, pickUndoRecord } from './undo-shared.js';
import type { UndoOptions, UndoOutcome } from './undo-types.js';
import type {
  DocRangeSnapshot,
  DocRequest,
  DocSnapshot,
  DocTab,
  DocTextRun,
  DocsClient,
} from './docs/types.js';

/** Текст диапазона из абзацев снимка; `null` — диапазон рвётся о таблицу или границы. */
export function textInRange(tab: DocTab, start: number, end: number): string | null {
  let out = '';
  let covered = start;
  for (const paragraph of tab.paragraphs) {
    if (paragraph.endIndex <= start || paragraph.startIndex >= end) continue;
    if (paragraph.inTable !== undefined) return null;
    const withBreak = `${paragraph.text}\n`;
    const from = Math.max(start, paragraph.startIndex);
    if (from !== covered) return null; // дыра: между абзацами лежит таблица или разрыв
    const to = Math.min(end, paragraph.endIndex);
    out += withBreak.slice(from - paragraph.startIndex, to - paragraph.startIndex);
    covered = to;
  }
  return covered === end ? out : null;
}

function docOf(record: WriteRecord): NonNullable<WriteRecord['doc']> {
  if (record.doc === undefined) {
    throw gcError('bad_request', {
      detail:
        `Запись ${record.correlationId} — не правка документа (${record.op}), её откат ` +
        'идёт табличным путём.',
    });
  }
  return record.doc;
}

function assertInsertedIntact(
  snapshot: DocSnapshot,
  record: WriteRecord,
  options: UndoOptions,
): DocTab {
  const doc = docOf(record);
  const tab = snapshot.tabs.find((t) => t.title === doc.tab);
  if (tab === undefined) {
    throw gcError('revision_conflict', {
      detail:
        `Таба «${doc.tab}» в документе больше нет — откат не знает, где искать вставленное. ` +
        'Перечитай документ и реши, что возвращать.',
    });
  }
  if (options.force === true) return tab;
  const current = textInRange(tab, doc.startIndex, doc.endIndex);
  if (current !== (doc.inserted ?? '')) {
    throw gcError('revision_conflict', {
      detail:
        'Вставленное успели править: текст в диапазоне отката уже не тот, что вставляло ' +
        'ядро. Слепой откат унёс бы чужую правку. Осознанный откат — с force.',
      cause: 'inserted_changed',
    });
  }
  return tab;
}

/** След отката в журнале: правка «удалили вставленный диапазон». */
function undoDocRecord(
  record: WriteRecord,
  targetId: string,
  revisionBefore: string | null,
  revisionAfter: string | null,
): WriteRecord {
  const doc = docOf(record);
  return {
    at: new Date().toISOString(),
    account: record.account,
    targetId,
    alias: record.alias,
    sheet: record.sheet,
    op: 'undo',
    changes: [],
    doc: { tab: doc.tab, startIndex: doc.startIndex, endIndex: doc.startIndex },
    revisionBefore,
    revisionAfter,
    correlationId: newCorrelationId(),
    undoOf: record.correlationId,
    ...(record.planId === undefined ? {} : { planId: record.planId }),
  };
}

/**
 * Запросы восстановления снимка: текст одной вставкой, затем стили прогонов и вид
 * абзацев. Базовые флаги (bold/italic/underline/strikethrough) выставляются ЯВНО у
 * каждого прогона — вставленный текст наследует стиль точки вставки, и без явного
 * сброса кусок, бывший обычным, вернулся бы жирным, если жирный сосед слева.
 * Явный false и «поле не задано» — разные состояния модели при одинаковом виде;
 * это названная цена восстановления, а не молчаливое допущение.
 */
export function restoreRequests(tabId: string, snapshot: DocRangeSnapshot): DocRequest[] {
  const text = snapshot.runs.map((r) => r.text).join('');
  return [
    { kind: 'insertText', tabId, at: snapshot.startIndex, text },
    ...runStyleRequests(tabId, snapshot),
    ...paragraphViewRequests(tabId, snapshot),
  ];
}

/** Явные стили каждого прогона — включая сброс базовых флагов (см. док выше). */
function runStyleRequests(tabId: string, snapshot: DocRangeSnapshot): DocRequest[] {
  const requests: DocRequest[] = [];
  let cursor = 0;
  for (const run of snapshot.runs) {
    if (run.text !== '\n' && run.text !== '') {
      requests.push({
        kind: 'updateTextStyle',
        tabId,
        startIndex: snapshot.startIndex + cursor,
        endIndex: snapshot.startIndex + cursor + run.text.length,
        style: explicitStyle(run.style),
      });
    }
    cursor += run.text.length;
  }
  return requests;
}

/** Стиль с явными базовыми флагами: отсутствие поля стало бы наследованием точки вставки. */
function explicitStyle(style: DocTextRun['style']): NonNullable<DocTextRun['style']> {
  const FLAGS = ['bold', 'italic', 'underline', 'strikethrough'] as const;
  const OPTIONAL = ['link', 'fontSize', 'color'] as const;
  const out: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    link?: string;
    fontSize?: number;
    color?: string;
  } = {};
  for (const flag of FLAGS) out[flag] = style?.[flag] ?? false;
  for (const field of OPTIONAL) {
    const value = style?.[field];
    if (value !== undefined) out[field] = value as never;
  }
  return out;
}

/** Вид абзацев снимка: заголовки и списки. */
function paragraphViewRequests(tabId: string, snapshot: DocRangeSnapshot): DocRequest[] {
  const requests: DocRequest[] = [];
  for (const paragraph of snapshot.paragraphs ?? []) {
    const range = {
      tabId,
      startIndex: snapshot.startIndex + paragraph.offset,
      endIndex: snapshot.startIndex + paragraph.offset + 1,
    };
    if (paragraph.namedStyle !== 'NORMAL_TEXT') {
      requests.push({ kind: 'updateParagraphStyle', namedStyle: paragraph.namedStyle, ...range });
    }
    if (paragraph.bulleted === true) {
      requests.push({ kind: 'setBullets', bulleted: true, ...range });
    }
  }
  return requests;
}

/** Откат удаления: вставка снимка на место. Предусловие — ревизия не ушла после записи. */
async function restoreSnapshot(
  client: DocsClient,
  targetId: string,
  record: WriteRecord,
  snapshot: DocSnapshot,
  options: UndoOptions,
): Promise<UndoOutcome> {
  const doc = docOf(record);
  const stored = doc.snapshot!;
  const tab = snapshot.tabs.find((t) => t.title === doc.tab);
  if (tab === undefined) {
    throw gcError('revision_conflict', {
      detail: `Таба «${doc.tab}» больше нет — восстанавливать некуда. Перечитай документ.`,
    });
  }
  if (options.force !== true && record.revisionAfter !== snapshot.revisionId) {
    throw gcError('revision_conflict', {
      detail:
        'После удаления документ правили: точка восстановления могла сдвинуться, и снимок ' +
        `лёг бы не туда (ревизия записи ${record.revisionAfter ?? '—'}, сейчас ` +
        `${snapshot.revisionId}). Осознанный откат — с force.`,
      cause: 'doc_moved_after_delete',
    });
  }
  const { revisionId: revisionAfter } = await client.batchUpdate(
    targetId,
    restoreRequests(tab.tabId, stored),
    snapshot.revisionId,
  );
  if (options.journal !== undefined) {
    await options.journal({
      ...undoDocRecord(
        record,
        targetId,
        snapshot.revisionId,
        revisionAfter === '' ? null : revisionAfter,
      ),
      doc: { tab: doc.tab, startIndex: stored.startIndex, endIndex: stored.endIndex },
    });
  }
  const paragraphs = (stored.paragraphs ?? []).length;
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    docUndone:
      `Удалённое восстановлено в табе «${doc.tab}»: ${stored.endIndex - stored.startIndex} юнитов, ` +
      `${paragraphs} абзац(ев), со стилями текста и видом абзацев (заголовки и списки — тоже).`,
  };
}

/** Откат массовой замены: по снимку позиций, с конца, чтобы сдвиги не портили адреса. */
async function undoReplacements(
  client: DocsClient,
  targetId: string,
  record: WriteRecord,
  snapshot: DocSnapshot,
  options: UndoOptions,
): Promise<UndoOutcome> {
  const doc = docOf(record);
  const replacements = doc.replacements ?? [];
  if (options.force !== true && record.revisionAfter !== snapshot.revisionId) {
    throw gcError('revision_conflict', {
      detail:
        'После замены документ правили: позиции вхождений могли сдвинуться, и откат вернул ' +
        `бы текст не туда (ревизия записи ${record.revisionAfter ?? '—'}, сейчас ` +
        `${snapshot.revisionId}). Осознанный откат — с force.`,
      cause: 'doc_moved_after_replace',
    });
  }
  const requests: DocRequest[] = [];
  for (const item of [...replacements].reverse()) {
    const tab = snapshot.tabs.find((t) => t.title === item.tab);
    if (tab === undefined) {
      throw gcError('revision_conflict', {
        detail: `Таба «${item.tab}» больше нет — откат замены не знает, куда возвращать.`,
      });
    }
    requests.push({
      kind: 'deleteRange',
      tabId: tab.tabId,
      startIndex: item.startIndex,
      endIndex: item.endIndex,
    });
    requests.push(
      ...restoreRequests(tab.tabId, {
        tab: item.tab,
        startIndex: item.startIndex,
        endIndex: item.startIndex,
        runs: item.runs,
      }),
    );
  }
  const { revisionId: revisionAfter } = await client.batchUpdate(
    targetId,
    requests,
    snapshot.revisionId,
  );
  if (options.journal !== undefined) {
    await options.journal(
      undoDocRecord(
        record,
        targetId,
        snapshot.revisionId,
        revisionAfter === '' ? null : revisionAfter,
      ),
    );
  }
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    docUndone:
      `Замена откачена по снимку: ${replacements.length} вхождений вернулись к исходному ` +
      'тексту со стилями; совпадения, бывшие в тексте до правки, не тронуты.',
  };
}

export async function undoDocLast(
  client: DocsClient,
  targetId: string,
  source: JournalSource,
  options: UndoOptions = {},
): Promise<UndoOutcome> {
  const record = await pickUndoRecord(source, targetId, options);
  if (isUndoOutcome(record)) return record;
  assertRecent(record, options);
  const doc = docOf(record);

  const snapshot = await client.getDocument(targetId);
  if (doc.replacements !== undefined) {
    return undoReplacements(client, targetId, record, snapshot, options);
  }
  if (doc.snapshot !== undefined) {
    return restoreSnapshot(client, targetId, record, snapshot, options);
  }
  const tab = assertInsertedIntact(snapshot, record, options);

  // Ревизии документа выдаёт сам Docs API: «до» — из прочитанного снимка, «после» — из
  // ответа записи. Табличный колбэк `readRevision` здесь не годится: он читает не тот API.
  const { revisionId: revisionAfter } = await client.batchUpdate(
    targetId,
    [{ kind: 'deleteRange', tabId: tab.tabId, startIndex: doc.startIndex, endIndex: doc.endIndex }],
    snapshot.revisionId,
  );

  if (options.journal !== undefined) {
    await options.journal(
      undoDocRecord(
        record,
        targetId,
        snapshot.revisionId,
        revisionAfter === '' ? null : revisionAfter,
      ),
    );
  }

  const removed = (doc.inserted ?? '').replace(/^\n/, '');
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    docUndone:
      `Вставленное удалено из таба «${doc.tab}»: «${removed.length > 80 ? `${removed.slice(0, 80)}…` : removed}» ` +
      `(${doc.endIndex - doc.startIndex} юнитов). Соседний текст не тронут.`,
  };
}
