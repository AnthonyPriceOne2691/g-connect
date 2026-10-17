/**
 * Пробы правил доступа к Google (D-24) и срока входа — отдельным модулем: реестр проб в
 * policy.test.ts перерос гейт длины (1008 > 1000). Структурный оракул «у КАЖДОГО правила
 * есть проба — и наоборот» судит реестр целиком, как и раньше.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from 'vitest';

import {
  profileDir,
  profileStatus,
  readSealedToken,
  requireProfile,
  writeSealedToken,
} from '../../src/core/profiles.js';
import { tokenVault } from '../../src/core/token/vault.js';
import { fakeSealer } from './sealing.js';

export const tokenProbes: Record<string, () => Promise<void>> = {
  'auth.testing-mode-warning': async () => {
    await writeSealedToken(
      fakeSealer(),
      { refresh_token: 'r', scope: 'x', obtained_at: Date.now() - 7 * 86_400_000 },
      'stale',
    );
    const status = await profileStatus('stale');
    expect(status.refreshAgeDays).toBeGreaterThanOrEqual(6);
    expect(status.warnings.join(' ')).toContain('Testing');
    expect(status.warnings.join(' ')).toContain('войди заново');

    // Свежий профиль молчит: предупреждение без повода — шум.
    await writeSealedToken(fakeSealer(), { refresh_token: 'r', scope: 'x' }, 'fresh');
    expect((await profileStatus('fresh')).warnings).toHaveLength(0);
  },

  'token.sealed-at-rest': async () => {
    // Шифровальщик, вернувший открытый текст, — последний ремень писателя: на диск ничего.
    const leaky = { recipient: 'age1leak', seal: (plain: string) => Promise.resolve(plain) };
    await expect(writeSealedToken(leaky, { refresh_token: '1//r' }, 'leak')).rejects.toMatchObject({
      payload: { cause: 'seal_returned_plaintext' },
    });
    expect(await readSealedToken('leak')).toBeNull();
    // Открытый token.json прежней раскладки ядро не берёт: состояние unsealed и действие.
    await mkdir(profileDir('legacy'), { recursive: true });
    await writeFile(join(profileDir('legacy'), 'credentials.json'), '{"installed":{}}');
    await writeFile(join(profileDir('legacy'), 'token.json'), '{"refresh_token":"r"}');
    expect((await profileStatus('legacy')).state).toBe('unsealed');
    await expect(requireProfile('legacy')).rejects.toMatchObject({
      payload: { code: 'token_unsealed' },
    });
  },

  'google.unlock-only-tool': async () => {
    let unseals = 0;
    const vault = tokenVault({
      account: 'probe',
      exchanger: {
        exchangeCode: () => Promise.resolve({}),
        refresh: () => Promise.resolve({ access_token: 'a' }),
      },
      unsealer: {
        unseal: () => {
          unseals += 1;
          return Promise.resolve('{"refresh_token":"r"}');
        },
      },
      sealer: () => Promise.resolve(fakeSealer()),
    });
    let code = 'окна не просили';
    try {
      vault.accessToken();
    } catch (error) {
      code = (error as { payload: { code: string } }).payload.code;
    }
    expect(code).toBe('google_locked');
    expect(unseals).toBe(0);
  },
};
