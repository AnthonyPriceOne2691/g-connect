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
import type { DocReplacement, JournalSource, WriteRecord } from './journal.js';
import { assertRecent, isUndoOutcome, pickUndoRecord } from './undo-shared.js';
import type { UndoOptions, UndoOutcome } from './undo-types.js';
import { tableUndoRequests } from './undo-docs-table.js';
import { exactStyleRequests } from './docs/style-restore.js';
import {
  OBJECT_MARK,
  type DocRangeSnapshot,
  type DocRequest,
  type DocSnapshot,
  type DocTab,
  type DocsClient,
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
  const tab = tabOrConflict(snapshot, doc.tab);
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
 * Запросы восстановления снимка: текст одной вставкой, затем точные стили прогонов и вид
 * абзацев. Вставка наследует стиль точки вставки и вид абзаца, в который легла, — поэтому
 * и то и другое задаётся явно у КАЖДОГО прогона и абзаца (см. `exactStyleRequests`).
 */
export function restoreRequests(tabId: string, snapshot: DocRangeSnapshot): DocRequest[] {
  const text = snapshot.runs.map((r) => r.text).join('');
  return [
    { kind: 'insertText', tabId, at: snapshot.startIndex, text },
    ...exactStyleRequests(tabId, snapshot.startIndex, snapshot.runs),
    ...paragraphViewRequests(tabId, snapshot),
  ];
}

/**
 * Вид абзацев снимка — БЕЗУСЛОВНО, в том числе NORMAL_TEXT и «без списка». Восстановленный
 * абзац ложится в начало следующего и наследует ЕГО вид: обычный абзац перед заголовком
 * вернулся бы заголовком. Одна функция на откат удаления и откат стилей — две копии этой
 * мысли уже разошлись однажды (найдено чтением 2026-10-01, класс L21).
 */
function paragraphViewRequests(tabId: string, snapshot: DocRangeSnapshot): DocRequest[] {
  const requests: DocRequest[] = [];
  for (const paragraph of snapshot.paragraphs ?? []) {
    const range = {
      tabId,
      startIndex: snapshot.startIndex + paragraph.offset,
      endIndex: snapshot.startIndex + paragraph.offset + 1,
    };
    requests.push({ kind: 'updateParagraphStyle', namedStyle: paragraph.namedStyle, ...range });
    requests.push({ kind: 'setBullets', bulleted: paragraph.bulleted === true, ...range });
  }
  return requests;
}

type StoredSnapshot = NonNullable<NonNullable<WriteRecord['doc']>['snapshot']>;

/**
 * Откат по снимку — одна форма на удаление и стили: пролог (снимок, живой таб, ревизия не
 * ушла после записи) и хвост записи общие, различаются код отказа, запросы и итог. Две
 * рукописные копии этой формы были clone-парой в DRY-снимке; владелец 2026-10-17 решил
 * убрать её, а не узаконить.
 */
function snapshotUndo(
  movedCause: string,
  movedWhat: string,
  build: (tab: DocTab, stored: StoredSnapshot) => { requests: DocRequest[]; done: string },
): DocUndoForm {
  return async (client, targetId, record, snapshot, options) => {
    const { tab, stored } = storedAndTab(record, snapshot);
    assertNotMoved(record, snapshot, options, movedCause, movedWhat);
    const { requests, done } = build(tab, stored);
    return finishDocUndo(client, targetId, record, snapshot, requests, options, done);
  };
}

/** Откат удаления: вставка снимка на место. Предусловие — ревизия не ушла после записи. */
const restoreSnapshot = snapshotUndo('doc_moved_after_delete', 'удаления', (tab, stored) => ({
  requests: restoreRequests(tab.tabId, stored),
  done:
    `Удалённое восстановлено в табе «${stored.tab}»: ${stored.endIndex - stored.startIndex} юнитов, ` +
    `${(stored.paragraphs ?? []).length} абзац(ев), со стилями текста и видом абзацев ` +
    '(заголовки и списки — тоже).',
}));

/** Откат массовой замены: по снимку позиций, с конца, чтобы сдвиги не портили адреса. */
/**
 * Вхождение стоит там, где его записали, — проверка и ПОД force: force значит «документ
 * правили в другом месте, я понимаю», а не «пиши не глядя». Без неё откат по сдвинутым
 * позициям стирал чужой текст и объявлял «вернулось» (находка читателя 2026-10-01).
 */
function assertReplacementInPlace(tab: DocTab, item: DocReplacement): void {
  if (item.written === undefined) return;
  const current = textInRange(tab, item.startIndex, item.endIndex);
  if (current === item.written) return;
  throw gcError('revision_conflict', {
    detail:
      `В табе «${item.tab}» на месте замены (${item.startIndex}–${item.endIndex}) уже не ` +
      `«${item.written}», а «${current ?? '—'}»: документ сдвинули, и откат по позициям лёг бы ` +
      'не туда. force тут не поможет — перечитай документ и верни текст руками.',
    cause: 'replacement_moved',
  });
}

async function undoReplacements(
  client: DocsClient,
  targetId: string,
  record: WriteRecord,
  snapshot: DocSnapshot,
  options: UndoOptions,
): Promise<UndoOutcome> {
  const doc = docOf(record);
  const replacements = doc.replacements ?? [];
  assertNotMoved(record, snapshot, options, 'doc_moved_after_replace', 'замены');
  const requests: DocRequest[] = [];
  for (const item of [...replacements].reverse()) {
    const tab = snapshot.tabs.find((t) => t.title === item.tab);
    if (tab === undefined) {
      throw gcError('revision_conflict', {
        detail: `Таба «${item.tab}» больше нет — откат замены не знает, куда возвращать.`,
      });
    }
    assertReplacementInPlace(tab, item);
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
  return finishDocUndo(
    client,
    targetId,
    record,
    snapshot,
    requests,
    options,
    `Замена откачена по снимку: ${replacements.length} вхождений вернулись к исходному ` +
      'тексту со стилями; совпадения, бывшие в тексте до правки, не тронуты.',
  );
}

/** Откат табличной правки: обратная структурная операция плюс возврат содержимого. */
async function undoTable(
  client: DocsClient,
  targetId: string,
  record: WriteRecord,
  snapshot: DocSnapshot,
  options: UndoOptions,
): Promise<UndoOutcome> {
  const doc = docOf(record);
  assertNotMoved(record, snapshot, options, 'doc_moved_after_table', 'табличной правки');
  const { requests, undone } = tableUndoRequests(snapshot, doc.tab, doc.table!);
  return finishDocUndo(client, targetId, record, snapshot, requests, options, undone);
}

/** После правки документ трогали — точки отката могли сдвинуться (общий отказ). */
export function assertNotMoved(
  record: WriteRecord,
  snapshot: DocSnapshot,
  options: UndoOptions,
  cause: string,
  what: string,
): void {
  if (options.force === true || record.revisionAfter === snapshot.revisionId) return;
  throw gcError('revision_conflict', {
    detail:
      `После ${what} документ правили: позиции могли сдвинуться (ревизия записи ` +
      `${record.revisionAfter ?? '—'}, сейчас ${snapshot.revisionId}). Осознанный откат — с force.`,
    cause,
  });
}

/** Хвост любого doc-отката: запись под предусловием, след в журнале, ответ. */
export async function finishDocUndo(
  client: DocsClient,
  targetId: string,
  record: WriteRecord,
  snapshot: DocSnapshot,
  requests: readonly DocRequest[],
  options: UndoOptions,
  docUndone: string,
): Promise<UndoOutcome> {
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
    docUndone,
  };
}

/**
 * Откат правки стилей: текст не менялся — накатываем ПРЕЖНИЕ поля из снимка, без вставок
 * и удалений. Стили и вид возвращаются БЕЗУСЛОВНО (в т.ч. NORMAL_TEXT и «без списка»):
 * пропуск «обычных» значений оставил бы новый заголовок заголовком.
 */
const undoStyles = snapshotUndo('doc_moved_after_style', 'правки стилей', (tab, stored) => ({
  requests: [
    ...exactStyleRequests(tab.tabId, stored.startIndex, stored.runs),
    ...paragraphViewRequests(tab.tabId, stored),
  ],
  done: `Стили возвращены: ${(stored.paragraphs ?? []).length} абзац(ев), текст не тронут.`,
}));

/** Снимок «до» и живой таб записи — общий пролог откатов по снимку. */
function storedAndTab(
  record: WriteRecord,
  snapshot: DocSnapshot,
): { tab: DocTab; stored: StoredSnapshot } {
  const doc = docOf(record);
  return { tab: tabOrConflict(snapshot, doc.tab), stored: doc.snapshot! };
}

/** Таб записи — или честный отказ: документ изменился, и откат не знает, куда возвращать. */
function tabOrConflict(snapshot: DocSnapshot, tabTitle: string): DocTab {
  const tab = snapshot.tabs.find((t) => t.title === tabTitle);
  if (tab === undefined) {
    throw gcError('revision_conflict', {
      detail: `Таба «${tabTitle}» больше нет — откат не знает, куда возвращать. Перечитай документ.`,
    });
  }
  return tab;
}

type DocUndoForm = (
  client: DocsClient,
  targetId: string,
  record: WriteRecord,
  snapshot: DocSnapshot,
  options: UndoOptions,
) => Promise<UndoOutcome>;

/** Форма отката по журнальной записи; `null` — вставка (базовый путь ниже). */
function docUndoForm(doc: NonNullable<WriteRecord['doc']>): DocUndoForm | null {
  if (doc.styled === true) return undoStyles;
  if (doc.table !== undefined) return undoTable;
  if (doc.replacements !== undefined) return undoReplacements;
  if (doc.snapshot !== undefined) return restoreSnapshot;
  return null;
}

/**
 * Ревизия, на которой документ «стоит» для этой записи. Свои откаты более поздних записей
 * его не сдвигают: если всё, что в журнале после записи, — пары «правка + её откат»,
 * документ вернулся туда, где был, и сверять надо с ревизией последнего такого отката.
 * Находка читателя 2026-10-01: второй «откати» подряд отказывал из-за собственного
 * первого, и выходом оставался force, снимающий ВСЕ охранники. Честной эту сверку делает
 * точность откатов (LR3-2…4): отменённая пара возвращает документ ровно как был.
 */
async function settledRevision(
  source: JournalSource,
  targetId: string,
  record: WriteRecord,
): Promise<string | null> {
  const history = await source.recent(targetId, 50);
  const at = history.findIndex((r) => r.correlationId === record.correlationId);
  if (at < 0) return record.revisionAfter;
  const after = history.slice(at + 1);
  const laterWrites = new Set(after.filter((r) => r.op !== 'undo').map((r) => r.correlationId));
  const undone = new Set(after.filter((r) => r.op === 'undo').map((r) => r.undoOf));
  const settled =
    [...laterWrites].every((id) => undone.has(id)) &&
    after.every((r) => r.op !== 'undo' || laterWrites.has(r.undoOf ?? ''));
  if (!settled) return record.revisionAfter;
  const undos = after.filter((r) => r.op === 'undo');
  return undos[undos.length - 1]?.revisionAfter ?? record.revisionAfter;
}

export async function undoDocLast(
  client: DocsClient,
  targetId: string,
  source: JournalSource,
  options: UndoOptions = {},
): Promise<UndoOutcome> {
  const picked = await pickUndoRecord(source, targetId, options);
  if (isUndoOutcome(picked)) return picked;
  assertRecent(picked, options);
  const record = { ...picked, revisionAfter: await settledRevision(source, targetId, picked) };
  const doc = docOf(record);

  const snapshot = await client.getDocument(targetId);
  const form = docUndoForm(doc);
  if (form !== null) return form(client, targetId, record, snapshot, options);
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

  // Объект в следе вставки — знак OBJECT_MARK; человеку он ничего не скажет.
  const removed = (doc.inserted ?? '').replace(/^\n/, '').split(OBJECT_MARK).join('[объект]');
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
