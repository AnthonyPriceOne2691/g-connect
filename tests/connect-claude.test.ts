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

import { serverName } from '../src/core/profile-names.js';

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
    expect(calls[1]).toBe('mcp remove g-connect --scope local');
    // X12: репозиторий G connect получает local-запись на свою dev-сборку `dist/`.
    expect(calls[3]).toMatch(
      /^mcp add --scope local --transport stdio g-connect --env GCONNECT_ACCOUNT=default -- \S*node .*\/dist\/mcp\/server\.js$/,
    );
    expect(calls[3]).not.toContain('stable');
    expect(calls[2]).toMatch(
      /^mcp add --scope user --transport stdio g-connect --env GCONNECT_ACCOUNT=default -- \S*node .*stable\/dist\/mcp\/server\.js$/,
    );
    const s = await settings();
    expect(s.permissions.allow).toEqual(['Bash(ls)', 'mcp__g-connect__*']);
    expect((s as unknown as { model: string }).model).toBe('opus');
    const memo = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(memo).toContain('открой G connect');
    // D-24: памятка ведёт к Google через инструменты и называет строку перед окном.
    expect(memo).toContain('gc_unlock');
    expect(memo).toContain('G connect\n  попросит палец');
    expect(await readdir(join(home, '.claude', 'backups'))).toHaveLength(1);
  });

  it('ключ подписи передаётся серверу: GCONNECT_GRANT_KEY=irreversible', async () => {
    env = { ...env, GCONNECT_GRANT_KEY: 'irreversible' };
    run('--apply');
    const calls = (await readFile(claudeLog, 'utf8')).trim().split('\n');
    expect(calls[2]).toContain(
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
    expect((await readFile(claudeLog, 'utf8')).trim().split('\n').slice(-2)).toEqual([
      'mcp remove g-connect --scope user',
      'mcp remove g-connect --scope local',
    ]);
  });

  it('стабильной сборки нет — отказ до любой правки', async () => {
    env = { ...env, GCONNECT_STABLE_HOME: join(home, 'nowhere') };
    expect(() => run('--apply')).toThrow(/стабильной сборки нет/);
    expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
  });
});

describe('connect_claude.sh — два профиля рядом (D-25)', () => {
  const profilesHome = (): string => join(home, 'gconnect');
  const withProfiles = async (...names: string[]): Promise<void> => {
    for (const name of names) await mkdir(join(profilesHome(), name), { recursive: true });
    env = { ...env, GCONNECT_HOME: profilesHome() };
  };
  const calls = async (): Promise<string[]> =>
    (await readFile(claudeLog, 'utf8')).trim().split('\n');
  const memo = (): Promise<string> => readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');

  it('W1: --profiles=default,work — по серверу на профиль, user и local, правило на каждый', async () => {
    await withProfiles('work');
    env = { ...env, GCONNECT_GRANT_KEY: 'irreversible' };
    run('--profiles=default,work', '--apply');
    const adds = (await calls()).filter((c) => c.startsWith('mcp add'));
    expect(adds).toHaveLength(4);
    expect(adds[0]).toContain(
      '--scope user --transport stdio g-connect --env GCONNECT_ACCOUNT=default --env GCONNECT_GRANT_KEY=irreversible --',
    );
    expect(adds[2]).toContain(
      '--scope user --transport stdio g-connect-work --env GCONNECT_ACCOUNT=work --env GCONNECT_GRANT_KEY=irreversible --',
    );
    expect(adds[3]).toMatch(
      /--scope local .* g-connect-work .* -- \S*node .*\/dist\/mcp\/server\.js$/,
    );
    expect((await settings()).permissions.allow).toEqual([
      'Bash(ls)',
      'mcp__g-connect__*',
      'mcp__g-connect-work__*',
    ]);
  });

  it('W1: показ со списком подсказывает команду с тем же списком — иначе подключится один личный', async () => {
    await withProfiles('work');
    expect(run('--profiles=default,work')).toContain(
      'Сделать: scripts/connect_claude.sh --profiles=default,work --apply',
    );
    expect(run()).toContain('Сделать: scripts/connect_claude.sh --apply');
  });

  it('W9: памятка называет оба сервера и правило выбора — без адресов и названий файлов', async () => {
    await withProfiles('work');
    run('--profiles=default,work', '--apply');
    const text = await memo();
    expect(text).toContain('`mcp__g-connect__*` — профиль default');
    expect(text).toContain('`mcp__g-connect-work__*` — профиль work');
    expect(text).toContain('Не знаешь, чей файл, —\n  спроси человека');
    expect(text).toContain('«G connect (work) попросит палец…»');
    expect(text).not.toMatch(/@|docs\.google|spreadsheets\//);
    expect(text.match(/g-connect:begin/g)).toHaveLength(1);
  });

  it('W8: --disconnect --apply снимает оба сервера (user и local), оба правила и памятку', async () => {
    await withProfiles('work');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Мои правила\n');
    run('--profiles=default,work', '--apply');
    run('--disconnect', '--apply');
    const removes = (await calls()).slice(-4);
    expect(removes).toEqual([
      'mcp remove g-connect --scope user',
      'mcp remove g-connect --scope local',
      'mcp remove g-connect-work --scope user',
      'mcp remove g-connect-work --scope local',
    ]);
    expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
    expect(await memo()).toBe('# Мои правила\n');
  });

  it('W10: без списка — один g-connect, памятка без профилей, как до D-25', async () => {
    run('--apply');
    expect((await calls()).filter((c) => c.includes('g-connect-'))).toEqual([]);
    const text = await memo();
    expect(text).toContain('Инструменты `mcp__g-connect__*` есть в каждом проекте');
    expect(text).not.toContain('профиль default');
  });

  it('опечатка, дубль, неизвестный профиль, список при отключении — отказ до любой правки', async () => {
    await withProfiles('work');
    expect(() => run('--profiles=default,Work', '--apply')).toThrow(/строчная латиница/);
    expect(() => run('--profiles=work,work', '--apply')).toThrow(/назван дважды/);
    expect(() => run('--profiles=default,ghost', '--apply')).toThrow(/профиля «ghost» нет/);
    expect(() => run('--disconnect', '--profiles=work', '--apply')).toThrow(/список профилей/);
    expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
    await expect(readFile(claudeLog, 'utf8')).rejects.toThrow();
  });

  it('имя сервера у скрипта и у ядра — одно правило (L21)', async () => {
    await withProfiles('work', 'team-2');
    run('--profiles=default,work,team-2', '--apply');
    const registered = (await calls())
      .filter((c) => c.startsWith('mcp add --scope user'))
      .map((c) => c.split(' ')[6]);
    expect(registered).toEqual(['default', 'work', 'team-2'].map(serverName));
  });
});
