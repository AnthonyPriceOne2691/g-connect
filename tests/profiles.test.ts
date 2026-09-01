import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listProfiles,
  profilesRoot,
  missingScopes,
  profileDir,
  profileStatus,
  readOAuthClient,
  readToken,
  requireProfile,
  writeToken,
} from '../src/core/profiles.js';

let home: string;
const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gconnect-test-'));
  process.env['GCONNECT_HOME'] = home;
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

const writeCredentials = async (account = 'default'): Promise<void> => {
  await mkdir(profileDir(account), { recursive: true });
  await writeFile(
    join(profileDir(account), 'credentials.json'),
    JSON.stringify({
      web: {
        client_id: 'id.apps.googleusercontent.com',
        client_secret: 'secret',
        redirect_uris: ['http://localhost:3333'],
      },
    }),
  );
};

describe('профили', () => {
  // Пример A12 спеки: нет профиля → внятная ошибка с действием, а не ENOENT.
  it('без профиля requireProfile даёт no_profile с кнопкой подключения', async () => {
    await expect(requireProfile()).rejects.toMatchObject({
      payload: { code: 'no_profile', action: { kind: 'connect_google' } },
    });
  });

  it('каталог есть, credentials нет → no_credentials с подсказкой куда положить', async () => {
    await mkdir(profileDir(), { recursive: true });
    const status = await profileStatus();
    expect(status.state).toBe('no_credentials');
    await expect(requireProfile()).rejects.toMatchObject({
      payload: { code: 'no_credentials', action: { kind: 'put_credentials' } },
    });
  });

  it('credentials есть, токена нет → needs_reauth, а не «всё хорошо»', async () => {
    await writeCredentials();
    const status = await profileStatus();
    expect(status.state).toBe('needs_reauth');
    expect(status.hasCredentials).toBe(true);
    expect(status.hasToken).toBe(false);
    await expect(requireProfile()).rejects.toMatchObject({ payload: { code: 'auth_expired' } });
  });

  it('токен без refresh_token тоже needs_reauth: access истечёт и обновить будет нечем', async () => {
    await writeCredentials();
    await writeToken({ access_token: 'a', scope: 'https://www.googleapis.com/auth/spreadsheets' });
    expect((await profileStatus()).state).toBe('needs_reauth');
  });

  it('полный профиль → connected, scopes и срок видны без выдачи токена', async () => {
    await writeCredentials();
    const expiry = Date.UTC(2026, 8, 1, 12, 0, 0);
    await writeToken({
      access_token: 'a',
      refresh_token: 'r',
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
      expiry_date: expiry,
    });
    const status = await profileStatus();
    expect(status.state).toBe('connected');
    expect(status.scopes).toHaveLength(2);
    expect(status.expiresAt).toBe(new Date(expiry).toISOString());
    // §13.5: наружу уходит статус, а не секреты.
    expect(JSON.stringify(status)).not.toContain('refresh_token');
    expect(JSON.stringify(status)).not.toContain('"r"');
  });

  it('токен пишется с правами 600 в каталог 700', async () => {
    await writeToken({ access_token: 'a', refresh_token: 'r' });
    const fileMode = (await stat(join(profileDir(), 'token.json'))).mode & 0o777;
    const dirMode = (await stat(profileDir())).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('читает и web, и installed; redirect_uris подхватывается', async () => {
    await writeCredentials();
    expect((await readOAuthClient()).redirectUri).toBe('http://localhost:3333');
    await mkdir(profileDir('other'), { recursive: true });
    await writeFile(
      join(profileDir('other'), 'credentials.json'),
      JSON.stringify({ installed: { client_id: 'i', client_secret: 's' } }),
    );
    const client = await readOAuthClient('other');
    expect(client.clientId).toBe('i');
    expect(client.redirectUri).toBe('http://localhost:3333');
  });

  it('битый credentials.json → no_credentials с причиной, а не падение парсера', async () => {
    await mkdir(profileDir(), { recursive: true });
    await writeFile(join(profileDir(), 'credentials.json'), '{ "web": {} }');
    await expect(readOAuthClient()).rejects.toMatchObject({
      payload: { code: 'no_credentials', cause: 'malformed_credentials' },
    });
  });

  it('несколько аккаунтов перечисляются для переключателя профилей', async () => {
    await writeCredentials('default');
    await writeCredentials('work');
    expect(await listProfiles()).toEqual(['default', 'work']);
  });

  it('служебные каталоги и пустые папки аккаунтами не считаются', async () => {
    await writeCredentials('default');
    // Каталоги отчётов и аудита лежат рядом с профилями — и раньше каталог `reports`
    // приходил агенту как аккаунт «no_credentials» (нашла живая проба).
    await mkdir(join(profilesRoot(), 'reports'), { recursive: true });
    await mkdir(join(profilesRoot(), 'audit'), { recursive: true });
    await mkdir(join(profilesRoot(), 'пустой'), { recursive: true });
    expect(await listProfiles()).toEqual(['default']);
  });

  it('missingScopes называет ровно недостающие права', async () => {
    await writeCredentials();
    await writeToken({
      refresh_token: 'r',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
    });
    const status = await profileStatus();
    expect(
      missingScopes(status, [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents',
      ]),
    ).toEqual(['https://www.googleapis.com/auth/documents']);
  });

  it('токена нет → readToken отдаёт null, а не бросает', async () => {
    expect(await readToken()).toBeNull();
  });
});
