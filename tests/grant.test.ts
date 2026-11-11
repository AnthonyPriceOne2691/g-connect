/**
 * Разрешение проекта касанием (D-23, слайс 2): документ, подпись, проверка, хранение.
 *
 * Подпись и проверку гоняет НАСТОЯЩИЙ `/usr/bin/ssh-keygen` с программными ключами (урок
 * L23: фейк шва согласен сам с собой). Подменён только источник ключа — агент Secretive;
 * его путь проверяется настоящим `ssh-agent`. Палец владельца здесь не проверяется — это
 * живой прогон X3 (урок L15).
 */

import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  GRANT_HEADER,
  endOfLocalDay,
  grantText,
  newGrant,
  parseGrantText,
  projectKey,
  type GrantDocument,
} from '../src/core/grant/document.js';
import {
  currentGrant,
  grantsDir,
  issueGrant,
  listGrants,
  revokeGrant,
  type GrantKeys,
} from '../src/core/grant/grants.js';
import {
  SECRETIVE_SOCKET,
  agentKeyName,
  keyNameKey,
  secretiveKeys,
} from '../src/core/grant/secretive.js';
import { GcError } from '../src/core/errors.js';
import { KEYGEN, fileKeys, makeKey, type SoftKey } from './fixtures/grant-keys.js';
import { startTestAgent, type TestAgent } from './fixtures/test-agent.js';

const PROJECT_A = '/Users/someone/Documents/Ahrefs cases';
const PROJECT_B = '/Users/someone/Documents/portfolio-site';
const NOON = new Date(2026, 9, 17, 12, 0, 0);

let keysDir: string;
let owner: SoftKey;
let stranger: SoftKey;

/** Агент жив, но ключа «G connect» у него нет. */
const noKey = (key: SoftKey): GrantKeys => ({
  ...fileKeys(key),
  signerKey: () => Promise.resolve(undefined),
});

const sign = async (
  key: { file: string },
  text: string,
  namespace = 'g-connect-grant',
): Promise<string> =>
  execFileSync(KEYGEN, ['-Y', 'sign', '-f', key.file, '-n', namespace], {
    input: text,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });

const plant = async (project: string, text: string, signature: string): Promise<void> => {
  await mkdir(grantsDir('default'), { recursive: true });
  await writeFile(
    join(grantsDir('default'), `${projectKey(project)}.json`),
    JSON.stringify({ text, signature }),
  );
};

const original = process.env['GCONNECT_HOME'];

beforeAll(async () => {
  keysDir = await mkdtemp(join(tmpdir(), 'gconnect-keys-'));
  owner = makeKey(keysDir, 'owner', 'G connect@secretive.test-host');
  stranger = makeKey(keysDir, 'stranger', 'evil@elsewhere');
});

beforeEach(async () => {
  process.env['GCONNECT_HOME'] = await mkdtemp(join(tmpdir(), 'gconnect-grant-home-'));
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

describe('документ разрешения', () => {
  const doc: GrantDocument = newGrant(PROJECT_A, 'default', NOON);

  it('текст разбирается обратно в тот же документ — и для путей с пробелами и юникодом', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !s.includes('\n') && s === s.trim()),
        (project) => {
          const grant = newGrant(`/Users/x/${project}`, 'default', NOON);
          expect(parseGrantText(grantText(grant))).toEqual(grant);
        },
      ),
    );
  });

  it('срок — 23:59:59 местного дня выдачи; касание в последнюю секунду — до конца следующего', () => {
    expect(new Date(Date.parse(doc.expires))).toEqual(endOfLocalDay(NOON));
    const lastSecond = new Date(2026, 9, 17, 23, 59, 59, 500);
    const late = newGrant(PROJECT_A, 'default', lastSecond);
    expect(new Date(Date.parse(late.expires))).toEqual(new Date(2026, 9, 18, 23, 59, 59));
    expect(parseGrantText(grantText(late))).toEqual(late);
  });

  it('любое отклонение формы — не документ: лишняя строка, порядок, пробел, срок длиннее суток', () => {
    const text = grantText(doc);
    const lines = text.trimEnd().split('\n');
    const variants = [
      `${text}extra: 1\n`,
      `${[lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n')}\n`,
      text.replace('scope: own', 'scope: all'),
      text.replace('account: default', 'account: default '),
      text.replace(/nonce: \w+/, 'nonce: 123'),
      text.replace(doc.expires, '2026-10-19T23:59:59+03:00'),
      text.replace(GRANT_HEADER, 'g-connect grant 2'),
      text.trimEnd(),
    ];
    for (const variant of variants) expect(parseGrantText(variant)).toBeUndefined();
  });
});

