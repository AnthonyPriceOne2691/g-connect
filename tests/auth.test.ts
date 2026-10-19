import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MVP_SCOPES,
  buildAuthUrl,
  login,
  requireUsableProfile,
  waitForCode,
} from '../src/core/auth.js';
import { profileDir, readTokenMeta, writeSealedToken } from '../src/core/profiles.js';
import type { OAuthClient, StoredToken } from '../src/core/profiles.js';
import { fakeSealer } from './fixtures/sealing.js';

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
    JSON.stringify({
      web: {
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        redirect_uris: [CLIENT.redirectUri],
      },
    }),
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
    // Оба значения обязательны: `consent` даёт refresh_token, `select_account`
    // заставляет Google показать выбор аккаунта — иначе вход уходит не туда.
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
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

const plainOnDisk = (): Promise<boolean> =>
  access(join(profileDir(), 'token.json')).then(
    () => true,
    () => false,
  );

describe('вход целиком', () => {
  it('U9: токен ложится шифротекстом, открытого token.json нет; ссылка отдаётся человеку', async () => {
    const ex = exchanger({ access_token: 'a', refresh_token: 'r', scope: MVP_SCOPES.join(' ') });
    let shown = '';
    const result = await login({
      exchanger: ex,
      sealer: fakeSealer('age1login'),
      port: PORT + 4,
      present: (url) => {
        shown = url;
        void fetch(
          `http://127.0.0.1:${PORT + 4}/?code=C&state=${new URL(url).searchParams.get('state')}`,
        );
      },
    });
    expect(shown).toContain('accounts.google.com');
    expect(result.scopes).toEqual([...MVP_SCOPES]);
    expect(await readTokenMeta()).toMatchObject({
      recipient: 'age1login',
      scope: MVP_SCOPES.join(' '),
    });
    expect(await plainOnDisk()).toBe(false);
    expect(ex.calls).toContain('exchange:C');
  });

  it('без refresh_token вход не считается успешным и объясняет почему', async () => {
    const ex = exchanger({ access_token: 'a' });
    await expect(
      login({
        exchanger: ex,
        sealer: fakeSealer(),
        port: PORT + 5,
        present: (url) => {
          void fetch(
            `http://127.0.0.1:${PORT + 5}/?code=C&state=${new URL(url).searchParams.get('state')}`,
          );
        },
      }),
    ).rejects.toMatchObject({ payload: { cause: 'no_refresh_token' } });
    expect(await readTokenMeta()).toBeNull();
  });
});

describe('пригодность профиля перед открытием Google', () => {
  it('старый набор прав → scope_missing с перечислением недостающего, а не «доступ сломался»', async () => {
    // Ровно случай владельца: во входе лежит forms.body.readonly, но нет documents.
    await writeSealedToken(fakeSealer(), {
      refresh_token: 'r',
      scope:
        'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file ' +
        'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/forms.body.readonly',
    });
    try {
      await requireUsableProfile('default');
      expect.unreachable('должно бросить');
    } catch (error) {
      const payload = (error as { payload: { code: string; detail?: string } }).payload;
      expect(payload.code).toBe('scope_missing');
      expect(payload.detail).toContain('documents');
      expect(payload.detail).toContain('повторный вход');
    }
  });

  it('нет профиля → no_profile, а не попытка открыть пустоту', async () => {
    process.env['GCONNECT_HOME'] = join(home, 'empty');
    await expect(requireUsableProfile('default')).rejects.toMatchObject({
      payload: { code: 'no_profile' },
    });
  });
});
