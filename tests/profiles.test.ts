import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { profilesHome } from '../src/core/env.js';
import {
  listProfiles,
  profilesRoot,
  missingScopes,
  profileDir,
  profileStatus,
  readOAuthClient,
  readSealedToken,
  readTokenMeta,
  requireProfile,
  writeSealedToken,
  type TokenSealer,
} from '../src/core/profiles.js';
import { profileSealer } from '../src/core/token/sealing.js';
import { ageToolsIn } from '../src/core/token/age.js';
import { AGE_DIR, fakeSealer, realAgeProfile } from './fixtures/sealing.js';

let home: string;
const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gconnect-test-'));
  process.env['GCONNECT_HOME'] = home;
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

const writeCredentials = async (account = 'default'): Promise<void> => {
  await mkdir(profileDir(account), { recursive: true });
  await writeFile(
    join(profileDir(account), 'credentials.json'),
    JSON.stringify({
      web: {
        client_id: 'id.apps.googleusercontent.com',
        client_secret: 'secret',
        redirect_uris: ['http://localhost:3333'],
      },
    }),
  );
};

describe('изоляция тестов от реального профиля', () => {
  /**
   * Оракул на дефект 2026-09-02: мутационный прогон сломал перенаправление `GCONNECT_HOME`,
   * и тесты записали фикстуры в РЕАЛЬНЫЙ `~/.gconnect`, снеся токен и файл OAuth-клиента.
   * Теперь отсутствие переменной под тест-раннером — отказ, а не путь в домашний каталог.
   */
  it('без GCONNECT_HOME под тест-раннером profilesHome отказывает, а не идёт в ~/.gconnect', () => {
    const saved = process.env['GCONNECT_HOME'];
    delete process.env['GCONNECT_HOME'];
    try {
      let thrown: { payload: { cause?: string; detail?: string } } | null = null;
      try {
        profilesHome();
      } catch (error) {
        thrown = error as { payload: { cause?: string; detail?: string } };
      }
      expect(
        thrown,
        'без GCONNECT_HOME путь в реальный профиль обязан быть отказом',
      ).not.toBeNull();
      expect(thrown?.payload.cause).toBe('test_home_not_isolated');
      expect(thrown?.payload.detail).toContain('GCONNECT_HOME');
    } finally {
      if (saved !== undefined) process.env['GCONNECT_HOME'] = saved;
    }
  });

  it('env.ts исключён из области мутаций, и причина записана в конфиге', async () => {
    const config = JSON.parse(await readFile('stryker.config.json', 'utf8')) as {
      mutate: string[];
      _comment: string;
    };
    // Мутант в модуле изоляции превращает сьют в разрушительный инструмент: мутировать
    // его нельзя, и снять исключение молча тоже — эта проба покраснеет.
    expect(config.mutate).toContain('!src/core/env.ts');
    expect(config._comment).toMatch(/env\.ts/);
    expect(config._comment).toMatch(/~\/\.gconnect|реальный/);
  });
});

