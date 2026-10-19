/**
 * `gc seal` и `gc run` (D-24, слайс 5).
 *
 * Переход — на настоящем `age` с программным ключом в файле ключа профиля: пробное касание
 * — настоящие шифрование и расшифровка, только без окна. Google (отзыв, «жив ли старый
 * вход») и браузер — заглушки с журналом вызовов: порядок шагов и есть оракул (урок L19).
 */

import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MVP_SCOPES, type TokenRevoker } from '../src/core/auth.js';
import { isAlreadyRevoked, isInvalidGrant } from '../src/core/google/exchanger.js';
import { gcError } from '../src/core/errors.js';
import { profileDir, readTokenMeta, writeSealedToken } from '../src/core/profiles.js';
import { ageToolsIn, type AgeTools } from '../src/core/token/age.js';
import { runWithAccessToken, spawnInherit } from '../src/core/token/run-with-token.js';
import { sealProfile } from '../src/core/token/seal-flow.js';
import type { TokenVault } from '../src/core/token/vault.js';
import { AGE_DIR, realAgeProfile } from './fixtures/sealing.js';

const original = process.env['GCONNECT_HOME'];
let home = '';
let calls: string[] = [];
let tools: AgeTools;

const present = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );
const plainFile = (): string => join(profileDir(), 'token.json');

/** Google: отзыв и «жив ли старый вход»; `aliveFor` — сколько опросов он ещё жив. */
const revoker = (aliveFor: number): TokenRevoker => {
  let polls = 0;
  return {
    revoke: (token) => {
      calls.push(`revoke:${token}`);
      return Promise.resolve();
    },
    isAlive: () => {
      calls.push('alive?');
      polls += 1;
      return Promise.resolve(polls <= aliveFor);
    },
  };
};

const flow = (aliveFor = 1, loginFails = false) => ({
  tools,
  revoker: revoker(aliveFor),
  sleep: () => Promise.resolve(),
  async login(sealer: Parameters<typeof writeSealedToken>[0]) {
    calls.push('login');
    if (loginFails) throw gcError('auth_expired', { cause: 'oauth_timeout' });
    await writeSealedToken(sealer, { refresh_token: '1//новый', scope: MVP_SCOPES.join(' ') });
    return { account: 'default', scopes: [...MVP_SCOPES] };
  },
});

describe.skipIf(AGE_DIR === undefined)('gc seal: порядок перехода — несущий', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gconnect-seal-'));
    process.env['GCONNECT_HOME'] = home;
    await mkdir(profileDir(), { recursive: true });
    await writeFile(
      join(profileDir(), 'credentials.json'),
      JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }),
    );
    await writeFile(plainFile(), JSON.stringify({ refresh_token: '1//старый' }));
    const plugin = join(home, 'age-plugin-se');
    await writeFile(plugin, '#!/bin/sh\nexit 0\n');
    await chmod(plugin, 0o755);
    // Ключ профиля — программный: проба шифрует и расшифровывает без окна.
    ({ tools } = await realAgeProfile());
    tools = { ...ageToolsIn(AGE_DIR ?? ''), plugin };
    calls = [];
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['GCONNECT_HOME'];
    else process.env['GCONNECT_HOME'] = original;
    await rm(home, { recursive: true, force: true });
  });

  it('U1, U2, U7: проба → отзыв → подтверждение → вход → удаление token.json', async () => {
    const report = await sealProfile(flow(2));
    expect(calls).toEqual(['revoke:1//старый', 'alive?', 'alive?', 'alive?', 'login']);
    expect(report.revoked).toBe(true);
    expect(await present(plainFile())).toBe(false);
    // Новый токен зашифрован тем ключом, что прошёл пробу.
    expect((await readTokenMeta())?.recipient).toBe(report.recipient);
  });

  it('отзыв не подтверждён — входа нет, token.json на месте', async () => {
    await expect(sealProfile(flow(1_000))).rejects.toMatchObject({
      payload: { code: 'google_unavailable', cause: 'revoke_not_confirmed' },
    });
    expect(calls).not.toContain('login');
    expect(await present(plainFile())).toBe(true);
  });

  it('вход не удался — token.json на месте, повтор возможен', async () => {
    await expect(sealProfile(flow(0, true))).rejects.toMatchObject({
      payload: { cause: 'oauth_timeout' },
    });
    expect(await present(plainFile())).toBe(true);
  });

  it('открытого токена не было — отзывать нечего, сразу вход', async () => {
    await rm(plainFile());
    const report = await sealProfile(flow());
    expect(calls).toEqual(['login']);
    expect(report.revoked).toBe(false);
  });

  it('U6: проба не прошла (касания не было) — отзыва нет, ничего не тронуто', async () => {
    // Заглушка age: шифрует, а расшифровку отклоняет так же, как на отменённом касании.
    const fake = join(home, 'age');
    await writeFile(
      fake,
      '#!/bin/sh\ncase "$1" in\n  --encrypt) cat >/dev/null; echo "-----BEGIN AGE ENCRYPTED FILE-----";;\n' +
        '  *) cat >/dev/null; echo "age: error: no identity matched any of the recipients" >&2; exit 1;;\nesac\n',
    );
    await chmod(fake, 0o755);
    await expect(sealProfile({ ...flow(), tools: { ...tools, age: fake } })).rejects.toMatchObject({
      payload: { code: 'unlock_declined' },
    });
    expect(calls).toEqual([]);
    expect(await present(plainFile())).toBe(true);
  });

  it('U10: нет плагина — seal_tool_missing до любого шага', async () => {
    await expect(
      sealProfile({ ...flow(), tools: { ...tools, plugin: join(home, 'нет') } }),
    ).rejects.toMatchObject({ payload: { code: 'seal_tool_missing' } });
    expect(calls).toEqual([]);
  });
});

