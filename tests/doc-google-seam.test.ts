/**
 * Шов `GoogleDocsClient` против ЖИВЫХ форм ответов Google (прогон 2026-10-01, LR3-1).
 *
 * Фейк DocsClient бросает готовый `doc_changed` и поэтому не видит, как настоящий клиент
 * разбирает отказ. Живьём разбор не срабатывал: `withRetry` переводил сырую ошибку в
 * `bad_request` раньше, чем её читал распознаватель ревизии, — человек получал «Запрос
 * составлен неверно» вместо «документ изменился, перестрой план». Запись при этом не
 * проходила (предусловие держит сервер), ломался только смысл отказа.
 */

import { describe, expect, it } from 'vitest';

import { GoogleDocsClient } from '../src/core/google/docs.js';

/** Отказ на ушедшую ревизию: статус, текст и тело сняты живьём 2026-10-01. */
function liveStaleRevision(): Error {
  const message = "The required revision ID 'ANLCKQ-old' does not match the latest revision.";
  return Object.assign(new Error(message), {
    status: 400,
    code: 400,
    response: {
      status: 400,
      data: {
        error: {
          code: 400,
          message,
          errors: [{ message, domain: 'global', reason: 'badRequest' }],
          status: 'INVALID_ARGUMENT',
        },
      },
    },
  });
}

/** Клиент поверх API, чья запись всегда отказывает данной ошибкой; считает вызовы. */
function failingClient(error: Error): { client: GoogleDocsClient; calls: () => number } {
  let calls = 0;
  const api = {
    documents: {
      batchUpdate: () => {
        calls += 1;
        return Promise.reject(error);
      },
    },
  };
  return {
    client: new GoogleDocsClient({ accessToken: 't', api: api as never }),
    calls: () => calls,
  };
}

describe('GoogleDocsClient.batchUpdate: отказы в живой форме Google', () => {
  it('ушедшая ревизия — doc_changed, и без повторов: предусловие не лечится ожиданием', async () => {
    const { client, calls } = failingClient(liveStaleRevision());
    await expect(client.batchUpdate('d', [], 'ANLCKQ-old')).rejects.toMatchObject({
      payload: { code: 'doc_changed' },
    });
    expect(calls()).toBe(1);
  });

  it('прочий 400 остаётся bad_request — ревизия не мерещится в любом отказе', async () => {
    const message =
      'Invalid requests[0].insertText: Index 999 must be less than the end index of the ' +
      'referenced segment, 460.';
    const { client } = failingClient(Object.assign(new Error(message), { status: 400, code: 400 }));
    await expect(client.batchUpdate('d', [], 'r')).rejects.toMatchObject({
      payload: { code: 'bad_request' },
    });
  });
});

describe('GoogleDocsClient.batchUpdate: предусловие уходит и исход называется честно', () => {
  it('в запрос уходит writeControl с ревизией плана; ревизия «после» — из ответа', async () => {
    const seen: unknown[] = [];
    const api = {
      documents: {
        batchUpdate: (params: unknown) => {
          seen.push(params);
          return Promise.resolve({ data: { writeControl: { requiredRevisionId: 'rev-после' } } });
        },
      },
    };
    const client = new GoogleDocsClient({ accessToken: 't', api: api as never });
    const written = await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: 1, text: 'х' }],
      'rev-плана',
    );
    // Находка читателя: заглушка, не глядящая в аргументы, оставалась зелёной и без
    // writeControl — а предусловие держит именно оно.
    expect(seen).toMatchObject([
      { documentId: 'd', requestBody: { writeControl: { requiredRevisionId: 'rev-плана' } } },
    ]);
    expect(written.revisionId).toBe('rev-после');
  });

  it('обрыв → повтор → ушедшая ревизия: «исход неизвестен», а не «ни одной правки»', async () => {
    // Первая попытка могла дойти до Google и записать; повтор видит уже её ревизию.
    let calls = 0;
    const api = {
      documents: {
        batchUpdate: () => {
          calls += 1;
          return Promise.reject(
            calls === 1
              ? Object.assign(new Error('connect ETIMEDOUT 142.250.74.10:443'), {
                  code: 'ETIMEDOUT',
                })
              : liveStaleRevision(),
          );
        },
      },
    };
    const client = new GoogleDocsClient({ accessToken: 't', api: api as never });
    await expect(client.batchUpdate('d', [], 'rev-плана')).rejects.toMatchObject({
      payload: { code: 'write_outcome_unknown' },
    });
    expect(calls).toBe(2);
  });
});

describe('GoogleDocsClient.batchUpdate: картинку Google не взял (P19)', () => {
  it.each([
    'Invalid requests[0].insertInlineImage: The provided image was not found.',
    'Invalid requests[0].insertInlineImage: There was a problem retrieving the image. ' +
      'The provided image should be publicly accessible, within size limit, and in supported formats.',
  ])('живой отказ «%s» доходит с советом, а не «Запрос составлен неверно»', async (message) => {
    const { client } = failingClient(Object.assign(new Error(message), { status: 400, code: 400 }));
    const payload = await client.batchUpdate('d', [], 'r').then(
      () => null,
      (e: { payload: { code: string; cause: string; detail: string } }) => e.payload,
    );
    expect(payload?.code).toBe('bad_request');
    expect(payload?.cause).toMatch(/^image\.unreachable/);
    expect(payload?.detail).toContain('публичный доступ');
  });
});
