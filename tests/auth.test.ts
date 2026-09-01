import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MVP_SCOPES,
  buildAuthUrl,
  ensureAccessToken,
  login,
  waitForCode,
} from '../src/core/auth.ts';
import { profileDir, readToken, writeToken } from '../src/core/profiles.ts';
import type { OAuthClient, StoredToken } from '../src/core/profiles.ts';

const CLIENT: OAuthClient = {
  clientId: 'id.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'http://localhost:3333',
};

/** Свободный порт: тесты не должны занимать 3333, на котором идёт живой вход. */
const PORT = 34_333;

let home: string;
const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gconnect-auth-'));
  process.env['GCONNECT_HOME'] = home;
  await mkdir(profileDir(), { recursive: true });
  await writeFile(
    join(profileDir(), 'credentials.json'),
    JSON.stringify({ web: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret, redirect_uris: [CLIENT.redirectUri] } }),
  );
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

const exchanger = (token: StoredToken, refreshed?: StoredToken) => ({
  calls: [] as string[],
  async exchangeCode(_c: OAuthClient, code: string): Promise<StoredToken> {
    this.calls.push(`exchange:${code}`);
    return token;
  },
  async refresh(_c: OAuthClient, refreshToken: string): Promise<StoredToken> {
    this.calls.push(`refresh:${refreshToken}`);
    return refreshed ?? token;
  },
});

describe('ссылка на согласие', () => {
  it('несёт scopes MVP, offline-доступ и state; forms там нет (§11.7)', () => {
    const url = new URL(buildAuthUrl(CLIENT, MVP_SCOPES, 'abc'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3333');
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(scopes.join(' ')).not.toContain('forms');
  });
});

describe('петля redirect (рисковый путь, проверяется без Google)', () => {
  it('код из callback доходит, браузер получает человеческую страницу', async () => {
    const waiting = waitForCode({ port: PORT, state: 's1' });
    const response = await fetch(`http://127.0.0.1:${PORT}/?code=CODE123&state=s1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Аккаунт подключён');
    expect(await waiting).toBe('CODE123');
  });

  it('отказ в доступе → внятная ошибка, а не «нет кода»', async () => {
    // Ожидание навешивается ДО запроса: иначе отклонение успевает стать
    // unhandled rejection, и vitest справедливо ругается на висящую ошибку.
    const expectation = expect(waitForCode({ port: PORT + 1 })).rejects.toMatchObject({
      payload: { code: 'auth_expired', cause: 'access_denied' },
    });
    await fetch(`http://127.0.0.1:${PORT + 1}/?error=access_denied`);
    await expectation;
  });

  it('чужой state не завершает вход', async () => {
    const expectation = expect(
      waitForCode({ port: PORT + 2, state: 'mine', timeoutMs: 400 }),
    ).rejects.toMatchObject({ payload: { cause: 'oauth_timeout' } });
    const response = await fetch(`http://127.0.0.1:${PORT + 2}/?code=X&state=other`);
    expect(response.status).toBe(400);
    await expectation;
  });

  it('таймаут объясняет, что произошло, а не молчит', async () => {
    await expect(waitForCode({ port: PORT + 3, timeoutMs: 200 })).rejects.toMatchObject({
      payload: { cause: 'oauth_timeout' },
    });
  });
});

describe('вход целиком', () => {
  it('токен пишется в профиль, ссылка отдаётся человеку', async () => {
    const ex = exchanger({ access_token: 'a', refresh_token: 'r', scope: MVP_SCOPES.join(' ') });
    let shown = '';
    const result = await login({
      exchanger: ex,
      port: PORT + 4,
      present: (url) => {
        shown = url;
        void fetch(`http://127.0.0.1:${PORT + 4}/?code=C&state=${new URL(url).searchParams.get('state')}`);
      },
    });
    expect(shown).toContain('accounts.google.com');
    expect(result.scopes).toHaveLength(4);
    expect((await readToken())?.refresh_token).toBe('r');
    expect(ex.calls).toContain('exchange:C');
  });

  it('без refresh_token вход не считается успешным и объясняет почему', async () => {
    const ex = exchanger({ access_token: 'a' });
    await expect(
      login({
        exchanger: ex,
        port: PORT + 5,
        present: (url) => {
          void fetch(`http://127.0.0.1:${PORT + 5}/?code=C&state=${new URL(url).searchParams.get('state')}`);
        },
      }),
    ).rejects.toMatchObject({ payload: { cause: 'no_refresh_token' } });
    expect(await readToken()).toBeNull();
  });
});

describe('действующий access-токен', () => {
  it('свежий токен отдаётся без обращения к Google', async () => {
    await writeToken({
      access_token: 'fresh',
      refresh_token: 'r',
      scope: MVP_SCOPES.join(' '),
      expiry_date: 10_000_000,
    });
    const ex = exchanger({ access_token: 'new' });
    expect(await ensureAccessToken({ exchanger: ex, now: () => 1_000_000 })).toBe('fresh');
    expect(ex.calls).toHaveLength(0);
  });

  it('истёкший обновляется, refresh_token не теряется', async () => {
    await writeToken({
      access_token: 'old',
      refresh_token: 'keepme',
      scope: MVP_SCOPES.join(' '),
      expiry_date: 1_000,
    });
    const ex = exchanger({ access_token: 'renewed', expiry_date: 9_000_000 });
    expect(await ensureAccessToken({ exchanger: ex, now: () => 500_000 })).toBe('renewed');
    expect(ex.calls).toContain('refresh:keepme');
    expect((await readToken())?.refresh_token).toBe('keepme');
  });

  it('токен, истекающий через полминуты, считается истёкшим заранее', async () => {
    await writeToken({
      access_token: 'almost',
      refresh_token: 'r',
      scope: MVP_SCOPES.join(' '),
      expiry_date: 1_030_000,
    });
    const ex = exchanger({ access_token: 'renewed' });
    expect(await ensureAccessToken({ exchanger: ex, now: () => 1_000_000 })).toBe('renewed');
  });

  it('старый набор прав → scope_missing с перечислением недостающего, а не «доступ сломался»', async () => {
    // Ровно случай владельца: в token.json лежит forms.body.readonly, но нет documents.
    await writeToken({
      access_token: 'a',
      refresh_token: 'r',
      scope:
        'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file ' +
        'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/forms.body.readonly',
      expiry_date: 9_000_000,
    });
    try {
      await ensureAccessToken({ exchanger: exchanger({}), now: () => 1_000 });
      expect.unreachable('должно бросить');
    } catch (error) {
      const payload = (error as { payload: { code: string; detail?: string } }).payload;
      expect(payload.code).toBe('scope_missing');
      expect(payload.detail).toContain('documents');
      expect(payload.detail).toContain('повторный вход');
    }
  });

  it('нет профиля → no_profile, а не попытка обновить пустоту', async () => {
    process.env['GCONNECT_HOME'] = join(home, 'empty');
    await expect(ensureAccessToken({ exchanger: exchanger({}) })).rejects.toMatchObject({
      payload: { code: 'no_profile' },
    });
  });
});
