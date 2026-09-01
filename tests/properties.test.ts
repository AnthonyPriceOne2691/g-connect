/**
 * Реляционные оракулы (Delivery §6.5): инварианты и round-trip вместо ожидаемых значений.
 * Здесь нельзя спрятать неверное ожидание — оно не задаётся, а проверяется отношение.
 */

import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ERROR_CATALOG, type ErrorCode } from '../src/core/error-catalog.ts';
import { gcError } from '../src/core/errors.ts';
import { profileDir, profileStatus, readToken, writeToken } from '../src/core/profiles.ts';
import { withRetry } from '../src/core/retry.ts';
import { assertWritable, parseTargetUrl, resolveTarget } from '../src/core/targets.ts';

/** Алфавит ID файлов Google. */
const fileId = fc
  .stringMatching(/^[A-Za-z0-9_-]{20,44}$/)
  .filter((s) => s.length >= 20 && s.length <= 44);

const errorCode = fc.constantFrom(...(Object.keys(ERROR_CATALOG) as ErrorCode[]));

describe('инварианты ошибок', () => {
  it('любой код даёт показываемую человеку ошибку: title непустой, действие согласовано', () => {
    fc.assert(
      fc.property(errorCode, fc.option(fc.string(), { nil: undefined }), (code, detail) => {
        const payload = gcError(code, detail === undefined ? {} : { detail }).toPayload();
        expect(payload.title.length).toBeGreaterThan(0);
        expect(payload.title).not.toMatch(/undefined|\[object/);
        if (payload.action !== null) expect(payload.action.label.length).toBeGreaterThan(0);
        expect(payload.correlationId).toMatch(/^gc-[a-z0-9]+$/);
        expect(payload.code).toBe(code);
      }),
    );
  });

  it('detail никогда не подменяет title: сообщение источника не всплывает первым экраном', () => {
    fc.assert(
      fc.property(errorCode, fc.string({ minLength: 1 }), (code, cause) => {
        const payload = gcError(code, { cause }).toPayload();
        expect(payload.title).toBe(ERROR_CATALOG[code].title);
      }),
    );
  });
});

describe('инварианты резолва цели', () => {
  // Главный инвариант безопасности (§11.2): ссылка, пришедшая не из реестра,
  // не бывает пишущей — независимо от того, как она выглядит.
  it('любая ссылка/ID без реестра → только чтение', () => {
    fc.assert(
      fc.property(fileId, (id) => {
        for (const ref of [
          id,
          `https://docs.google.com/spreadsheets/d/${id}/edit`,
          `https://docs.google.com/document/d/${id}/edit#heading=h.x`,
          `https://drive.google.com/drive/folders/${id}`,
        ]) {
          const target = resolveTarget(ref);
          expect(target.allow).toBe('read');
          expect(() => {
            assertWritable(target);
          }).toThrowError(/policy_denied/);
        }
      }),
    );
  });

  it('round-trip: ID → URL → ID для всех форм ссылок Google', () => {
    fc.assert(
      fc.property(fileId, (id) => {
        const forms = [
          [`https://docs.google.com/document/d/${id}/edit`, 'doc'],
          [`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`, 'sheet'],
          [`https://docs.google.com/forms/d/${id}/viewform`, 'form'],
          [`https://drive.google.com/drive/folders/${id}`, 'folder'],
        ] as const;
        for (const [url, type] of forms) {
          const parsed = parseTargetUrl(url);
          expect(parsed?.id).toBe(id);
          expect(parsed?.type).toBe(type);
          expect(resolveTarget(url).id).toBe(id);
        }
      }),
    );
  });

  it('резолв идемпотентен: повторный прогон по ID той же цели ничего не меняет', () => {
    fc.assert(
      fc.property(fileId, (id) => {
        const once = resolveTarget(`https://docs.google.com/spreadsheets/d/${id}/edit`);
        const twice = resolveTarget(once.id);
        expect(twice.id).toBe(once.id);
        expect(twice.allow).toBe(once.allow);
      }),
    );
  });
});

describe('инварианты повторов', () => {
  it('неповторяемая ошибка вызывает функцию ровно один раз при любом бюджете', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom<ErrorCode>('forbidden', 'not_found', 'auth_expired', 'policy_denied'),
        async (maxRetries, code) => {
          let calls = 0;
          await expect(
            withRetry(
              async () => {
                calls += 1;
                throw gcError(code);
              },
              { maxRetries, sleep: async () => undefined },
            ),
          ).rejects.toMatchObject({ payload: { code } });
          expect(calls).toBe(1);
        },
      ),
    );
  });

  it('повторяемая ошибка расходует ровно maxRetries+1 попыток и не больше', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (maxRetries) => {
        let calls = 0;
        await expect(
          withRetry(
            async () => {
              calls += 1;
              throw gcError('google_unavailable');
            },
            { maxRetries, backoffMs: 1, sleep: async () => undefined },
          ),
        ).rejects.toMatchObject({ payload: { code: 'google_unavailable' } });
        expect(calls).toBe(maxRetries + 1);
      }),
    );
  });

  it('задержки растут монотонно: backoff, а не постоянная пауза', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (maxRetries) => {
        const delays: number[] = [];
        await withRetry(
          async () => {
            throw gcError('quota_exceeded');
          },
          {
            maxRetries,
            backoffMs: 1,
            sleep: async (ms) => {
              delays.push(ms);
            },
          },
        ).catch(() => undefined);
        for (let i = 1; i < delays.length; i += 1) {
          expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
        }
      }),
    );
  });
});

describe('инварианты профилей', () => {
  const original = process.env['GCONNECT_HOME'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gconnect-prop-'));
    process.env['GCONNECT_HOME'] = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env['GCONNECT_HOME'];
    else process.env['GCONNECT_HOME'] = original;
  });

  it('round-trip токена и права 600 — при любом имени аккаунта и любых scopes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
        fc.uniqueArray(fc.stringMatching(/^[a-z.]{3,12}$/), { minLength: 1, maxLength: 4 }),
        async (account, scopeWords) => {
          const scope = scopeWords.map((w) => `https://www.googleapis.com/auth/${w}`).join(' ');
          await writeToken({ access_token: 'a', refresh_token: 'r', scope }, account);
          const back = await readToken(account);
          expect(back?.scope).toBe(scope);
          expect((await stat(join(profileDir(account), 'token.json'))).mode & 0o777).toBe(0o600);

          const status = await profileStatus(account);
          expect(status.scopes).toEqual(scopeWords.map((w) => `https://www.googleapis.com/auth/${w}`));
          // Инвариант §13.5: статус наружу — без секретов, при любых входных данных.
          expect(JSON.stringify(status)).not.toContain('refresh_token');
        },
      ),
      { numRuns: 25 },
    );
  });

  it('состояние профиля определено всегда: любая комбинация файлов даёт валидный state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (dir, creds, token) => {
        const account = `a${Math.random().toString(36).slice(2, 8)}`;
        if (dir) await mkdir(profileDir(account), { recursive: true });
        if (dir && creds) {
          await writeFile(
            join(profileDir(account), 'credentials.json'),
            JSON.stringify({ web: { client_id: 'i', client_secret: 's' } }),
          );
        }
        if (dir && token) await writeToken({ access_token: 'a', refresh_token: 'r' }, account);

        const status = await profileStatus(account);
        expect(['no_profile', 'no_credentials', 'needs_reauth', 'connected']).toContain(status.state);
        if (status.state === 'connected') {
          expect(status.hasCredentials && status.hasToken).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });
});
