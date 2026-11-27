/**
 * Подпись окна Touch ID (D-24, 27.11; J2–J8) — на заглушках `age` и плагина (`fixtures/finger.ts`).
 * Имя файла, которым запущена заглушка плагина, — то самое имя, которое macOS пишет в окне; само
 * окно и ключ анклава судит только живой прогон J1 (live-run.md).
 */

import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ageToolsIn,
  unsealWith,
  type AgeTools,
  type UnsealOptions,
} from '../src/core/token/age.js';
import {
  fingerFileName,
  fingerWindow,
  prepareFinger,
  shimText,
  type FingerWindow,
} from '../src/core/token/finger-window.js';
import { profileUnsealer } from '../src/core/token/sealing.js';
import {
  IDENTITY_CALL,
  STUB_META,
  agePrinted,
  pluginScript,
  stubPrograms,
  writeProgram,
} from './fixtures/finger.js';

const LABEL = 'G connect (work)';
const NAMED = `v1|${LABEL}|${IDENTITY_CALL}`;
const BARE = `v1|age-plugin-se|${IDENTITY_CALL}`;
const SLOW_AGE = '#!/bin/sh\nsleep 30 &\nwait\n';
const NOTE = 'Окно было без подписи G connect («age-plugin-se»):';

let root = '';
let bin = '';
let tools: AgeTools;
let window: FingerWindow;

const unsealRaw = (options: UnsealOptions = {}): Promise<string> =>
  unsealWith(tools, join(root, 'key'), 'x', 'r', options);

const unseal = async (options: UnsealOptions = {}) => agePrinted(await unsealRaw(options));

const codeOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'нет ошибки',
    (error: { payload?: { code?: string; cause?: string; detail?: string } }) => error.payload,
  );

