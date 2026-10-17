/**
 * Шифрование токена в тестах (D-24).
 *
 * `realAgeProfile` — НАСТОЯЩИЙ `age` с программным ключом X25519, положенным прямо в файл
 * ключа профиля: так тесты проходят тот же путь `profileSealer` / `profileUnsealer`, что и
 * прод, без анклава и без окна (урок L32). `fakeSealer` — для свойств раскладки, где
 * важна скорость, а не шов.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { identityPath, type TokenSealer } from '../../src/core/profiles.js';
import { ageToolsIn, type AgeTools } from '../../src/core/token/age.js';
import {
  profileSealer,
  profileUnsealer,
  type TokenUnsealer,
} from '../../src/core/token/sealing.js';

/** Каталог с `age` и `age-keygen`; нет — тесты шва пропускаются с названной причиной (L29). */
export const AGE_DIR = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].find(
  (dir) => existsSync(join(dir, 'age')) && existsSync(join(dir, 'age-keygen')),
);

/** Программный ключ в файле ключа профиля: получатель — из его строки `# public key`. */
export async function realAgeProfile(account = 'default'): Promise<{
  readonly tools: AgeTools;
  readonly sealer: TokenSealer;
  readonly unsealer: TokenUnsealer;
}> {
  const dir = AGE_DIR ?? '';
  execFileSync(join(dir, 'age-keygen'), ['-o', identityPath(account)], { stdio: 'ignore' });
  const tools = ageToolsIn(dir);
  return {
    tools,
    sealer: await profileSealer(tools, account),
    unsealer: profileUnsealer(tools, account),
  };
}

/** Обратимая заглушка: base64 с меткой — открытого текста в «шифротексте» нет. */
export const fakeSealer = (recipient = 'age1fake'): TokenSealer => ({
  recipient,
  seal: (plain) => Promise.resolve(`FAKE-AGE:${Buffer.from(plain).toString('base64')}`),
});
