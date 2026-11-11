/**
 * Свой `ssh-agent` теста не переживает тест (2026-10-22: владелец убил 814 агентов-сирот).
 *
 * Прежний тест гасил агент в `afterAll`, но воркер, убитый по таймауту мутанта, Ctrl-C или хуком,
 * до `afterAll` не доходит. Здесь владельца агента убивают по-настоящему, `kill -9`, и агент
 * обязан погаснуть сам: его держит сторож (`fixtures/test-agent.ts`), который ждёт конца канала
 * от владельца.
 */

import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_WATCHDOG, startTestAgent, until } from './fixtures/test-agent.js';

/** Жив ли процесс, в командной строке которого есть путь сокета. */
function agentAlive(socket: string): boolean {
  try {
    execFileSync('/usr/bin/pgrep', ['-f', socket], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const socketGone = async (socket: string): Promise<boolean> =>
  (await stat(socket).catch(() => null)) === null && !agentAlive(socket);

describe('ssh-agent теста — под сторожем', () => {
  it('stop(): агент гаснет, сокета и процесса нет', async () => {
    const agent = await startTestAgent(await mkdtemp(join(tmpdir(), 'gconnect-agent-')));
    expect(agentAlive(agent.socket)).toBe(true);
    await agent.stop();
    await until(() => socketGone(agent.socket));
  });

  it('владелец агента убит kill -9 до afterAll — агент гаснет сам, сироты нет', async () => {
    const socket = join(await mkdtemp(join(tmpdir(), 'gconnect-agent-')), 'agent.sock');
    // Владелец — отдельный процесс node: его убиваем так, как Stryker убивает воркер.
    const owner = spawn(
      process.execPath,
      [
        '-e',
        "require('node:child_process').spawn('/bin/sh', ['-c', process.env.WATCHDOG, 'sh', " +
          "process.env.SOCKET], { stdio: ['pipe', 'ignore', 'ignore'] }); setInterval(() => {}, 1000);",
      ],
      { env: { ...process.env, WATCHDOG: AGENT_WATCHDOG, SOCKET: socket }, stdio: 'ignore' },
    );
    await until(async () => (await stat(socket).catch(() => null)) !== null);
    expect(agentAlive(socket)).toBe(true);
    owner.kill('SIGKILL');
    await until(() => socketGone(socket));
  });

  it('свой ssh-agent тесты запускают только через сторожа', () => {
    const files = readdirSync('tests', { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.ts'),
    );
    const direct = files.filter(
      (file) =>
        // Сторож и этот страж — единственные, где путь агента стоит в коде.
        ![join('fixtures', 'test-agent.ts'), 'test-agent.test.ts'].includes(file) &&
        readFileSync(join('tests', file), 'utf8').includes("'/usr/bin/ssh-agent'"),
    );
    expect(direct).toEqual([]);
  });
});