describe('профили', () => {
  // Пример A12 спеки: нет профиля → внятная ошибка с действием, а не ENOENT.
  it('без профиля requireProfile даёт no_profile с кнопкой подключения', async () => {
    await expect(requireProfile()).rejects.toMatchObject({
      payload: { code: 'no_profile', action: { kind: 'connect_google' } },
    });
  });

  it('каталог есть, credentials нет → no_credentials с подсказкой куда положить', async () => {
    await mkdir(profileDir(), { recursive: true });
    const status = await profileStatus();
    expect(status.state).toBe('no_credentials');
    await expect(requireProfile()).rejects.toMatchObject({
      payload: { code: 'no_credentials', action: { kind: 'put_credentials' } },
    });
  });

  it('credentials есть, токена нет → needs_reauth, а не «всё хорошо»', async () => {
    await writeCredentials();
    const status = await profileStatus();
    expect(status.state).toBe('needs_reauth');
    expect(status.hasCredentials).toBe(true);
    expect(status.hasToken).toBe(false);
    await expect(requireProfile()).rejects.toMatchObject({ payload: { code: 'auth_expired' } });
  });

  it('открытый token.json прежней раскладки → unsealed: ядро его не берёт, выход — gc seal', async () => {
    await writeCredentials();
    await writeFile(join(profileDir(), 'token.json'), JSON.stringify({ refresh_token: 'r' }));
    const status = await profileStatus();
    expect(status.state).toBe('unsealed');
    expect(status.hasToken).toBe(false);
    expect(status.warnings.join(' ')).toContain('gc -- seal');
    await expect(requireProfile()).rejects.toMatchObject({
      payload: { code: 'token_unsealed', action: { kind: 'seal_token' } },
    });
  });

  it('зашифрованный токен → connected, scopes видны без выдачи токена; срока access нет', async () => {
    await writeCredentials();
    await writeSealedToken(fakeSealer(), {
      refresh_token: 'r-секрет',
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
    });
    const status = await profileStatus();
    expect(status.state).toBe('connected');
    expect(status.scopes).toHaveLength(2);
    // §13.5: наружу уходит статус, а не секреты; access-токен на диске не живёт вовсе.
    expect(JSON.stringify(status)).not.toContain('r-секрет');
    expect(status).not.toHaveProperty('expiresAt');
  });

  it('шифротекст и метаданные пишутся с правами 600 в каталог 700', async () => {
    await writeSealedToken(fakeSealer(), { refresh_token: 'r' });
    for (const file of ['token.age', 'token.meta.json']) {
      expect((await stat(join(profileDir(), file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(profileDir())).mode & 0o777).toBe(0o700);
  });

  it('шифровальщик, вернувший открытый текст, токен на диск не кладёт (token.sealed-at-rest)', async () => {
    const leaky: TokenSealer = { recipient: 'age1leak', seal: (plain) => Promise.resolve(plain) };
    await expect(writeSealedToken(leaky, { refresh_token: '1//утечка' })).rejects.toMatchObject({
      payload: { code: 'internal', cause: 'seal_returned_plaintext' },
    });
    expect(await readSealedToken()).toBeNull();
  });

  it('нет ключа анклава у профиля — token_unsealed с действием «gc seal», а не пустой получатель', async () => {
    await expect(profileSealer(ageToolsIn('/opt/homebrew/bin'))).rejects.toMatchObject({
      payload: { code: 'token_unsealed', cause: 'no_identity' },
    });
  });

  it.skipIf(AGE_DIR === undefined)(
    'U1: строки refresh-токена нет ни в одном файле профиля; круг — ключом профиля (настоящий age)',
    async () => {
      await writeCredentials();
      const { sealer, unsealer } = await realAgeProfile();
      const meta = await writeSealedToken(sealer, { refresh_token: '1//секрет-U1' });
      expect(meta.recipient).toBe(sealer.recipient);
      for (const file of await readdir(profileDir())) {
        expect(await readFile(join(profileDir(), file), 'utf8')).not.toContain('секрет-U1');
      }
      const stored = await readSealedToken();
      expect(stored?.meta).toEqual(await readTokenMeta());
      expect(await unsealer.unseal(stored?.sealed ?? '', meta)).toContain('1//секрет-U1');
    },
  );

  it('читает и web, и installed; redirect_uris подхватывается', async () => {
    await writeCredentials();
    expect((await readOAuthClient()).redirectUri).toBe('http://localhost:3333');
    await mkdir(profileDir('other'), { recursive: true });
    await writeFile(
      join(profileDir('other'), 'credentials.json'),
      JSON.stringify({ installed: { client_id: 'i', client_secret: 's' } }),
    );
    const client = await readOAuthClient('other');
    expect(client.clientId).toBe('i');
    expect(client.redirectUri).toBe('http://localhost:3333');
  });

  it('битый credentials.json → no_credentials с причиной, а не падение парсера', async () => {
    await mkdir(profileDir(), { recursive: true });
    await writeFile(join(profileDir(), 'credentials.json'), '{ "web": {} }');
    await expect(readOAuthClient()).rejects.toMatchObject({
      payload: { code: 'no_credentials', cause: 'malformed_credentials' },
    });
  });

  it('несколько аккаунтов перечисляются для переключателя профилей', async () => {
    await writeCredentials('default');
    await writeCredentials('work');
    expect(await listProfiles()).toEqual(['default', 'work']);
  });

  it('служебные каталоги и пустые папки аккаунтами не считаются', async () => {
    await writeCredentials('default');
    // Каталоги отчётов и аудита лежат рядом с профилями — и раньше каталог `reports`
    // приходил агенту как аккаунт «no_credentials» (нашла живая проба).
    await mkdir(join(profilesRoot(), 'reports'), { recursive: true });
    await mkdir(join(profilesRoot(), 'audit'), { recursive: true });
    await mkdir(join(profilesRoot(), 'пустой'), { recursive: true });
    expect(await listProfiles()).toEqual(['default']);
  });

  it('missingScopes называет ровно недостающие права', async () => {
    await writeCredentials();
    await writeSealedToken(fakeSealer(), {
      refresh_token: 'r',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
    });
    const status = await profileStatus();
    expect(
      missingScopes(status, [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents',
      ]),
    ).toEqual(['https://www.googleapis.com/auth/documents']);
  });

  it('токена нет → readSealedToken и readTokenMeta отдают null, а не бросают', async () => {
    expect(await readSealedToken()).toBeNull();
    expect(await readTokenMeta()).toBeNull();
  });
});
