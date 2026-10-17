/**
 * Шов `age` (D-24, слайс 1) — на НАСТОЯЩЕМ `age` с программным ключом X25519 (урок L32:
 * фейк шва согласен сам с собой). Ключ анклава и окно Touch ID здесь не судятся — только
 * живой прогон; таймер ожидания судит медленная программа-заглушка, и это названо в имени
 * теста.
 *
 * Без `age` на машине набор не молчит: пропуск называет, что не проверено (урок L29); в CI
 * `age` ставится.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ageToolsIn,
  createSeIdentity,
  findAgeTools,
  recipientInIdentity,
  requireAgeTools,
  sealFor,
  unsealWith,
  type AgeTools,
} from '../src/core/token/age.js';

const AGE_DIR = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].find(
  (dir) => existsSync(join(dir, 'age')) && existsSync(join(dir, 'age-keygen')),
);

/** Действительная по контрольной сумме строка получателя плагина `se` — плагин её не примет. */
const SE_RECIPIENT = 'age1se1qgqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqqtejdy';

let dir = '';
let tools: AgeTools;
let ownKey = '';
let ownRecipient = '';
let otherKey = '';
let otherRecipient = '';

const keygen = (file: string): string => {
  execFileSync(join(AGE_DIR ?? '', 'age-keygen'), ['-o', file], { stdio: 'ignore' });
  return execFileSync('/bin/sh', ['-c', `sed -n 's/^# public key: //p' "${file}"`])
    .toString()
    .trim();
};

const codeOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'нет ошибки',
    (error: { payload?: { code?: string; cause?: string } }) => error.payload,
  );