describe('gc run: команде — access-токен на час, refresh-токена нет', () => {
  const vault = (declined = false): TokenVault & { touches: number } => {
    const v = {
      touches: 0,
      status: () => ({ state: 'locked' as const }),
      accessToken: () => 'ya29.U14',
      unlock() {
        v.touches += 1;
        return declined
          ? Promise.reject(gcError('unlock_declined', { cause: 'declined' }))
          : Promise.resolve({ state: 'unlocked' as const, until: '19:42' });
      },
    };
    return v;
  };

  it('U14: у ребёнка GOOGLE_ACCESS_TOKEN, refresh-токена нет; код возврата — его', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gconnect-run-'));
    const out = join(dir, 'env.json');
    try {
      const v = vault();
      const script =
        'const e = process.env; require("fs").writeFileSync(process.argv[1], JSON.stringify({' +
        'a: e.GOOGLE_ACCESS_TOKEN, r: Object.values(e).some((x) => x.includes("1//"))}));' +
        'process.exit(7)';
      const code = await runWithAccessToken(v, process.execPath, ['-e', script, out], {
        PATH: '/usr/bin:/bin',
        GCONNECT_HOME: home,
      });
      expect(code).toBe(7);
      expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ a: 'ya29.U14', r: false });
      expect(v.touches).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('касания не было — команда не запускается', async () => {
    let launched = 0;
    await expect(
      runWithAccessToken(vault(true), 'true', [], {}, () => {
        launched += 1;
        return Promise.resolve(0);
      }),
    ).rejects.toMatchObject({ payload: { code: 'unlock_declined' } });
    expect(launched).toBe(0);
  });

  it('команды нет — отказ с причиной, а не тишина', async () => {
    await expect(spawnInherit(join(tmpdir(), 'нет-такой-команды'), [], {})).rejects.toMatchObject({
      payload: { code: 'bad_request', cause: 'run_spawn_failed' },
    });
  });
});

describe('ответы Google на отзыв — по документации OAuth (урок L3)', () => {
  // Форма — как её отдаёт gaxios: HTTP 400 и тело ошибки в response.data.
  const failure = (error: string) => ({
    message: error,
    response: {
      status: 400,
      data: { error, error_description: 'Token has been expired or revoked.' },
    },
  });

  it('invalid_grant — старого входа больше нет; прочие отказы — не «нет»', () => {
    expect(isInvalidGrant(failure('invalid_grant'))).toBe(true);
    expect(isInvalidGrant({ message: 'request failed: invalid_grant' })).toBe(true);
    expect(isInvalidGrant(failure('invalid_client'))).toBe(false);
    expect(isInvalidGrant(undefined)).toBe(false);
  });

  it('invalid_token на отзыве — уже отозван, цель достигнута; прочее — сбой', () => {
    expect(isAlreadyRevoked(failure('invalid_token'))).toBe(true);
    expect(isAlreadyRevoked(failure('invalid_request'))).toBe(false);
    expect(isAlreadyRevoked(null)).toBe(false);
  });
});
