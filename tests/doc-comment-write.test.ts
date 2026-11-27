/**
 * Свои комментарии Google (27.11): ответ в ветке и свой комментарий — `gc_apply`, откат — `gc_undo`,
 * через настоящий протокол (T41), как у живого клиента. Шов судится на форме запросов Google (урок
 * L28): фейк клиента параметров запроса не видит. Примеры — Z10…Z19.
 */

import type { drive_v3 } from 'googleapis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gcError } from '../src/core/errors.js';
import { newGrant } from '../src/core/grant/document.js';
import { GoogleDriveClient } from '../src/core/google/drive.js';
import {
  COMMENT_FIELDS,
  type CommentReply,
  type FileComment,
} from '../src/core/google/drive-comments.js';
import type { WriteRecord } from '../src/core/journal.js';
import type { Registry } from '../src/core/targets.js';
import { applyInput } from '../src/mcp/apply-schema.js';
import { undoComment } from '../src/core/undo-comments.js';
import { gcApply, gcUndo, type ToolDeps, type ToolResult } from '../src/mcp/tools.js';
import { buildDoc, FakeDocsClient, forecastDoc, p } from './fixtures/doc.js';
import { FakeDriveClient, ME } from './fixtures/drive.js';
import { callMcp } from './fixtures/protocol.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

const DOC = 'DOC0000000000000000001';
const LINK = `https://docs.google.com/document/d/${DOC}/edit`;
const PROJECT = '/tmp/проект-комментарии';
const THREAD = 'AAAAthread01';
const QUOTE = 'Ставим на победу Fluminense со счётом 2:1.';
/** Поля ветки — без `fields` Drive отказывает (comments.get). */
const THREAD_FIELDS =
  'id,author(displayName,me),content,createdTime,modifiedTime,resolved,deleted,' +
  'quotedFileContent(mimeType,value),replies(id,author(displayName,me),content,' +
  'createdTime,modifiedTime,action,deleted)';

/** Ветка заказчика к абзацу прогноза — открыта, без ответов. */
const customer = (over: Partial<FileComment> = {}): FileComment => ({
  id: THREAD,
  author: 'Заказчик',
  me: false,
  createdTime: '2026-11-27T09:00:00.000Z',
  modifiedTime: '2026-11-27T09:00:00.000Z',
  text: 'Уточните счёт',
  resolved: false,
  quote: QUOTE,
  replies: [],
  ...over,
});

const theirs = (id: string, over: Partial<CommentReply> = {}): CommentReply => ({
  id,
  author: 'Заказчик',
  me: false,
  createdTime: null,
  modifiedTime: null,
  text: 'Спасибо',
  ...over,
});

interface Outcome {
  status: string;
  planId: string;
  changes: unknown[];
  notes: string[];
  questions: unknown[];
  thread?: unknown;
  correlationId?: string;
  target: unknown;
}

interface Undone {
  status: string;
  restored: unknown[];
  docUndone?: string;
  notRestored?: string[];
  hint: string;
}

/** Что ответ говорит о каждом своём комментарии — дословно: это текст для человека (правило). */
const UNANCHORED_TEXT =
  'Docs покажет комментарий в «Все комментарии» без привязки к тексту: комментарий, созданный ' +
  'через API, редактор к тексту не привязывает (документация Drive) — цитата идёт в самом ' +
  'комментарии. Скажи это человеку.';
const PEOPLE_TEXT =
  'Это сообщение людям: комментарий видят все, у кого есть доступ к документу, и Google может ' +
  'уведомить о нём. Откат — gc_undo: удалит комментарий, пока в его ветке нет чужих ответов; ' +
  'уведомление откат не вернёт.';

/** Сессия проекта под разрешением (конверт по умолчанию); реестр — для цели со своим правом. */
function harness(registry: Registry = { targets: [] }, doc = forecastDoc()) {
  const drive = new FakeDriveClient();
  drive.comments.set(DOC, [customer()]);
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    project: PROJECT,
    grant: () =>
      Promise.resolve({ state: 'granted', grant: newGrant(PROJECT, 'default', new Date()) }),
    sheets: () => Promise.reject(new TypeError('таблиц в этом сьюте нет')),
    docs: () => Promise.resolve(new FakeDocsClient(doc)),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve(registry),
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve(null),
  };
  return {
    deps,
    drive,
    journalled,
    apply: (args: Record<string, unknown>) => callMcp(gcApply, { target: LINK, ...args }, deps),
    undo: (args: Record<string, unknown> = {}) => callMcp(gcUndo, { target: LINK, ...args }, deps),
    threads: () => drive.comments.get(DOC)!,
  };
}

