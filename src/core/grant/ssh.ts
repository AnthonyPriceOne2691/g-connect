/**
 * Шов с `ssh-keygen` и агентом ключей (D-23) — единственное место, где ядро запускает
 * внешние программы ради разрешения.
 *
 * Пути — абсолютные, системные. Проверка через PATH приняла бы подложенный «ssh-keygen»,
 * который всегда отвечает «подпись верна»; `/usr/bin` на macOS защищён SIP. Окружение
 * дочернего процесса — минимальное и собранное здесь же: ни одна переменная сессии не
 * подменяет агента, к которому идёт подпись.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, type RunResult } from '../subprocess.js';

export const SSH_KEYGEN = '/usr/bin/ssh-keygen';
export const SSH_ADD = '/usr/bin/ssh-add';

/** Пространство подписи: подпись разрешения не годится ни для чего другого, и наоборот. */
export const GRANT_NAMESPACE = 'g-connect-grant';
const SIGNER = 'g-connect';

/** Временный каталог с правами 700 под файлы одного вызова; удаляется в любом исходе. */
async function withScratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'gconnect-grant-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `<тип> <base64>` без комментария — форма ключа для allowed_signers. */
export function keyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
}

/**
 * Подпись сходится с текстом и ключом — проверяет `ssh-keygen -Y verify`, а не наш код.
 * Ключ — тот, что передал вызывающий (агент Secretive), а не файл с диска.
 */
export async function verifySignature(
  text: string,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  return withScratch(async (dir) => {
    const signers = join(dir, 'allowed_signers');
    const sig = join(dir, 'grant.sig');
    await writeFile(signers, `${SIGNER} ${keyBody(publicKey)}\n`, { mode: 0o600 });
    await writeFile(sig, signature, { mode: 0o600 });
    const result = await run(
      SSH_KEYGEN,
      ['-Y', 'verify', '-f', signers, '-I', SIGNER, '-n', GRANT_NAMESPACE, '-s', sig],
      { input: text, timeoutMs: 10_000 },
    );
    return result.code === 0 && result.stdout.includes(`Good "${GRANT_NAMESPACE}" signature`);
  });
}

/**
 * Подписать текст. `keyFile` — закрытый ключ (тесты) или публичный при ключе в агенте
 * (`socket`): тогда подписывает агент, и macOS показывает Touch ID.
 */
export async function signText(
  text: string,
  key: { readonly file: string } | { readonly publicKey: string; readonly socket: string },
  timeoutMs: number,
): Promise<RunResult> {
  return withScratch(async (dir) => {
    let file: string;
    let env: Record<string, string> = {};
    if ('file' in key) {
      file = key.file;
    } else {
      file = join(dir, 'signer.pub');
      await writeFile(file, `${keyBody(key.publicKey)}\n`, { mode: 0o600 });
      env = { SSH_AUTH_SOCK: key.socket };
    }
    return run(SSH_KEYGEN, ['-Y', 'sign', '-f', file, '-n', GRANT_NAMESPACE], {
      input: text,
      env,
      timeoutMs,
    });
  });
}

/** Публичные ключи, которые отдаёт агент на сокете; пусто — агента нет или ключей нет. */
export async function agentKeys(socket: string): Promise<string[]> {
  const result = await run(SSH_ADD, ['-L'], { env: { SSH_AUTH_SOCK: socket }, timeoutMs: 5_000 });
  if (result.code !== 0) return [];
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}
