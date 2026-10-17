/**
 * Запуск внешних программ ядром (D-23, D-24): окружение ребёнка — минимум, а не окружение
 * сессии; таймер убивает всю группу; ребёнок, бросивший stdin, процесс не роняет.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run } from '../src/core/subprocess.js';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gconnect-run-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('run: внешняя программа под присмотром', () => {
  it('окружение ребёнка — PATH=/usr/bin:/bin и только названное; сессия не наследуется', async () => {
    process.env['GCONNECT_SESSION_PROBE'] = 'утечка';
    try {
      expect((await run('/usr/bin/env', [])).stdout.trim()).toBe('PATH=/usr/bin:/bin');
      const named = (await run('/usr/bin/env', [], { env: { X: '1' } })).stdout;
      expect(named.split('\n').sort()).toEqual(['', 'PATH=/usr/bin:/bin', 'X=1']);
    } finally {
      delete process.env['GCONNECT_SESSION_PROBE'];
    }
  });

  it('без таймера — обычный ответ; без входа stdin пуст', async () => {
    expect(await run('/bin/echo', ['привет'])).toEqual({
      code: 0,
      stdout: 'привет\n',
      stderr: '',
      timedOut: false,
    });
    expect((await run('/bin/cat', [])).stdout).toBe('');
  });

  it('ребёнок, не читающий stdin, процесс не роняет: ответ — его код', async () => {
    expect((await run('/usr/bin/true', [], { input: 'x'.repeat(2_000_000) })).code).toBe(0);
  });

  it('таймер убивает всю группу: внук, державший потоки, мёртв', async () => {
    const stub = join(dir, 'hold.sh');
    const pidFile = join(dir, 'grandchild.pid');
    await writeFile(stub, '#!/bin/sh\nsleep 30 &\necho $! > "$1"\nwait\n');
    await chmod(stub, 0o755);
    // Полторы секунды: первый запуск свежего скрипта macOS проверяет, и 300 мс не хватало.
    const result = await run(stub, [pidFile], { timeoutMs: 1_500 });
    expect(result.timedOut).toBe(true);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