describe.skipIf(AGE_DIR === undefined)('шов age на настоящей программе', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gconnect-age-'));
    tools = ageToolsIn(AGE_DIR ?? '');
    ownKey = join(dir, 'own.txt');
    otherKey = join(dir, 'other.txt');
    ownRecipient = keygen(ownKey);
    otherRecipient = keygen(otherKey);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('U8: круг «зашифровать → расшифровать»; в шифротексте открытого текста нет', async () => {
    const plain = '{"refresh_token":"1//проба-секрета"}';
    const sealed = await sealFor(tools, ownRecipient, plain);
    expect(sealed.startsWith('-----BEGIN AGE ENCRYPTED FILE-----')).toBe(true);
    expect(sealed).not.toContain('проба-секрета');
    expect(await unsealWith(tools, ownKey, sealed, ownRecipient)).toBe(plain);
  });

  it('U8: чужой ключ — отказ «ключа нет, войди заново», а не мусор вместо токена', async () => {
    const sealed = await sealFor(tools, ownRecipient, 'секрет');
    expect(await codeOf(unsealWith(tools, otherKey, sealed, ownRecipient))).toMatchObject({
      code: 'auth_expired',
      cause: 'seal_key_gone',
    });
  });

  it('U6: «no identity matched» при ключе, совпавшем с получателем файла, — отказ касания', async () => {
    // Плагин анклава на отменённом касании пишет сообщение и продолжает, и `age` отвечает
    // тем же «no identity matched», что на чужом ключе. Метаданные называют получателем
    // ключ, который у нас есть, — значит, ключ на месте, а касания не было.
    const sealed = await sealFor(tools, ownRecipient, 'секрет');
    expect(await codeOf(unsealWith(tools, otherKey, sealed, otherRecipient))).toMatchObject({
      code: 'unlock_declined',
      cause: 'declined',
    });
  });

  it('U10: программы нет — seal_tool_missing с командой установки', async () => {
    const absent = ageToolsIn(join(dir, 'нет-такого-каталога'));
    const missing = await codeOf(sealFor(absent, ownRecipient, 'секрет'));
    expect(missing).toMatchObject({
      code: 'seal_tool_missing',
      cause: 'age_missing',
      detail: expect.stringContaining('brew install age age-plugin-se'),
    });
    expect(await codeOf(unsealWith(absent, ownKey, 'x', ownRecipient))).toMatchObject({
      code: 'seal_tool_missing',
    });
    expect(await codeOf(requireAgeTools(absent))).toMatchObject({ code: 'seal_tool_missing' });
  });

  it('U10: плагина нет на PATH ребёнка — seal_tool_missing, PATH сессии не подхватывается', async () => {
    // Обратный прогон: подложенный «плагин» в PATH сессии. Унаследуй ребёнок PATH сессии,
    // `age` запустил бы его, и ответ был бы другим — не «плагина нет».
    const fake = join(dir, 'session-bin');
    await mkdir(fake, { recursive: true });
    await writeFile(join(fake, 'age-plugin-se'), '#!/bin/sh\nexit 0\n');
    await chmod(join(fake, 'age-plugin-se'), 0o755);
    const saved = process.env['PATH'];
    process.env['PATH'] = `${fake}:${saved ?? ''}`;
    try {
      const noPlugin: AgeTools = { ...tools, path: '/usr/bin:/bin' };
      expect(await codeOf(sealFor(noPlugin, SE_RECIPIENT, 'секрет'))).toMatchObject({
        code: 'seal_tool_missing',
      });
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('отказ age — internal с его последней строкой, без «report unexpected»; не «нет программы»', async () => {
    const refused = (await codeOf(sealFor(tools, 'age1неверный', 'секрет'))) as { detail: string };
    expect(refused).toMatchObject({ code: 'internal', cause: 'age_seal_failed' });
    expect(refused.detail).not.toContain('report unexpected');
    const garbage = join(dir, 'garbage.txt');
    await writeFile(garbage, 'это не ключ\n');
    const sealed = await sealFor(tools, ownRecipient, 'секрет');
    expect(await codeOf(unsealWith(tools, garbage, sealed, ownRecipient))).toMatchObject({
      code: 'internal',
      cause: 'age_unseal_failed',
    });
  });

  it('плагин ищется по PATH ребёнка из каталога программ', async () => {
    // Заглушка плагина в каталоге программ: age её находит и падает на протоколе — это
    // не «плагина нет». Без PATH ребёнка из каталога ответ был бы «нет программы».
    const own = join(dir, 'tools-bin');
    await mkdir(own, { recursive: true });
    await writeFile(join(own, 'age-plugin-se'), '#!/bin/sh\nexit 0\n');
    await chmod(join(own, 'age-plugin-se'), 0o755);
    const withPlugin: AgeTools = { ...tools, path: `${own}:/usr/bin:/bin` };
    expect(await codeOf(sealFor(withPlugin, SE_RECIPIENT, 'секрет'))).toMatchObject({
      code: 'internal',
    });
  });

  it('получатель берётся из строки «# public key» файла ключа', async () => {
    expect(recipientInIdentity(await readFile(ownKey, 'utf8'))).toBe(ownRecipient);
    expect(recipientInIdentity('AGE-SECRET-KEY-1…')).toBeUndefined();
  });

  it('первый каталог, где есть age, — и первый из списка, если age нет нигде', async () => {
    expect((await findAgeTools([join(dir, 'пусто'), AGE_DIR ?? ''])).age).toBe(
      join(AGE_DIR ?? '', 'age'),
    );
    expect((await findAgeTools([join(dir, 'пусто')])).age).toBe(join(dir, 'пусто', 'age'));
  });
});

describe('шов age: таймер и создание ключа на заглушках', () => {
  let stub = '';

  beforeAll(async () => {
    stub = await mkdtemp(join(tmpdir(), 'gconnect-age-stub-'));
  });

  afterAll(async () => {
    await rm(stub, { recursive: true, force: true });
  });

  it('U6: окно без ответа — unlock_declined по таймеру, убита вся группа (заглушка с внуком)', async () => {
    // Внук держит наши потоки, как плагин с окном Touch ID: убить один `sh` — мало.
    await writeFile(join(stub, 'age'), '#!/bin/sh\nsleep 30 &\nwait\n');
    await chmod(join(stub, 'age'), 0o755);
    const started = Date.now();
    const result = await codeOf(unsealWith(ageToolsIn(stub), join(stub, 'key'), 'x', 'r', 1_500));
    expect(result).toMatchObject({
      code: 'unlock_declined',
      cause: 'timeout',
      detail: expect.stringContaining('Касания не было 2 с'),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('ключ анклава: доступ «палец или пароль», файл 600, получатель из файла (заглушка плагина)', async () => {
    // Настоящий keygen живёт только на Mac с анклавом и судится в живом прогоне `gc seal`;
    // здесь — что мы передаём плагину и что читаем из его файла.
    await writeFile(
      join(stub, 'age-plugin-se'),
      '#!/bin/sh\n[ "$2" = "--access-control=any-biometry-or-passcode" ] || exit 9\n' +
        'printf "# created: x\\n# public key: age1se1stub\\nAGE-PLUGIN-SE-1STUB\\n" > "$4"\n',
    );
    await chmod(join(stub, 'age-plugin-se'), 0o755);
    const file = join(stub, 'se-identity.txt');
    expect(await createSeIdentity(ageToolsIn(stub), file)).toBe('age1se1stub');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
