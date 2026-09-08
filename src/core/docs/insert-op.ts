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

import { gcError } from '../errors.js';
import { assertPlanNotApplied } from '../sheets/write-guards.js';
import type { Question } from '../sheets/write-types.js';
import { docPlanId, type DocPlanChange, type DocPlanShape } from './plan.js';
import { paragraphLabel, pickTab, resolveParagraph, resolveSection } from './selectors.js';
import type { DocParagraph, DocRequest, DocSnapshot, DocTab, DocsClient } from './types.js';
import {
  clarify,
  commitDocWrite,
  narrowSelector,
  permissionRefusal,
  type DocApplyOutcome,
  type DocChangePreview,
  type DocRunOptions,
  type DocWhere,
} from './write-support.js';

export type { DocApplyOutcome, DocChangePreview, DocRunOptions } from './write-support.js';

export interface DocInsertRequest {
  readonly op: 'appendText' | 'insertText' | 'insertPageBreak' | 'insertInlineImage';
  /** Текст вставки; у объектов (разрыв, картинка) его нет. */
  readonly text?: string | undefined;
  /** `insertInlineImage`: URL, доступный Google (см. `assertImageSource`). */
  readonly uri?: string | undefined;
  readonly tab?: string | undefined;
  readonly afterHeading?: string | undefined;
  readonly where?: DocWhere | undefined;
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
  const object = OBJECT_OPS.has(request.op);
  if (request.op === 'insertInlineImage') assertImageSource(request.uri);
  // Объект (разрыв страницы, картинка) занимает РОВНО 1 юнит и текста не несёт.
  const inserted = object ? '\u0001' : `\n${request.text ?? ''}`;
  const shown = shownContent(request, object);
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
        after: shown,
      },
    ],
  };
  const code = docPlanId(plan);
  const changes: DocChangePreview[] = [
    { kind: request.op, tab: tab.title, anchor: anchor.label, before: null, after: shown },
  ];
  const notes = [
    object
      ? `Вставится ${shown}, ${anchor.label}. Откат удалит вставленное, пока его не правили.`
      : `Новых абзацев: ${(request.text ?? '').split('\n').length}, ${anchor.label}. ` +
        'Стиль — как у якорного абзаца.',
  ];

  if (options.dryRun !== false) {
    return { status: 'preview', planId: code, changes, notes, questions: [] };
  }
  return performInsert(
    client,
    snapshot,
    tab.tabId,
    { plan: plan.changes[0]!, code, changes, notes, inserted, uri: request.uri },
    options,
    request.op,
  );
}

/** Вставки объектов: у них нет текста, и мера — один юнит. */
const OBJECT_OPS: ReadonlySet<string> = new Set(['insertPageBreak', 'insertInlineImage']);

/**
 * Источник картинки: только URL, доступный Google — он скачивает файл сам в момент
 * вставки. Локальный путь и `file://` отклоняются ДО обращения к Google, с советом
 * (P19b): загрузка локальных файлов — отдельная поставка (решение владельца 2026-09-08).
 */
function assertImageSource(uri: string | undefined): void {
  if (uri === undefined || uri.trim() === '') {
    throw gcError('bad_request', { detail: 'insertInlineImage требует uri картинки.' });
  }
  const value = uri.trim();
  if (/^https:\/\//i.test(value)) return;
  throw gcError('bad_request', {
    detail:
      `Источник картинки «${value}» Google прочитать не сможет: нужен https-URL, ` +
      'доступный ему самому (публичная ссылка). Локальные файлы и file:// не ' +
      'поддерживаются — загрузка локальных картинок придёт отдельной поставкой.',
    cause: 'image.local-source',
  });
}

interface InsertCommit {
  readonly plan: DocPlanChange;
  readonly inserted: string;
  readonly uri?: string | undefined;
  readonly code: string;
  readonly changes: readonly DocChangePreview[];
  readonly notes: readonly string[];
}

/** Что человек читает в плане: текст вставки или название объекта. */
function shownContent(request: DocInsertRequest, object: boolean): string {
  if (!object) return request.text ?? '';
  return request.op === 'insertPageBreak' ? 'разрыв страницы' : `картинка ${request.uri ?? ''}`;
}

/** Запрос вставки: объект своим видом, текст — текстом. */
function objectOrTextRequest(
  op: DocInsertRequest['op'],
  tabId: string,
  at: number,
  inserted: string,
  uri: string | undefined,
): DocRequest {
  if (op === 'insertPageBreak') return { kind: 'insertPageBreak', tabId, at };
  if (op === 'insertInlineImage') {
    return { kind: 'insertInlineImage', tabId, at, uri: (uri ?? '').trim() };
  }
  return { kind: 'insertText', tabId, at, text: inserted };
}

/** Фаза записи: разрешение (конверт или код), однократность, запись, журнал. */
async function performInsert(
  client: DocsClient,
  snapshot: DocSnapshot,
  tabId: string,
  commit: InsertCommit,
  options: DocRunOptions,
  op: DocInsertRequest['op'],
): Promise<DocApplyOutcome> {
  const { plan, code, changes, notes, inserted } = commit;
  // Однократность судится по ПЕРЕДАННОМУ коду и раньше сверки с новым планом: повтор
  // «пиши abc123» должен получить «уже записано», а не свежий код с приглашением
  // записать то же второй раз (тот же порядок, что у таблиц, B20/B21).
  await assertPlanNotApplied(options, options.confirm ?? null, snapshot.docId);
  const refusal = permissionRefusal(options, op, inserted.length, commit);
  if (refusal !== null) return refusal;

  return commitDocWrite(
    client,
    snapshot,
    {
      op,
      tabTitle: plan.tab,
      code,
      changes,
      notes,
      requests: [objectOrTextRequest(op, tabId, plan.startIndex, inserted, commit.uri)],
      doc: { tab: plan.tab, startIndex: plan.startIndex, endIndex: plan.endIndex, inserted },
    },
    options,
  );
}