/** Переменные окружения на время теста — и обратно, даже если тест упал. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gconnect-finger-'));
  bin = await stubPrograms(root);
  tools = ageToolsIn(bin);
  window = { dir: join(root, 'profile', 'finger'), label: LABEL };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('подпись окна: копия плагина под именем профиля (J2, J3, J8)', () => {
  it('J2: папка подписи — первой в PATH расшифровки, плагин запущен копией с именем окна', async () => {
    expect(await unseal({ window })).toEqual({
      path: `${window.dir}:${bin}:/usr/bin:/bin`,
      plugin: NAMED,
    });
  });

  it('J2: без окна — PATH и плагин прежние', async () => {
    expect(await unseal()).toEqual({ path: `${bin}:/usr/bin:/bin`, plugin: BARE });
  });

  it('J2: прокладка отдаёт keygen, шифрование и прочее настоящему плагину', async () => {
    expect(await prepareFinger(tools.plugin, window)).toEqual({ dir: window.dir });
    const call = (...args: string[]): string =>
      execFileSync(join(window.dir, 'age-plugin-se'), args).toString();
    expect(call('keygen', '-o', 'x')).toBe('v1|age-plugin-se|keygen -o x');
    expect(call('--age-plugin=recipient-v1')).toBe('v1|age-plugin-se|--age-plugin=recipient-v1');
    expect(call()).toBe('v1|age-plugin-se|');
    expect(call(IDENTITY_CALL)).toBe(NAMED);
  });

  it('J2: в папке ровно копия и прокладка, всё 700, прокладка — с вписанными путями', async () => {
    await mkdir(window.dir, { recursive: true });
    await chmod(window.dir, 0o755);
    await unseal({ window });
    const copy = join(window.dir, LABEL);
    const shim = join(window.dir, 'age-plugin-se');
    expect((await readdir(window.dir)).sort()).toEqual([LABEL, 'age-plugin-se']);
    for (const path of [window.dir, copy, shim]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(shim, 'utf8')).toBe(shimText(copy, tools.plugin));
    expect(await readFile(copy, 'utf8')).toBe(pluginScript('v1'));
  });

  it('J2: прокладка без копии отдаёт и расшифровку настоящему плагину', async () => {
    await prepareFinger(tools.plugin, window);
    await rm(join(window.dir, LABEL));
    expect(execFileSync(join(window.dir, 'age-plugin-se'), [IDENTITY_CALL]).toString()).toBe(BARE);
  });

  it('J3: плагин обновился — следующая расшифровка запускает свежую копию', async () => {
    await unseal({ window });
    await writeProgram(tools.plugin, pluginScript('v2'));
    expect((await unseal({ window })).plugin).toBe(`v2|${LABEL}|${IDENTITY_CALL}`);
  });

  it('J8: плагин — ссылка на Cellar, копия — обычный файл; прокладка зовёт ссылку Homebrew', async () => {
    const cellar = join(root, 'cellar');
    await mkdir(cellar);
    await writeProgram(join(cellar, 'age-plugin-se'), pluginScript('cellar'));
    await rm(tools.plugin);
    await symlink(join(cellar, 'age-plugin-se'), tools.plugin);
    expect((await unseal({ window })).plugin).toBe(`cellar|${LABEL}|${IDENTITY_CALL}`);
    expect((await lstat(join(window.dir, LABEL))).isFile()).toBe(true);
    // Настоящий плагин — по пути Homebrew, а не Cellar: `brew upgrade` прокладку не ломает.
    expect(await readFile(join(window.dir, 'age-plugin-se'), 'utf8')).toContain(
      `exec '${tools.plugin}' "$@"`,
    );
  });
});

describe('подпись окна не мешает расшифровке (J4)', () => {
  it('J4: вместо папки подписи файл — расшифровка идёт настоящим плагином, PATH прежний', async () => {
    await writeFile(join(root, 'profile'), 'не папка');
    expect(await unseal({ window })).toEqual({ path: `${bin}:/usr/bin:/bin`, plugin: BARE });
  });

  it.each([
    ['пустая', ''],
    ['одни пробелы и управляющие знаки', ' \t\n'],
    ['скрытое имя', '.G connect'],
    ['имя самой прокладки', 'age-plugin-se'],
    ['одни косые черты', '//'],
  ])('J4: подпись не годится в имя файла (%s) — папка не тронута', async (_, label) => {
    expect(await prepareFinger(tools.plugin, { ...window, label })).toEqual({
      failed: `подпись «${label}» не годится в имя файла`,
    });
    await expect(stat(window.dir)).rejects.toThrow();
  });

  it('J4: «:» в пути папки разрезал бы PATH — папка не тронута', async () => {
    const dir = join(root, 'a:b', 'finger');
    expect(await prepareFinger(tools.plugin, { dir, label: LABEL })).toEqual({
      failed: `в пути папки подписи «:» — PATH его разрежет (${dir})`,
    });
    await expect(stat(dir)).rejects.toThrow();
  });

  it('J4: нет плагина — причина названа', async () => {
    await rm(tools.plugin);
    expect(await prepareFinger(tools.plugin, window)).toEqual({
      failed: expect.stringMatching(/^папка подписи не подготовлена: .*ENOENT/),
    });
  });

  it('J4: запись копии сорвалась — обрывка .part-* не остаётся', async () => {
    await mkdir(join(window.dir, LABEL, 'занято'), { recursive: true });
    expect(await prepareFinger(tools.plugin, window)).toEqual({
      failed: expect.stringMatching(/^папка подписи не подготовлена: /),
    });
    expect(await readdir(window.dir)).toEqual([LABEL]);
  });

  it('J4: касания нет, окно было без подписи — unlock_declined называет причину', async () => {
    await writeProgram(tools.age, SLOW_AGE);
    await writeFile(join(root, 'profile'), 'не папка');
    expect(await codeOf(unsealRaw({ window, timeoutMs: 1_000 }))).toMatchObject({
      code: 'unlock_declined',
      cause: 'timeout',
      detail: expect.stringMatching(
        /^Касания не было 1 с — Google не открыт\. Окно было без подписи G connect \(«age-plugin-se»\): папка подписи не подготовлена: .+\.$/,
      ),
    });
  });

  it('J4: касания нет, окно с подписью — текст отказа прежний', async () => {
    await writeProgram(tools.age, SLOW_AGE);
    expect(await codeOf(unsealRaw({ window, timeoutMs: 1_000 }))).toMatchObject({
      cause: 'timeout',
      detail: 'Касания не было 1 с — Google не открыт.',
    });
  });

  it('J4: касание отменено — причина окна без подписи дописана, с подписью — нет', async () => {
    await writeProgram(
      tools.age,
      '#!/bin/sh\necho "age: error: no identity matched any of the recipients" >&2\nexit 1\n',
    );
    await writeFile(join(root, 'key'), '# public key: r\nAGE-PLUGIN-SE-1STUB\n');
    const plain =
      'Касание отменено или не прошло — Google не открыт. Повторяется после касания — ' +
      'ключ анклава недоступен, поможет новый вход (gc login).';
    expect(await codeOf(unsealRaw({ window }))).toMatchObject({ cause: 'declined', detail: plain });
    expect(await codeOf(unsealRaw({ window: { ...window, label: '' } }))).toMatchObject({
      code: 'unlock_declined',
      cause: 'declined',
      detail: `${plain} ${NOTE} подпись «» не годится в имя файла.`,
    });
  });
});

describe('подпись окна среди соседей (J5–J7)', () => {
  it('J5: три сервера одного профиля разом — все расшифровали копией, в папке ни обрывка', async () => {
    const results = await Promise.all([1, 2, 3].map(() => unseal({ window })));
    expect(results.map((result) => result.plugin)).toEqual([NAMED, NAMED, NAMED]);
    expect((await readdir(window.dir)).sort()).toEqual([LABEL, 'age-plugin-se']);
  });

  it('J6: чужие FINGER_LABEL и PATH сессии не меняют ни имени окна, ни плагина', async () => {
    const evil = join(root, 'evil');
    await mkdir(evil);
    await writeProgram(join(evil, 'age-plugin-se'), pluginScript('чужой'));
    await withEnv(
      { FINGER_LABEL: 'Чужое окно', PATH: `${evil}:${process.env['PATH'] ?? ''}` },
      async () => {
        expect((await unseal({ window })).plugin).toBe(NAMED);
      },
    );
  });

  it('J7: пробелы, скобки и апостроф в пути — прокладка запускает копию', async () => {
    const odd = { dir: join(root, "it's (a) test", 'finger'), label: LABEL };
    expect((await unseal({ window: odd })).plugin).toBe(NAMED);
  });
});

describe('имя окна и папка профиля', () => {
  it('имя файла — без косой черты, управляющих знаков и пробелов по краям', () => {
    expect(fingerFileName('G connect (a/b)')).toBe('G connect (ab)');
    expect(fingerFileName(' \tG connect\u0007 (work)\n ')).toBe('G connect (work)');
  });

  it('папка — рядом с ключом профиля, имя окна — словами строки перед ним', async () => {
    await withEnv({ GCONNECT_HOME: root }, async () => {
      expect(fingerWindow('work')).toEqual({ dir: join(root, 'work', 'finger'), label: LABEL });
      expect(fingerWindow('default')).toEqual({
        dir: join(root, 'default', 'finger'),
        label: 'G connect',
      });
    });
  });

  it('расшифровка профилем называет окно профиля (sealing)', async () => {
    const home = join(root, 'home');
    await withEnv({ GCONNECT_HOME: home }, async () => {
      const printed = agePrinted(await profileUnsealer(tools, 'work').unseal('x', STUB_META));
      expect(printed).toEqual({
        path: `${join(home, 'work', 'finger')}:${bin}:/usr/bin:/bin`,
        plugin: NAMED,
      });
    });
  });
});
