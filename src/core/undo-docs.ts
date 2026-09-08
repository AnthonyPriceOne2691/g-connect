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
import type { DocSnapshot, DocTab, DocsClient } from './docs/types.js';

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
