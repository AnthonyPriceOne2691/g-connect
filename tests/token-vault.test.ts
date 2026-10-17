/**
 * Токен Google процесса (D-24, слайс 3): access-токен только в памяти и до истечения,
 * refresh-токен — касанием на время обмена.
 *
 * Шифрование — настоящий `age` с программным ключом в файле ключа профиля; «касание» —
 * счётчик расшифровок: сколько раз хранилище вызвало бы окно Touch ID. Google — заглушка
 * обмена с часами теста.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MVP_SCOPES } from '../src/core/auth.js';
import { gcError } from '../src/core/errors.js';
import {
  profileDir,
  readSealedToken,
  writeSealedToken,
  type OAuthClient,
  type StoredToken,
  type TokenSealer,
} from '../src/core/profiles.js';
import type { TokenUnsealer } from '../src/core/token/sealing.js';
import { tokenVault, type TokenVault } from '../src/core/token/vault.js';
import { AGE_DIR, realAgeProfile } from './fixtures/sealing.js';

const HOUR = 3_600_000;
const original = process.env['GCONNECT_HOME'];

let home = '';
let clock = 0;
let sealer: TokenSealer;
let unsealer: TokenUnsealer;
let touches = 0;
let declineNext = false;
let rotateTo: string | undefined;
const refreshed: string[] = [];

/** «Касание» — расшифровка; отказ касания — то, что ответил бы плагин на отмену. */
const counted: TokenUnsealer = {
  unseal(sealed, meta) {
    touches += 1;
    if (declineNext) {
      declineNext = false;
      return Promise.reject(gcError('unlock_declined', { cause: 'declined' }));
    }
    return unsealer.unseal(sealed, meta);
  },
};

const exchanger = {
  exchangeCode: (): Promise<StoredToken> => Promise.reject(new TypeError('обмена кода тут нет')),
  refresh(_client: OAuthClient, refreshToken: string): Promise<StoredToken> {
    refreshed.push(refreshToken);
    return Promise.resolve({
      access_token: `A${refreshed.length}`,
      expiry_date: clock + HOUR,
      ...(rotateTo === undefined ? {} : { refresh_token: rotateTo }),
    });
  },
};

const vault = (): TokenVault =>
  tokenVault({
    account: 'default',
    exchanger,
    unsealer: counted,
    sealer: () => Promise.resolve(sealer),
    now: () => clock,
  });

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
    return 'нет ошибки';
  } catch (error) {
    return (error as { payload?: unknown }).payload;
  }
};

describe.skipIf(AGE_DIR === undefined)('токен процесса под пальцем', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gconnect-vault-'));
    process.env['GCONNECT_HOME'] = home;
    await mkdir(profileDir(), { recursive: true });
    await writeFile(
      join(profileDir(), 'credentials.json'),
      JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }),
    );
    ({ sealer, unsealer } = await realAgeProfile());
    await writeSealedToken(sealer, {
      refresh_token: '1//r1',
      scope: MVP_SCOPES.join(' '),
      obtained_at: 42,
    });
    clock = 1_000_000;
    touches = 0;
    declineNext = false;
    rotateTo = undefined;
    refreshed.length = 0;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['GCONNECT_HOME'];
    else process.env['GCONNECT_HOME'] = original;
    await rm(home, { recursive: true, force: true });
  });

  it('U3: закрыт — google_locked без окна; unlock — одно касание, дальше токен из памяти', async () => {
    const v = vault();
    expect(codeOf(() => v.accessToken())).toMatchObject({
      code: 'google_locked',
      cause: 'not_unlocked',
    });
    expect(v.status()).toEqual({ state: 'locked' });
    expect(touches).toBe(0);

    const opened = await v.unlock();
    expect(opened.state).toBe('unlocked');
    expect(touches).toBe(1);
    expect(refreshed).toEqual(['1//r1']);
    expect(v.accessToken()).toBe('A1');
  });

  it('U4: второе обращение в течение часа — без окна; unlock открытого — тоже без окна', async () => {
    const v = vault();
    await v.unlock();
    clock += 30 * 60_000;
    expect(v.accessToken()).toBe('A1');
    await v.unlock();
    expect(touches).toBe(1);
  });

  it('U5: после часа (с запасом минута) — снова google_locked, и открыть — снова касание', async () => {
    const v = vault();
    await v.unlock();
    clock += HOUR - 59_000;
    expect(codeOf(() => v.accessToken())).toMatchObject({
      code: 'google_locked',
      cause: 'expired',
    });
    expect(v.status()).toEqual({ state: 'locked' });
    await v.unlock();
    // Второе касание — доказательство, что refresh-токен в памяти не остался.
    expect(touches).toBe(2);
    expect(v.accessToken()).toBe('A2');
  });

  it('одновременные unlock — одно окно, а не два', async () => {
    const v = vault();
    await Promise.all([v.unlock(), v.unlock(), v.unlock()]);
    expect(touches).toBe(1);
  });

  it('U6: отказ касания — Google закрыт, следующий unlock снова спрашивает', async () => {
    const v = vault();
    declineNext = true;
    await expect(v.unlock()).rejects.toMatchObject({ payload: { code: 'unlock_declined' } });
    expect(v.status()).toEqual({ state: 'locked' });
    expect(refreshed).toHaveLength(0);
    await v.unlock();
    expect(touches).toBe(2);
  });

  it('U11: новый refresh-токен от Google — перешифрован без касания, срок входа прежний', async () => {
    rotateTo = '1//r2';
    await vault().unlock();
    expect(touches).toBe(1);
    const stored = await readSealedToken();
    expect(stored?.meta.obtained_at).toBe(42);
    expect(await unsealer.unseal(stored?.sealed ?? '', stored!.meta)).toContain('1//r2');
    for (const file of await readdir(profileDir())) {
      expect(await readFile(join(profileDir(), file), 'utf8')).not.toContain('1//r2');
    }
  });

  it('открытый token.json без шифротекста — token_unsealed, окна не было', async () => {
    await rm(join(profileDir(), 'token.age'));
    await rm(join(profileDir(), 'token.meta.json'));
    await writeFile(join(profileDir(), 'token.json'), JSON.stringify({ refresh_token: 'r' }));
    await expect(vault().unlock()).rejects.toMatchObject({ payload: { code: 'token_unsealed' } });
    expect(touches).toBe(0);
  });

  it('прав во входе не хватает — scope_missing до окна', async () => {
    await writeSealedToken(sealer, {
      refresh_token: '1//r1',
      scope: 'https://www.googleapis.com/auth/drive',
    });
    await expect(vault().unlock()).rejects.toMatchObject({ payload: { code: 'scope_missing' } });
    expect(touches).toBe(0);
  });
});
