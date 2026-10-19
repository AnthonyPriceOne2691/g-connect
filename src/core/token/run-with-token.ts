/**
 * `gc run -- <команда>` (D-24, решение владельца): запасной ход для того, чего G connect не
 * умеет, — письма, доступ по ссылке, комментарии. Касание открывает Google, и команда
 * получает access-токен на ≤1 ч в `GOOGLE_ACCESS_TOKEN`. Refresh-токен не выдаётся никому:
 * его нет ни в окружении, ни в аргументах. Пока команда работает, переменную видят
 * программы того же пользователя — до часа; это названо в спеке.
 */

import { spawn } from 'node:child_process';

import { gcError } from '../errors.js';
import type { TokenVault } from './vault.js';

export const ACCESS_TOKEN_ENV = 'GOOGLE_ACCESS_TOKEN';

/** Запуск ребёнка с общим терминалом; код возврата — его, сигнал — 128 + номер. */
export type InheritSpawn = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<number>;

const SIGNAL_BASE = 128;

export const spawnInherit: InheritSpawn = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', (error) =>
      reject(
        gcError('bad_request', {
          detail: `Команду не запустить: ${command} — ${error.message}`,
          cause: 'run_spawn_failed',
        }),
      ),
    );
    child.on('exit', (code, signal) =>
      resolve(code ?? SIGNAL_BASE + (signal === null ? 0 : signalNumber(signal))),
    );
  });

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return numbers[signal] ?? 1;
}

export async function runWithAccessToken(
  vault: TokenVault,
  command: string,
  args: readonly string[],
  baseEnv: Readonly<Record<string, string>>,
  launch: InheritSpawn = spawnInherit,
): Promise<number> {
  await vault.unlock();
  const env = { ...baseEnv, [ACCESS_TOKEN_ENV]: vault.accessToken() };
  return launch(command, args, env);
}
