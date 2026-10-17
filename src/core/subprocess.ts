/**
 * Запуск внешних программ ядром: подпись разрешения (D-23) и шифрование токена (D-24).
 *
 * Окружение ребёнка собирается из минимума, а не наследуется: ни одна переменная сессии не
 * подменяет агента ключей или программу, к которой идёт секрет. Ожидание — с убийством
 * процесса по таймеру: окно Touch ID без ответа не держит вызов вечно.
 */

import { spawn } from 'node:child_process';

const BASE_ENV = { PATH: '/usr/bin:/bin' };

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly input?: string;
  /** Поверх минимума `PATH=/usr/bin:/bin`; свой `PATH` его заменяет. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    // Своя группа процессов — чтобы таймер убил и внуков: `age` запускает плагин, плагин
    // держит окно Touch ID и наши потоки. Убитый один `age` оставлял бы вызов ждать
    // закрытия потоков, пока плагин не выйдет сам (замер: заглушка `sh` → `sleep 30`).
    const child = spawn(command, args, {
      env: { ...BASE_ENV, ...options.env },
      stdio: 'pipe',
      detached: options.timeoutMs !== undefined,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const settle = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra, timedOut });
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killGroup(child.pid, () => child.kill('SIGKILL'));
            // Ответ — сразу, а не по закрытию потоков: их может держать внук.
            settle(null);
          }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => settle(null, error.message));
    child.on('close', (code) => settle(code));
    // Ребёнок, закрывший stdin раньше, чем мы дописали, — не наша ошибка: его ответ
    // придёт кодом возврата, а EPIPE без обработчика уронил бы весь процесс сервера.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

/** Убить группу процессов ребёнка; группы нет (не успел родиться) — его одного. */
function killGroup(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return fallback();
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}
