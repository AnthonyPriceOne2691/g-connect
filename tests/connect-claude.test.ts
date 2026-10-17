/**
 * Подключение к Claude Code (`scripts/connect_claude.sh`, T12, X1) — на временном каталоге:
 * настоящие ~/.claude и ~/.claude.json тест не трогает. Вместо `claude` — фейк, который
 * пишет свои аргументы в журнал; стабильная сборка — файл во временном GCONNECT_STABLE_HOME.
 */

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

let home: string;
let claudeLog: string;
let env: Record<string, string>;

const run = (...args: string[]): string =>
  execFileSync('bash', ['scripts/connect_claude.sh', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const settings = async (): Promise<{ permissions: { allow: string[] } }> =>
  JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
    permissions: { allow: string[] };
  };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gconnect-claude-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, model: 'opus' }),
  );
  const stable = join(home, 'stable-home');
  await mkdir(join(stable, 'stable', 'dist', 'mcp'), { recursive: true });
  await writeFile(join(stable, 'stable', 'dist', 'mcp', 'server.js'), '// сборка');
  claudeLog = join(home, 'claude.log');
  const fake = join(home, 'fake-claude.sh');
  await writeFile(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${claudeLog}"\n`);
  await chmod(fake, 0o755);
  env = {
    CLAUDE_HOME: join(home, '.claude'),
    CLAUDE_JSON: join(home, '.claude.json'),
    CLAUDE_BIN: fake,
    GCONNECT_STABLE_HOME: stable,
  };
});

describe('connect_claude.sh — подключение ко всем проектам (X1)', () => {
  it('без --apply только показывает: ни файлов, ни вызовов claude', async () => {
    const out = run();
    expect(out).toContain('ничего не пишу');
    expect(out).toContain('mcp__g-connect__* — нет');
    expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
    await expect(readFile(claudeLog, 'utf8')).rejects.toThrow();
  });

  it('--apply: сервер уровня пользователя на стабильную сборку, правило, памятка, резервные копии', async () => {
    run('--apply');
    const calls = (await readFile(claudeLog, 'utf8')).trim().split('\n');
    expect(calls[0]).toBe('mcp remove g-connect --scope user');
    expect(calls[1]).toMatch(
      /^mcp add --scope user --transport stdio g-connect --env GCONNECT_ACCOUNT=default -- \S*node .*stable\/dist\/mcp\/server\.js$/,
    );
    const s = await settings();
    expect(s.permissions.allow).toEqual(['Bash(ls)', 'mcp__g-connect__*']);
    expect((s as unknown as { model: string }).model).toBe('opus');
    const memo = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(memo).toContain('открой G connect');
    expect(await readdir(join(home, '.claude', 'backups'))).toHaveLength(1);
  });

  it('ключ подписи передаётся серверу: GCONNECT_GRANT_KEY=irreversible', async () => {
    env = { ...env, GCONNECT_GRANT_KEY: 'irreversible' };
    run('--apply');
    const calls = (await readFile(claudeLog, 'utf8')).trim().split('\n');
    expect(calls[1]).toContain(
      'g-connect --env GCONNECT_ACCOUNT=default --env GCONNECT_GRANT_KEY=irreversible --',
    );
  });

  it('повторный --apply не дублирует ни правило, ни памятку; чужой текст памятки цел', async () => {
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Мои правила\n\nНе трогать.\n');
    run('--apply');
    run('--apply');
    expect(
      (await settings()).permissions.allow.filter((r) => r === 'mcp__g-connect__*'),
    ).toHaveLength(1);
    const memo = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(memo.match(/g-connect:begin/g)).toHaveLength(1);
    expect(memo.startsWith('# Мои правила\n\nНе трогать.\n')).toBe(true);
  });

  it('--disconnect --apply снимает ровно своё: правило, памятку, сервер', async () => {
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Мои правила\n');
    run('--apply');
    run('--disconnect', '--apply');
    expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
    const memo = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(memo).toBe('# Мои правила\n');
    expect((await readFile(claudeLog, 'utf8')).trim().split('\n').at(-1)).toBe(
      'mcp remove g-connect --scope user',
    );
  });

  it('стабильной сборки нет — отказ до любой правки', async () => {
    env = { ...env, GCONNECT_STABLE_HOME: join(home, 'nowhere') };
    expect(() => run('--apply')).toThrow(/стабильной сборки нет/);
    expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
  });
});
