/**
 * Свой `ssh-agent` для теста — и он не переживает тест.
 *
 * 2026-10-22 владелец убил 814 зависших агентов. Тест запускал `ssh-agent -D` и гасил его в
 * `afterAll`, но `afterAll` не выполняется, когда воркер теста убит: таймаут мутанта Stryker,
 * Ctrl-C, убитый хук. Агент в режиме `-D` переезжал к launchd и жил до перезагрузки, а мутации
 * гоняют тесты тысячи раз.
 *
 * Поэтому агент живёт под сторожем. `sh` держит канал stdin от процесса теста. Когда канал
 * закрылся — тест кончился, упал или его убили, — сторож гасит агент. SIGINT и SIGQUIT сторож
 * пропускает: фоновому агенту в неинтерактивном `sh` они и так не доходят. На SIGTERM и SIGHUP
 * сторож гасит агент сам. Не переживёт только `kill -9` самого сторожа.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Сторож: агент в фоне, ожидание конца stdin, затем агент гаснет. `$1` — путь сокета. */
export const AGENT_WATCHDOG = [
  '/usr/bin/ssh-agent -D -a "$1" &',
  'a=$!',
  'trap \'kill "$a" 2>/dev/null; exit 0\' TERM HUP',
  "trap '' INT QUIT",
  'read _',
  'kill "$a" 2>/dev/null',
  'wait "$a"',
].join('\n');

export interface TestAgent {
  readonly socket: string;
  /** Погасить агент и дождаться, пока сторож выйдет: после него процессов не остаётся. */
  stop(): Promise<void>;
}

/** Агент с сокетом в `dir`; готов, когда сокет появился. */
export async function startTestAgent(dir: string): Promise<TestAgent> {
  const socket = join(dir, 'agent.sock');
  const watchdog: ChildProcess = spawn('/bin/sh', ['-c', AGENT_WATCHDOG, 'sh', socket], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  await until(async () => (await stat(socket).catch(() => null)) !== null);
  return {
    socket,
    async stop() {
      if (watchdog.exitCode !== null || watchdog.signalCode !== null) return;
      const exited = once(watchdog, 'exit');
      watchdog.stdin?.end();
      await exited;
    },
  };
}

/** Ждать условия до ~5 с; не дождались — ошибка, а не тихий пропуск. */
export async function until(ready: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('test-agent: не дождался условия за 5 секунд');
}
