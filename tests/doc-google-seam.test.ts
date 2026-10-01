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
