/**
 * Шифрование токена профиля ключом анклава (D-24): шов `age` плюс раскладка профиля.
 *
 * Получатель берётся из файла ключа профиля, а не из настроек: зашифровать для чужого ключа
 * можно, только подменив сам файл ключа, — и тогда расшифровать токен не сможет никто,
 * включая нас (отказ виден сразу, а не утечкой).
 */

import { readFile } from 'node:fs/promises';

import { gcError } from '../errors.js';
import { DEFAULT_ACCOUNT, identityPath, type TokenMeta, type TokenSealer } from '../profiles.js';
import { recipientInIdentity, sealFor, unsealWith, type AgeTools } from './age.js';

/** Расшифровать — окно Touch ID. Только этот путь открывает refresh-токен. */
export interface TokenUnsealer {
  unseal(sealed: string, meta: TokenMeta): Promise<string>;
}

/** Шифровальщик для ключа анклава профиля; ключа нет — отказ с действием «gc seal». */
export async function profileSealer(
  tools: AgeTools,
  account: string = DEFAULT_ACCOUNT,
): Promise<TokenSealer> {
  const file = identityPath(account);
  const recipient = recipientInIdentity(await readFile(file, 'utf8').catch(() => ''));
  if (recipient === undefined) {
    throw gcError('token_unsealed', {
      detail:
        `У профиля «${account}» нет ключа анклава (${file}). Владелец запускает в терминале ` +
        'npm run gc -- seal — он создаст ключ и зашифрует вход.',
      cause: 'no_identity',
    });
  }
  return { recipient, seal: (plain) => sealFor(tools, recipient, plain) };
}

export function profileUnsealer(tools: AgeTools, account: string = DEFAULT_ACCOUNT): TokenUnsealer {
  return {
    unseal: (sealed, meta) => unsealWith(tools, identityPath(account), sealed, meta.recipient),
  };
}
