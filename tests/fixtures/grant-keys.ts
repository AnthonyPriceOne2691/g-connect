/**
 * Программные ключи для тестов разрешения (D-23): подпись — настоящий `/usr/bin/ssh-keygen`,
 * без агента и без пальца. Палец владельца проверяет только живой прогон (урок L15).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { GrantKeys } from '../../src/core/grant/grants.js';
import { signText } from '../../src/core/grant/ssh.js';

export const KEYGEN = '/usr/bin/ssh-keygen';

export interface SoftKey {
  readonly file: string;
  readonly pub: string;
}

export function makeKey(dir: string, name: string, comment: string): SoftKey {
  const file = join(dir, name);
  execFileSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
  return { file, pub: execFileSync(KEYGEN, ['-y', '-f', file], { encoding: 'utf8' }).trim() };
}

/** Ключи «владельца» из файла; `onSign` считает просьбы о касании. */
export function fileKeys(key: SoftKey, onSign: () => void = () => undefined): GrantKeys {
  return {
    keyName: 'G connect',
    signerKey: () => Promise.resolve(key.pub),
    sign: async (text, _publicKey, timeoutMs) => {
      onSign();
      const result = await signText(text, { file: key.file }, timeoutMs);
      return result.code === 0 ? result.stdout : undefined;
    },
  };
}