const data = <T>(result: ToolResult): T => {
  expect(result.error).toBeUndefined();
  return result.data as T;
};

const reply = { op: 'replyComment', commentId: THREAD, text: 'Поправил на 2:0', resolve: true };

describe('Z10–Z15 — ответ и свой комментарий через gc_apply', () => {
  it('Z10: превью ответа — ветка данными (автор, текст, цитата, resolved), ответ и код плана; уведомление названо; записи нет', async () => {
    const h = harness();
    const plan = data<Outcome>(await h.apply(reply));
    expect(plan.status).toBe('preview');
    expect(plan.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(plan.thread).toEqual({
      kind: 'data',
      origin: `ветка ${THREAD} файла ${DOC}`,
      value: {
        id: THREAD,
        author: 'Заказчик',
        text: 'Уточните счёт',
        quote: QUOTE,
        resolved: false,
        replies: 0,
      },
    });
    expect(plan.changes).toEqual([
      {
        kind: 'replyComment',
        tab: '',
        anchor: `ветка ${THREAD}`,
        before: null,
        after: 'Поправил на 2:0',
      },
    ]);
    expect(plan.notes).toEqual([
      `Ответ в ветке ${THREAD}. Google уведомит её участников: это сообщение людям, а не правка ` +
        'текста, и откат уведомление не вернёт.',
      'Ответ закроет ветку (resolve) — в Docs она уйдёт в закрытые.',
      'Откат — gc_undo: удалит ответ и откроет ветку снова, если её не трогали после нас.',
    ]);
    expect(plan.questions).toEqual([]);
    expect(plan.target).toEqual({ id: DOC, alias: null });
    expect(h.drive.calls).toEqual(['getComment']);
    expect(h.journalled).toHaveLength(0);
    // Код плана — от содержимого: другой текст или ответ без resolve — другой план.
    const plain = data<Outcome>(await h.apply({ ...reply, resolve: undefined }));
    const other = data<Outcome>(await h.apply({ ...reply, text: 'Поправил на 3:0' }));
    expect(new Set([plan.planId, plain.planId, other.planId]).size).toBe(3);
    expect(plain.notes.at(-1)).toBe('Откат — gc_undo: удалит ответ.');
    expect(plain.notes).toHaveLength(2);
  });

  it('Z11: под разрешением проекта — с первой фразы, без кода; мера — юниты текста (80 > maxCells); журнал знает ответ и открытую до него ветку; длиннее 1000 юнитов — код плана', async () => {
    const h = harness();
    const text = 'Счёт поправлен на 2:0, составы сверены. '.repeat(2);
    const done = data<Outcome>(await h.apply({ ...reply, text, dryRun: false }));
    expect(done.status).toBe('ok');
    const [thread] = h.threads();
    const replyId = thread!.replies[0]!.id;
    expect(thread).toMatchObject({ resolved: true, replies: [{ text, action: 'resolve' }] });
    expect(h.journalled).toEqual([
      {
        at: expect.any(String),
        account: 'default',
        targetId: DOC,
        alias: null,
        sheet: '',
        op: 'replyComment',
        changes: [],
        comment: { commentId: THREAD, replyId, text, resolved: true, resolvedBefore: false },
        revisionBefore: null,
        revisionAfter: null,
        correlationId: done.correlationId,
        planId: done.planId,
        project: PROJECT,
      },
    ]);
    expect(done.notes.at(-1)).toBe(
      `Записано: ответ ${replyId} в ветке ${THREAD}. Скажи человеку, что оставлено, и что ` +
        `откатить можно одной фразой: gc_undo по этой цели (запись ${done.correlationId}).`,
    );
    const long = 'я'.repeat(1001);
    // Ветка уже закрыта нашим ответом — длинный ответ без resolve.
    for (const ask of [
      { op: 'addComment', text: long },
      { ...reply, text: long, resolve: undefined },
    ]) {
      const refused = data<Outcome>(await h.apply({ ...ask, dryRun: false }));
      expect(refused.status).toBe('confirm_required');
      expect(refused.notes.join(' ')).toContain('1001 юнитов текста');
    }
    expect(h.drive.calls.filter((call) => call.startsWith('create'))).toEqual(['createReply']);
  });

  it('Z12: цель реестра без конверта — confirm_required с кодом; запись — кодом человека; тот же код второй раз — plan_already_applied', async () => {
    const h = harness({ targets: [{ alias: 'прогноз', id: DOC, type: 'doc', allow: 'write' }] });
    const ask = { op: 'addComment', target: 'прогноз', text: 'Проверьте составы', dryRun: false };
    const refused = data<Outcome>(await h.apply(ask));
    expect(refused.status).toBe('confirm_required');
    expect(refused.notes.join(' ')).toContain(`пиши ${refused.planId}`);
    expect(h.drive.calls).not.toContain('createComment');
    const written = data<Outcome>(await h.apply({ ...ask, confirm: refused.planId }));
    expect(written.notes.at(-1)).toContain(`Записано: комментарий ${h.threads()[1]!.id}.`);
    const again = await h.apply({ ...ask, confirm: refused.planId });
    expect(again.error).toMatchObject({ code: 'plan_already_applied' });
    expect(h.threads()).toHaveLength(2);
  });

  it('Z13: ветки нет или её удалили — not_found с подсказкой, откуда id; записи нет', async () => {
    const h = harness();
    const missing = await h.apply({ ...reply, commentId: 'AAAAnone' });
    expect(missing.error).toMatchObject({
      code: 'not_found',
      cause: 'comment_not_found',
      detail:
        `Комментария AAAAnone в файле ${DOC} нет или его удалили — отвечать некуда. ` +
        'id — из gc_read mode=comments.',
    });
    await h.drive.deleteComment(DOC, THREAD);
    const deleted = await h.apply({ ...reply, dryRun: false });
    expect(deleted.error).toMatchObject({ code: 'not_found', cause: 'comment_not_found' });
    expect(h.drive.calls).not.toContain('createReply');
    // Другая ошибка Drive — как есть: «нет доступа» не выдаётся за «ветки нет».
    h.drive.getComment = () => Promise.reject(gcError('forbidden', { detail: 'нет доступа' }));
    expect((await h.apply(reply)).error).toMatchObject({
      code: 'forbidden',
      detail: 'нет доступа',
    });
  });

  it('Z14: пустой ответ, fragment или tab без where — отказ до Google; закрытая ветка с resolve — отказ без записи', async () => {
    const h = harness();
    const blind: ToolDeps = {
      ...h.deps,
      drive: () => Promise.reject(new TypeError('к Drive ходить нельзя')),
      docs: () => Promise.reject(new TypeError('документ читать нельзя')),
    };
    const refusal = async (args: Record<string, unknown>) =>
      (await callMcp(gcApply, { target: LINK, ...args }, blind)).error?.detail;
    expect(await refusal({ op: 'replyComment', commentId: THREAD })).toContain(
      'text: нужен text ответа или resolve: true — закрыть ветку без текста',
    );
    for (const loose of [{ fragment: 'Fluminense' }, { tab: 'Прогноз' }]) {
      expect(await refusal({ op: 'addComment', text: 'x', ...loose })).toContain(
        'where: fragment и tab — про абзац цитаты; без where комментарий ко всему документу',
      );
    }
    h.drive.putComment(DOC, customer({ resolved: true }));
    const twice = await h.apply({ ...reply, text: undefined, dryRun: false });
    expect(twice.error).toMatchObject({
      code: 'bad_request',
      cause: 'comment_already_resolved',
      detail: `Ветка ${THREAD} уже закрыта — закрывать нечего; ответ в ней — без resolve.`,
    });
    expect(h.drive.calls).not.toContain('createReply');
  });

  it('Z14: описания полей и gc_apply — их читает модель — называют, откуда id, что это сообщения людям и что без привязки', () => {
    expect(applyInput.commentId.description).toBe(
      'replyComment: id ветки комментариев — из gc_read mode=comments',
    );
    expect(applyInput.resolve.description).toBe(
      'replyComment: закрыть ветку ответом (resolve); без text — только закрыть',
    );
    expect(applyInput.text.description).toBe(
      'appendText/insertText: текст НОВОГО абзаца; addComment/replyComment: текст комментария ' +
        'или ответа — его получат люди',
    );
    expect(applyInput.fragment.description).toBe(
      'Точная фраза внутри абзаца where (как в gc_read mode=text), одна в абзаце, иначе отказ без ' +
        'записи. updateTextStyle: стиль ложится только на неё, count с ней — 1. addComment: цитата ' +
        'комментария; без неё — абзац целиком, без where — комментарий ко всему документу',
    );
    expect(applyInput.where.description).toContain('; у addComment — абзац цитаты');
    expect(gcApply.description).toContain(
      'Комментарии Google в документе: op=replyComment — ответ в ветке (commentId из gc_read ' +
        'mode=comments; text и/или resolve: true), op=addComment — свой комментарий (where и ' +
        'fragment — цитата). Это сообщения людям: Google о них уведомляет, а Docs показывает такой ' +
        'комментарий в «Все комментарии» без привязки к тексту',
    );
    expect(gcApply.description).toContain(
      'подсвети следом updateTextStyle с теми же where и fragment и style.background (откат — ' +
        'gc_undo дважды: подсветка, комментарий)',
    );
  });

  it('Z15: addComment — цитата фразой where+fragment или абзацем; без where — ко всему документу и без чтения документа; превью честно говорит «без привязки»', async () => {
    const h = harness();
    const where = { textStartsWith: 'Ставим на победу' };
    const ask = { op: 'addComment', tab: 'Прогноз', where, fragment: 'Fluminense', text: 'Точно?' };
    const plan = data<Outcome>(await h.apply(ask));
    const label = 'абзац № 18: Ставим на победу Fluminense со счётом…';
    expect(plan.changes).toEqual([
      { kind: 'addComment', tab: 'Прогноз', anchor: label, before: null, after: 'Точно?' },
    ]);
    expect(plan.notes).toEqual([
      `Комментарий с цитатой «Fluminense» (${label}).`,
      UNANCHORED_TEXT,
      PEOPLE_TEXT,
    ]);
    // Абзац — тем же селектором, что у правок: неоднозначный или пустой — вопрос, а не догадка.
    for (const vague of [{ textContains: 'Fluminense' }, {}]) {
      const asked = data<Outcome>(await h.apply({ ...ask, where: vague, fragment: undefined }));
      expect(asked.status).toBe('needs_clarification');
      expect(asked.questions).toHaveLength(1);
    }
    const written = data<Outcome>(await h.apply({ ...ask, dryRun: false }));
    const made = h.threads().at(-1)!;
    expect(made).toMatchObject({ me: true, quote: 'Fluminense', text: 'Точно?' });
    expect(h.journalled.at(-1)?.comment).toEqual({
      commentId: made.id,
      text: 'Точно?',
      quote: 'Fluminense',
    });
    // Тот же текст к другой цитате — другой план, а не «уже записано».
    const elsewhere = data<Outcome>(await h.apply({ ...ask, fragment: '2:1', dryRun: false }));
    expect(elsewhere.planId).not.toBe(written.planId);
    data(await h.apply({ op: 'addComment', tab: 'Прогноз', where, text: 'Абзац', dryRun: false }));
    expect(h.threads().at(-1)?.quote).toBe(QUOTE);
    const blind = { ...h.deps, docs: () => Promise.reject(new TypeError('читать не нужно')) };
    const whole = { op: 'addComment', target: LINK, text: 'Всем', dryRun: false };
    const all = data<Outcome>(await callMcp(gcApply, whole, blind));
    expect(all.changes).toEqual([
      { kind: 'addComment', tab: '', anchor: 'весь документ', before: null, after: 'Всем' },
    ]);
    expect(all.notes[0]).toBe('Комментарий ко всему документу, без цитаты.');
    expect(h.threads().at(-1)).not.toHaveProperty('quote');
    const absent = await h.apply({ ...ask, fragment: 'Palmeiras' });
    expect(absent.error).toMatchObject({ code: 'bad_request', cause: 'fragment_not_found' });
    // Абзац из одних пробелов цитировать нечего — отказ, а не комментарий с пустой цитатой.
    const blank = harness(undefined, buildDoc({ tabs: [{ title: 'Т', content: [p('   ')] }] }));
    const first = { op: 'addComment', where: { firstParagraph: true }, text: 'x' };
    expect((await blank.apply(first)).error).toMatchObject({
      code: 'bad_request',
      cause: 'empty_quote',
      detail: 'Абзац № 1:  пуст — цитировать нечего; без where — ко всему.',
    });
  });
});

describe('Z16–Z17, Z19 — откат своего через gc_undo', () => {
  it('Z16: свой комментарий удалён; ответил другой — policy_denied, комментарий на месте; удалили в Docs — «уже нет», запись откачена', async () => {
    const h = harness();
    const first = data<Outcome>(await h.apply({ op: 'addComment', text: 'Первый', dryRun: false }));
    const undone = data<Undone>(await h.undo());
    expect(undone.status).toBe('ok');
    expect(undone.docUndone).toBe('Комментарий «Первый» удалён вместе со своей веткой.');
    expect(undone.restored).toEqual([]);
    expect(undone.hint).toContain('«Первый» удалён');
    expect(h.threads().map((c) => c.id)).toEqual([THREAD]);
    expect(h.journalled.at(-1)).toEqual({
      op: 'undo',
      undoOf: first.correlationId,
      correlationId: expect.stringMatching(/^gc-/),
      at: expect.any(String),
      account: 'default',
      targetId: DOC,
      alias: null,
      sheet: '',
      changes: [],
      revisionBefore: null,
      revisionAfter: null,
      planId: first.planId,
      project: PROJECT,
    });

    data(await h.apply({ op: 'addComment', text: 'Второй', dryRun: false }));
    const ours = h.threads().at(-1)!;
    const mine = { ...theirs('RPL-наш'), author: ME, me: true };
    h.drive.putComment(DOC, { ...ours, replies: [mine, theirs('RPL-их')] });
    const refused = await h.undo();
    expect(refused.error).toMatchObject({
      code: 'policy_denied',
      cause: 'write.comment-undo-own-only',
    });
    expect(refused.error?.detail).toContain(
      `В ветке комментария ${ours.id} ответили другие (1): Drive удаляет ветку целиком, и откат ` +
        'унёс бы их ответы. Комментарий на месте; удалить ветку с чужими ответами может человек ' +
        'в Docs, закрыть её — replyComment с resolve: true.',
    );
    expect(h.threads()).toContainEqual(expect.objectContaining({ id: ours.id }));

    await h.drive.deleteComment(DOC, ours.id);
    const gone = data<Undone>(await h.undo());
    expect(gone.docUndone).toBe(`Комментария ${ours.id} уже нет — его удалили в Docs.`);
    expect(data<Undone>(await h.undo()).status).toBe('nothing_to_undo');

    // Длинный текст в ответе отката — первыми 60 знаками.
    const long = `${'а'.repeat(60)}хвост`;
    data(await h.apply({ op: 'addComment', text: long, dryRun: false }));
    expect(data<Undone>(await h.undo()).docUndone).toContain(`«${'а'.repeat(60)}…»`);
  });

  it('Z17: ответ с resolve удалён, ветка открыта снова (reopen); Drive открыл её сам — reopen не нужен; после нас её трогали — не открываем и говорим', async () => {
    const h = harness();
    h.drive.putComment(DOC, customer({ replies: [theirs('R-до')] }));
    data(await h.apply({ ...reply, dryRun: false }));
    // Заказчик потом просто ответил текстом — закрытие ветки всё ещё наше.
    const closed = h.threads()[0]!;
    h.drive.putComment(DOC, { ...closed, replies: [...closed.replies, theirs('R0')] });
    const reopened = data<Undone>(await h.undo());
    expect(reopened.docUndone).toBe(
      `Ответ «Поправил на 2:0» удалён из ветки ${THREAD}. Ответ закрывал ветку — она открыта ` +
        'снова (reopen), как до него.',
    );
    expect(h.threads()[0]).toMatchObject({
      resolved: false,
      replies: [{ id: 'R-до' }, { id: 'R0' }, { me: true, action: 'reopen' }],
    });

    h.drive.putComment(DOC, customer());
    data(await h.apply({ ...reply, text: undefined, dryRun: false }));
    const deleteReply = h.drive.deleteReply.bind(h.drive);
    h.drive.deleteReply = async (fileId, commentId, replyId) => {
      await deleteReply(fileId, commentId, replyId);
      h.drive.putComment(DOC, { ...h.threads()[0]!, resolved: false });
    };
    expect(data<Undone>(await h.undo()).docUndone).toBe(
      `Ответ «закрыть ветку» удалён из ветки ${THREAD}. Ветка открыта, как до ответа.`,
    );
    expect(h.threads()[0]!.replies).toEqual([]);

    h.drive.deleteReply = deleteReply;
    data(await h.apply({ ...reply, dryRun: false }));
    const after = { ...h.threads()[0]! };
    h.drive.putComment(DOC, {
      ...after,
      replies: [
        ...after.replies,
        theirs('R2', { action: 'reopen' }),
        theirs('R3', { action: 'resolve' }),
      ],
    });
    const touched = data<Undone>(await h.undo());
    expect(touched.notRestored).toEqual([
      'ветка не открыта снова: после нашего ответа её закрывали или открывали',
    ]);
    expect(h.threads()[0]).toMatchObject({ resolved: true, replies: [{ id: 'R2' }, { id: 'R3' }] });
  });

  it('Z17: ответ без resolve — удалён без reopen; удалённый в Docs — «уже нет»; чужой ответ по записи — отказ', async () => {
    const h = harness();
    data(await h.apply({ ...reply, resolve: undefined, text: 'Да', dryRun: false }));
    expect(data<Undone>(await h.undo()).docUndone).toBe(`Ответ «Да» удалён из ветки ${THREAD}.`);
    data(await h.apply({ ...reply, resolve: undefined, text: 'Ещё', dryRun: false }));
    const [ours] = h.threads()[0]!.replies;
    await h.drive.deleteReply(DOC, THREAD, ours!.id);
    const gone = data<Undone>(await h.undo());
    expect(gone.docUndone).toBe(`Ответа ${ours!.id} уже нет — его удалили в Docs.`);
    h.drive.putComment(DOC, customer({ replies: [theirs('R1')] }));
    const forged = { ...h.journalled[0]!, correlationId: 'gc-forged' };
    h.journalled.push({ ...forged, comment: { commentId: THREAD, replyId: 'R1' } });
    const refused = await h.undo({ record: 'gc-forged' });
    expect(refused.error).toMatchObject({ cause: 'write.comment-undo-own-only' });
    expect(refused.error?.detail).toContain(
      'Ответ R1 оставлен не этим профилем — откат удаляет только своё.',
    );
    expect(h.threads()[0]!.replies).toHaveLength(1);
    // Ветку целиком удалили в Docs — нашего ответа в ней тоже нет.
    data(await h.apply({ ...reply, resolve: undefined, text: 'Третий', dryRun: false }));
    const third = h.threads()[0]!.replies.at(-1)!;
    await h.drive.deleteComment(DOC, THREAD);
    const lost = data<Undone>(await h.undo());
    expect(lost.docUndone).toBe(`Ответа ${third.id} уже нет — его удалили в Docs.`);
  });

  it('Z19: запись другого проекта или профиля по id — отказ; цель голым ID — откат тем же путём', async () => {
    const h = harness();
    const done = data<Outcome>(await h.apply({ op: 'addComment', text: 'Мой', dryRun: false }));
    const record = h.journalled[0]!;
    h.journalled.push(
      { ...record, correlationId: 'gc-foreign', project: '/tmp/чужой' },
      { ...record, correlationId: 'gc-work', account: 'work' },
    );
    const foreign = await h.undo({ record: 'gc-foreign' });
    expect(foreign.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-project' });
    const work = await h.undo({ record: 'gc-work' });
    expect(work.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-profile' });
    // Голый ID — вид цели неизвестен, откат идёт табличным путём: таблицу он не трогает.
    const sheets = () => Promise.resolve(new FakeSheetsClient(snapshot()));
    const undo = { target: DOC, record: done.correlationId };
    const bare = await callMcp(gcUndo, undo, { ...h.deps, sheets });
    expect(data<Undone>(bare).docUndone).toContain('«Мой» удалён');
    // Без Drive откатывать нечем — внутренняя ошибка, а не тихое «готово».
    await expect(
      undoComment(DOC, { ...record, comment: record.comment! }, {}),
    ).rejects.toMatchObject({
      payload: {
        code: 'internal',
        detail: 'Откату комментария нужен Drive — комментарий на месте.',
      },
    });
  });
});

/** API Drive, отвечающий как Google: вызовы по порядку, `fail` — статусы метода по одному на вызов. */
function googleApi(
  fail: Record<string, number[]> = {},
  deleted = false,
  made: object = { id: 'CMT1', createdTime: 'T1' },
) {
  const calls: { method: string; params: unknown }[] = [];
  const answer = (method: string, params: unknown, data: object) => {
    calls.push({ method, params });
    const status = fail[method]?.shift();
    if (status === undefined) return Promise.resolve({ data });
    return Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));
  };
  const thread = {
    id: THREAD,
    author: { displayName: 'Заказчик', me: false },
    content: 'Уточните',
  };
  const api = {
    comments: {
      get: (p: unknown) => answer('comments.get', p, { ...thread, resolved: true, deleted }),
      create: (p: unknown) => answer('comments.create', p, made),
      delete: (p: unknown) => answer('comments.delete', p, {}),
    },
    replies: {
      create: (p: unknown) => answer('replies.create', p, { id: 'RPL1', action: 'resolve' }),
      delete: (p: unknown) => answer('replies.delete', p, {}),
    },
  } as unknown as drive_v3.Drive;
  return { calls, client: new GoogleDriveClient({ accessToken: 'нет', api }) };
}

describe('Z18 — шов: форма запросов Google (урок L28)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Z18: get — fields и includeDeleted, удалённая — null; create — цитата text/plain без anchor, без повтора; reply — action без content', async () => {
    const seam = googleApi({ 'comments.create': [503] });
    expect(await seam.client.getComment(DOC, THREAD)).toMatchObject({ id: THREAD, resolved: true });
    expect(await googleApi({}, true).client.getComment(DOC, THREAD)).toBeNull();
    await expect(seam.client.createComment(DOC, 'Так?', 'Fluminense')).rejects.toMatchObject({
      payload: {
        code: 'google_unavailable',
        detail: `Drive не создал комментарий в файле ${DOC}.`,
      },
    });
    expect(await seam.client.createComment(DOC, 'Всем')).toEqual({ id: 'CMT1', createdTime: 'T1' });
    await seam.client.createReply(DOC, THREAD, { action: 'resolve' });
    await seam.client.createReply(DOC, THREAD, { text: 'Готово' });
    expect(seam.calls).toStrictEqual([
      {
        method: 'comments.get',
        params: {
          fileId: DOC,
          commentId: THREAD,
          includeDeleted: true,
          fields: THREAD_FIELDS,
        },
      },
      {
        method: 'comments.create',
        params: {
          fileId: DOC,
          fields: 'id,createdTime,quotedFileContent',
          requestBody: {
            content: 'Так?',
            quotedFileContent: { mimeType: 'text/plain', value: 'Fluminense' },
          },
        },
      },
      {
        method: 'comments.create',
        params: {
          fileId: DOC,
          fields: 'id,createdTime,quotedFileContent',
          requestBody: { content: 'Всем' },
        },
      },
      {
        method: 'replies.create',
        params: {
          fileId: DOC,
          commentId: THREAD,
          fields: 'id,createdTime,action',
          requestBody: { action: 'resolve' },
        },
      },
      {
        method: 'replies.create',
        params: {
          fileId: DOC,
          commentId: THREAD,
          fields: 'id,createdTime,action',
          requestBody: { content: 'Готово' },
        },
      },
    ]);
  });

  it('Z18: удаление — без fields, с повтором: 404 после повтора — успех, 404 с первой попытки — not_found', async () => {
    vi.useFakeTimers();
    const seam = googleApi({ 'comments.delete': [503, 404], 'replies.delete': [404] });
    const pending = seam.client.deleteComment(DOC, 'CMT1');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeUndefined();
    await expect(seam.client.deleteReply(DOC, THREAD, 'RPL1')).rejects.toMatchObject({
      payload: {
        code: 'not_found',
        detail: `Drive не удалил ответ RPL1 в ветке ${THREAD} файла ${DOC}.`,
      },
    });
    expect(seam.calls).toEqual([
      { method: 'comments.delete', params: { fileId: DOC, commentId: 'CMT1' } },
      { method: 'comments.delete', params: { fileId: DOC, commentId: 'CMT1' } },
      { method: 'replies.delete', params: { fileId: DOC, commentId: THREAD, replyId: 'RPL1' } },
    ]);
    // 5xx на всех попытках — отказ, а не тихое «удалено».
    const down = googleApi({ 'comments.delete': [503, 503, 503, 503] }).client;
    const failing = expect(down.deleteComment(DOC, 'CMT1')).rejects.toMatchObject({
      payload: { code: 'google_unavailable' },
    });
    await vi.advanceTimersByTimeAsync(7000);
    await failing;
  });

  it('Z18: отказ Drive — с тем, что не удалось; созданное без id — internal, а не «готово»', async () => {
    const fail = { 'comments.get': [404], 'replies.create': [400], 'comments.delete': [404] };
    const { client } = googleApi(fail, false, {});
    const refused = (detail: string, code = 'not_found') => ({ payload: { code, detail } });
    await expect(client.getComment(DOC, 'X')).rejects.toMatchObject(
      refused(`Drive не отдал комментарий X файла ${DOC}.`),
    );
    await expect(client.createReply(DOC, THREAD, { text: 'x' })).rejects.toMatchObject(
      refused(`Drive не принял ответ в ветке ${THREAD} файла ${DOC}.`, 'bad_request'),
    );
    await expect(client.deleteComment(DOC, 'CMT1')).rejects.toMatchObject(
      refused(`Drive не удалил комментарий CMT1 файла ${DOC}.`),
    );
    await expect(client.createComment(DOC, 'x')).rejects.toMatchObject(
      refused('Drive не вернул id созданного комментария.', 'internal'),
    );
    // Поля ветки у чтения по id и у списка — одни (`listComments` читает их страницами).
    expect(COMMENT_FIELDS).toBe(`nextPageToken,comments(${THREAD_FIELDS})`);
  });
});

