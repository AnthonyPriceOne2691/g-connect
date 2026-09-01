import { describe, expect, it } from 'vitest';

import { ERROR_CATALOG, type ErrorCode } from '../src/core/error-catalog.ts';
import { fromGoogleError, gcError, isGcError } from '../src/core/errors.ts';

describe('каталог ошибок', () => {
  const codes = Object.keys(ERROR_CATALOG) as ErrorCode[];

  it('у каждого кода непустой человеческий title без кодов и Error:', () => {
    for (const code of codes) {
      const entry = ERROR_CATALOG[code];
      expect(entry.title, code).not.toBe('');
      expect(entry.title, code).not.toMatch(/Error|undefined|HTTP \d/);
    }
  });

  it('действие названо явно: либо kind+label, либо оба null (§13.7 п.3)', () => {
    for (const code of codes) {
      const { action, actionLabel } = ERROR_CATALOG[code];
      const bothNull = action === null && actionLabel === null;
      const bothSet = action !== null && actionLabel !== null && actionLabel !== '';
      expect(bothNull || bothSet, `${code}: action и actionLabel рассогласованы`).toBe(true);
    }
  });

  it('gcError отдаёт payload с correlationId и без стектрейса', () => {
    const error = gcError('quota_exceeded', { detail: 'Лист «Отчёт»', cause: 'HTTP 429' });
    expect(isGcError(error)).toBe(true);
    const payload = error.toPayload();
    expect(payload.code).toBe('quota_exceeded');
    expect(payload.retryable).toBe(true);
    expect(payload.action?.kind).toBe('wait_and_retry');
    expect(payload.correlationId).toMatch(/^gc-[a-z0-9]+$/);
    expect(Object.keys(payload)).not.toContain('stack');
  });

  it('correlationId различается у двух ошибок подряд', () => {
    const a = gcError('offline').payload.correlationId;
    const b = gcError('offline').payload.correlationId;
    expect(a).not.toBe(b);
  });
});

describe('ошибки Google API → коды ядра', () => {
  it('401 invalid_grant → auth_expired с действием переподключиться', () => {
    const error = fromGoogleError({ code: 401, message: 'invalid_grant: Token has been expired' });
    expect(error.payload.code).toBe('auth_expired');
    expect(error.payload.action?.kind).toBe('reconnect_google');
    expect(error.payload.retryable).toBe(false);
  });

  it('403 про scope → scope_missing, а не forbidden: действия разные', () => {
    const scope = fromGoogleError({
      code: 403,
      message: 'Request had insufficient authentication scopes',
    });
    const denied = fromGoogleError({ code: 403, message: 'The caller does not have permission' });
    expect(scope.payload.code).toBe('scope_missing');
    expect(denied.payload.code).toBe('forbidden');
    expect(denied.payload.action?.kind).toBe('request_access');
  });

  it('429 и 5xx повторяемы, 404 и 400 — нет', () => {
    expect(fromGoogleError({ code: 429, message: 'Quota exceeded' }).payload.retryable).toBe(true);
    expect(fromGoogleError({ code: 503, message: 'Backend error' }).payload.retryable).toBe(true);
    expect(fromGoogleError({ code: 404, message: 'File not found' }).payload.retryable).toBe(false);
    expect(fromGoogleError({ code: 400, message: 'Invalid range' }).payload.retryable).toBe(false);
  });

  it('обрыв сети → offline, а не internal', () => {
    expect(fromGoogleError({ code: 'ECONNRESET', message: 'socket hang up' }).payload.code).toBe(
      'offline',
    );
    expect(
      fromGoogleError(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com')).payload.code,
    ).toBe('offline');
  });

  it('уже разобранная ошибка ядра не переоборачивается', () => {
    const original = gcError('write_blocked', { detail: 'колонка «Часы» формульная' });
    expect(fromGoogleError(original)).toBe(original);
  });

  it('статус приходит и в response.status (форма googleapis)', () => {
    expect(fromGoogleError({ response: { status: 500 }, message: 'Internal' }).payload.code).toBe(
      'google_unavailable',
    );
  });
});
