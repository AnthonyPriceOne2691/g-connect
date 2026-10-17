/**
 * Ключи разрешения живьём — агент Secretive (D-23).
 *
 * Сокет — путь контейнера Secretive, а не `SSH_AUTH_SOCK` сессии: переменную задаёт
 * окружение, и подставленный в неё свой агент с программным ключом подписывал бы без
 * пальца. Secretive отдаёт только ключи Secure Enclave; с Require Authentication каждая
 * подпись спрашивает Touch ID.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { GrantKeys } from './grants.js';
import { agentKeys, signText } from './ssh.js';

export const SECRETIVE_SOCKET = join(
  homedir(),
  'Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh',
);

/** Имя ключа, как его сверяем: регистр и пробелы не различаются («G connect» = «g-connect»). */
export function keyNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * Имя ключа из строки агента. Secretive пишет комментарий `<имя>@secretive.<хост>` —
 * замер 2026-10-17: `irreversible@secretive.MacBook-Air.local`.
 */
export function agentKeyName(line: string): string | undefined {
  const comment = line.trim().split(/\s+/).slice(2).join(' ');
  const at = comment.lastIndexOf('@secretive.');
  return at > 0 ? comment.slice(0, at) : undefined;
}

export function secretiveKeys(keyName: string, socket: string = SECRETIVE_SOCKET): GrantKeys {
  const wanted = keyNameKey(keyName);
  return {
    keyName,
    async signerKey() {
      const lines = await agentKeys(socket);
      return lines.find((line) => {
        const name = agentKeyName(line);
        return name !== undefined && keyNameKey(name) === wanted;
      });
    },
    async sign(text, publicKey, timeoutMs) {
      const result = await signText(text, { publicKey, socket }, timeoutMs);
      return result.code === 0 && !result.timedOut ? result.stdout : undefined;
    },
  };
}