describe('Z20 — свой комментарий к фразе и её подсветка: два шага, откат обратно', () => {
  it('addComment с фразой, затем updateTextStyle с фоном той же фразы; gc_undo — подсветка, gc_undo — комментарий', async () => {
    const h = harness();
    // Один документ на все вызовы: подсветка и её откат судятся по его состоянию.
    const docs = new FakeDocsClient(forecastDoc());
    const deps: ToolDeps = { ...h.deps, docs: () => Promise.resolve(docs) };
    const run = (tool: typeof gcApply, args: Record<string, unknown>) =>
      callMcp(tool, { target: LINK, ...args }, deps);
    const where = { textStartsWith: 'Ставим на победу' };
    const fragment = 'со счётом 2:1';
    const lit = async () =>
      (await docs.getDocument()).tabs[0]?.paragraphs
        .find((paragraph) => paragraph.text === QUOTE)
        ?.runs.filter((r) => (r.style?.background ?? 'none') !== 'none')
        .map((r) => r.text);

    const added = data<Outcome>(
      await run(gcApply, {
        op: 'addComment',
        tab: 'Прогноз',
        where,
        fragment,
        text: 'Проверьте счёт',
        dryRun: false,
      }),
    );
    expect(added.status).toBe('ok');
    const ours = h.threads().find((thread) => thread.me);
    expect(ours).toMatchObject({ text: 'Проверьте счёт', quote: fragment });

    const highlighted = data<Outcome>(
      await run(gcApply, {
        op: 'updateTextStyle',
        tab: 'Прогноз',
        where,
        fragment,
        style: { background: '#fce8b2' },
        dryRun: false,
      }),
    );
    expect(highlighted.status).toBe('ok');
    expect(await lit()).toEqual([fragment]);

    // Откат идёт обратно: сначала подсветка (комментарий на месте), затем комментарий.
    expect(data<Undone>(await run(gcUndo, {})).status).toBe('ok');
    expect(await lit()).toEqual([]);
    expect(h.threads().some((thread) => thread.me)).toBe(true);

    expect(data<Undone>(await run(gcUndo, {})).status).toBe('ok');
    expect(h.threads().some((thread) => thread.me)).toBe(false);
    expect(h.threads()).toHaveLength(1);
  });
});