describe('выдача и проверка (X3)', () => {
  it('подпись пальцем → разрешение до 23:59 этого проекта; файл 600, каталог 700', async () => {
    const grant = await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    const state = await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    expect(state).toEqual({ state: 'granted', grant });
    const file = join(grantsDir('default'), `${projectKey(PROJECT_A)}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(grantsDir('default'))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, 'utf8')).not.toContain('token');
  });

  it('отмена касания или тишина — grant_declined, файла нет', async () => {
    const declining: GrantKeys = { ...fileKeys(owner), sign: () => Promise.resolve(undefined) };
    await expect(issueGrant(declining, PROJECT_A, 'default', NOON)).rejects.toMatchObject({
      payload: { code: 'grant_declined' },
    });
    expect((await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).state).toBe('none');
  });

  it('подпись чужим ключом при выдаче не принимается: grant_declined, а не разрешение', async () => {
    const forging: GrantKeys = {
      ...fileKeys(stranger),
      signerKey: () => Promise.resolve(owner.pub),
    };
    await expect(issueGrant(forging, PROJECT_A, 'default', NOON)).rejects.toBeInstanceOf(GcError);
    expect((await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).state).toBe('none');
  });

  it('агент не отдаёт ключ — grant_key_missing при выдаче и no_signer_key при проверке', async () => {
    await expect(issueGrant(noKey(owner), PROJECT_A, 'default', NOON)).rejects.toMatchObject({
      payload: { code: 'grant_key_missing' },
    });
    await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    expect(await currentGrant(noKey(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      reason: 'no_signer_key',
    });
  });

  it('отзыв снимает разрешение; повторный отзыв — «его и не было»', async () => {
    await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    expect(await revokeGrant(PROJECT_A, 'default')).toBe(true);
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      reason: 'no_grant',
    });
    expect(await revokeGrant(PROJECT_A, 'default')).toBe(false);
  });

  it('проекта нет (клиент не передал CLAUDE_PROJECT_DIR) — только чтение', async () => {
    expect(await currentGrant(fileKeys(owner), undefined, 'default', NOON)).toMatchObject({
      reason: 'no_project',
    });
  });
});

describe('подложенный файл не принимается (X4)', () => {
  const text = grantText(newGrant(PROJECT_A, 'default', NOON));

  it('без подписи и с мусором вместо неё', async () => {
    for (const signature of ['', 'not a signature']) {
      await plant(PROJECT_A, text, signature);
      expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
        reason: 'bad_signature',
      });
    }
  });

  it('подписан чужим ключом — даже если в тексте всё правильно', async () => {
    await plant(PROJECT_A, text, await sign(stranger, text));
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('текст исправлен после подписи (срок сдвинут) — подпись не сходится', async () => {
    const signature = await sign(owner, text);
    const later = text.replace(/expires: .*/, 'expires: 2026-10-18T11:00:00+03:00');
    await plant(PROJECT_A, later, signature);
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('подпись того же ключа в другом пространстве (irreversible) не годится для разрешения', async () => {
    await plant(PROJECT_A, text, await sign(owner, text, 'irreversible'));
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('подпись проверяется раньше содержимого: чужой проект с чужой подписью — «подпись», а не «проект»', async () => {
    const foreign = grantText(newGrant(PROJECT_B, 'default', NOON));
    await plant(PROJECT_A, foreign, await sign(stranger, foreign));
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      reason: 'bad_signature',
    });
  });
});

describe('чужой проект, чужой профиль, истёкший срок (X5, X6)', () => {
  it('X5: разрешение проекта A не открывает проект B — и переложенный файл A тоже', async () => {
    await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    expect(await currentGrant(fileKeys(owner), PROJECT_B, 'default', NOON)).toMatchObject({
      reason: 'no_grant',
    });
    const moved = await readFile(
      join(grantsDir('default'), `${projectKey(PROJECT_A)}.json`),
      'utf8',
    );
    await writeFile(join(grantsDir('default'), `${projectKey(PROJECT_B)}.json`), moved);
    expect(await currentGrant(fileKeys(owner), PROJECT_B, 'default', NOON)).toMatchObject({
      reason: 'other_project',
    });
  });

  it('разрешение профиля default не открывает другой профиль', async () => {
    await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    // У другого профиля свой каталог (D-25): файла там нет.
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toMatchObject({
      reason: 'no_grant',
    });
    // Скопированный в каталог другого профиля файл: подпись цела, профиль в тексте — чужой.
    const name = `${projectKey(PROJECT_A)}.json`;
    await mkdir(grantsDir('work'), { recursive: true });
    await copyFile(join(grantsDir('default'), name), join(grantsDir('work'), name));
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toMatchObject({
      reason: 'other_account',
    });
  });

  it('X6: после 23:59:59 — истекло, и ответ называет когда', async () => {
    const grant = await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    const midnight = new Date(2026, 9, 18, 0, 0, 1);
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', midnight)).toEqual({
      state: 'none',
      reason: 'expired',
      detail: `разрешение истекло ${grant.expires}`,
      expiredAt: grant.expires,
    });
    const lastSecond = new Date(2026, 9, 17, 23, 59, 58);
    expect((await currentGrant(fileKeys(owner), PROJECT_A, 'default', lastSecond)).state).toBe(
      'granted',
    );
  });
});

describe('список разрешений машины (gc grant)', () => {
  it('каждое проверено как при записи: действующее, подложенное с чужой подписью, битый файл', async () => {
    await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    const foreign = grantText(newGrant(PROJECT_B, 'default', NOON));
    await plant(PROJECT_B, foreign, await sign(stranger, foreign));
    await writeFile(join(grantsDir('default'), 'broken.json'), '{not json');
    const listing = await listGrants(fileKeys(owner), 'default', NOON);
    expect(listing).toHaveLength(3);
    expect(listing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: PROJECT_A, state: 'granted' }),
        expect.objectContaining({ project: PROJECT_B, state: 'bad_signature' }),
        expect.objectContaining({ state: 'malformed' }),
      ]),
    );
  });
});

describe('ключ из агента (путь Secretive на настоящем ssh-agent)', () => {
  // Агент — под сторожем (`fixtures/test-agent.ts`): тест, убитый до afterAll, сироту не оставляет.
  let agent: TestAgent;
  let socket: string;

  beforeAll(async () => {
    agent = await startTestAgent(keysDir);
    socket = agent.socket;
    // Первым в агенте — ключ с ТЕМ ЖЕ именем, но без метки Secretive: его брать нельзя.
    const impostor = makeKey(keysDir, 'impostor', 'G connect');
    for (const key of [impostor, owner]) {
      execFileSync('/usr/bin/ssh-add', ['-q', key.file], { env: { SSH_AUTH_SOCK: socket } });
    }
  });

  afterAll(async () => {
    await agent.stop();
  });

  it('имя ключа из комментария Secretive; регистр и пробелы не различаются', () => {
    expect(agentKeyName('ecdsa-sha2-nistp256 AAAA irreversible@secretive.MacBook-Air.local')).toBe(
      'irreversible',
    );
    expect(agentKeyName('ssh-ed25519 AAAA evil@elsewhere')).toBeUndefined();
    expect(agentKeyName('  ecdsa  AAAA  G connect@secretive.host')).toBe('G connect');
    expect(agentKeyName('ecdsa AAAA @secretive.host')).toBeUndefined();
    expect(keyNameKey('  G_connect  key ')).toBe('g-connect-key');
    // Сокет — контейнер Secretive, а не SSH_AUTH_SOCK сессии: свой агент подписал бы без пальца.
    expect(SECRETIVE_SOCKET).toBe(
      join(homedir(), 'Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh'),
    );
  });

  it('агент отдаёт ключ по имени, подписывает — разрешение проверяется ключом агента', async () => {
    const keys = secretiveKeys('g-connect', socket);
    expect(await keys.signerKey()).toBe(owner.pub);
    const grant = await issueGrant(keys, PROJECT_A, 'default', NOON);
    expect(await currentGrant(keys, PROJECT_A, 'default', NOON)).toEqual({
      state: 'granted',
      grant,
    });
  });

  it('подпись ключом, которого у агента нет, — «касания не было», а не пустая подпись', async () => {
    expect(
      await secretiveKeys('g-connect', socket).sign('текст', stranger.pub, 5_000),
    ).toBeUndefined();
  });

  it('ключа с таким именем у агента нет — grant_key_missing, а не чужой ключ', async () => {
    await expect(
      issueGrant(secretiveKeys('Other key', socket), PROJECT_A, 'default', NOON),
    ).rejects.toMatchObject({
      payload: { code: 'grant_key_missing' },
    });
  });
});

describe('два профиля рядом: разрешение на пару «проект, профиль» (D-25)', () => {
  it('W4: разрешение рабочего не трогает личное в том же проекте — и отзыв тоже', async () => {
    const personal = await issueGrant(fileKeys(owner), PROJECT_A, 'default', NOON);
    const work = await issueGrant(fileKeys(owner), PROJECT_A, 'work', NOON);
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toEqual({
      state: 'granted',
      grant: personal,
    });
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toEqual({
      state: 'granted',
      grant: work,
    });
    expect(await revokeGrant(PROJECT_A, 'work')).toBe(true);
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
      state: 'granted',
    });
    expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toMatchObject({
      reason: 'no_grant',
    });
    expect((await listGrants(fileKeys(owner), 'default', NOON)).map((g) => g.project)).toEqual([
      PROJECT_A,
    ]);
  });

  it('W6: файл прежней раскладки (на проект) не открывает запись ни одному профилю', async () => {
    const grant = newGrant(PROJECT_A, 'default', NOON);
    const text = grantText(grant);
    const root = dirname(grantsDir('default'));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, `${projectKey(PROJECT_A)}.json`),
      JSON.stringify({ text, signature: await sign(owner, text) }),
    );
    for (const account of ['default', 'work']) {
      expect(await currentGrant(fileKeys(owner), PROJECT_A, account, NOON)).toMatchObject({
        state: 'none',
        reason: 'no_grant',
      });
    }
  });
});
