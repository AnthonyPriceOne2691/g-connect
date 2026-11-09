/**
 * Файл с компьютера перед загрузкой на Drive (D-27, Q45–Q47). Решение владельца 2026-11-09
 * «Из папки проекта сессии»: только изнутри каталога проекта, не скрытый путь, не секрет, обычный
 * файл и не больше предела. Всё — на настоящих файлах во временном каталоге: `realpath`, ссылки и
 * каналы подделкой не проверить.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isGcError, type GcErrorPayload } from '../src/core/errors.js';
import { limitOf } from '../src/core/policy.js';
import { locateLocalFile, vetLocalFile } from '../src/core/upload/local-file.js';
import { mimeTypeOf } from '../src/core/upload/mime.js';
import { sparseFile } from './fixtures/upload-probes.js';

const REPORT = '# Отчёт за ноябрь\n';

/** Имя → шаблон, по которому оно секрет: каждый шаблон списка — хотя бы одним именем. */
const SECRETS = [
  ['keys/server.pem', '*.pem'],
  ['api.KEY', '*.key'],
  ['cert.p12', '*.p12'],
  ['cert.pfx', '*.pfx'],
  ['vault.kdbx', '*.kdbx'],
  ['AuthKey_ABC123.p8', '*.p8'],
  ['server.ppk', '*.ppk'],
  ['gh-token.age', '*.age'],
  ['backup.gpg', '*.gpg'],
  ['ID_RSA', 'id_rsa*'],
  ['id_rsa.pub', 'id_rsa*'],
  ['.ssh/id_ed25519', 'id_ed25519*'],
  ['id_ecdsa', 'id_ecdsa*'],
  ['id_dsa', 'id_dsa*'],
  ['prod.env', '*.env'],
  ['.env', '*.env'],
  ['credentials.json', '*credentials*.json'],
  ['Credentials-prod.JSON', '*credentials*.json'],
  ['application_default_credentials.json', '*credentials*.json'],
  ['client_secret_42.apps.json', 'client_secret*.json'],
  ['token.json', 'token*.json'],
  ['token-cache.json', 'token*.json'],
  ['.netrc', '.netrc'],
  ['.npmrc', '.npmrc'],
  ['login.keychain-db', '*.keychain*'],
] as const;

/** Похожие на секрет, но не секрет: ни один шаблон их не берёт. */
const NEAR_SECRETS = ['monkey', 'tokens.md', 'grid_rsa.txt', 'environment.txt', 'credentials.md'];

let base = '';
let project = '';

/** Файл проекта с содержимым — вместе с папками по пути. */
async function put(path: string, content: string | Buffer = 'данные'): Promise<void> {
  await mkdir(dirname(join(project, path)), { recursive: true });
  await writeFile(join(project, path), content);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'gconnect-upload-'));
  project = join(base, 'project');
  await put('docs/report.md', REPORT);
  for (const path of ['notes.txt', '.git/config', 'docs/.draft.md', '..foo', '.config/app.txt']) {
    await put(path);
  }
  for (const [path] of SECRETS) await put(path);
  for (const path of NEAR_SECRETS) await put(path);
  await mkdir(join(base, 'outside'));
  await writeFile(join(base, 'outside', 'plan.txt'), 'снаружи');
  await symlink(join(base, 'outside', 'plan.txt'), join(project, 'link-out.txt'));
  await symlink(join(base, 'outside'), join(project, 'ext'));
  await symlink('report.md', join(project, 'docs', 'inner-link.md'));
  await symlink('.config/app.txt', join(project, 'cfg.txt'));
  await symlink(project, join(base, 'project-link'));
  execFileSync('mkfifo', [join(project, 'pipe')]);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Отказ проверки — полезной нагрузкой ошибки; прошедший проверку файл — провал теста. */
async function refusal(localPath: string, projectDir = project): Promise<GcErrorPayload> {
  try {
    await vetLocalFile(projectDir, localPath);
  } catch (error) {
    if (isGcError(error)) return error.payload;
    throw error;
  }
  return expect.unreachable(`«${localPath}» прошёл проверку`);
}

describe('файл проекта проходит проверку', () => {
  it('путь от каталога проекта: настоящий путь, имя, размер, sha256 и тип', async () => {
    const file = await vetLocalFile(project, 'docs/report.md');
    expect(file).toEqual({
      path: await realpath(join(project, 'docs', 'report.md')),
      name: 'report.md',
      size: Buffer.byteLength(REPORT),
      sha256: createHash('sha256').update(REPORT).digest('hex'),
      mimeType: 'text/markdown',
    });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('абсолютный путь и путь с `.` и `..` внутри проекта — тот же файл', async () => {
    const expected = await vetLocalFile(project, 'docs/report.md');
    for (const path of [join(project, 'docs', 'report.md'), './docs/../docs/report.md']) {
      expect(await vetLocalFile(project, path)).toEqual(expected);
    }
  });

  it('каталог проекта — ссылкой: путь через ссылку и мимо неё ведёт в тот же проект', async () => {
    const link = join(base, 'project-link');
    const expected = await vetLocalFile(project, 'docs/report.md');
    expect(await vetLocalFile(link, 'docs/report.md')).toEqual(expected);
    expect(await vetLocalFile(link, join(project, 'docs', 'report.md'))).toEqual(expected);
    expect(await vetLocalFile(project, join(link, 'docs', 'report.md'))).toEqual(expected);
  });

  it('ссылка внутри проекта на файл проекта — путь и имя настоящего файла', async () => {
    const file = await vetLocalFile(project, 'docs/inner-link.md');
    expect(file.path).toBe(await realpath(join(project, 'docs', 'report.md')));
    expect(file.name).toBe('report.md');
  });

  it('проект сам в скрытой папке: скрытыми судятся только сегменты внутри проекта', async () => {
    const inner = join(base, '.work', 'inner');
    await mkdir(join(inner, 'docs'), { recursive: true });
    await writeFile(join(inner, 'docs', 'a.md'), 'текст');
    expect((await vetLocalFile(inner, 'docs/a.md')).name).toBe('a.md');
  });

  it('похожие на секрет имена, которых нет в списке, — проходят', async () => {
    for (const name of NEAR_SECRETS) expect((await vetLocalFile(project, name)).name).toBe(name);
  });

  it('sha256 — потоком по всему файлу, через несколько кусков чтения', async () => {
    const content = Buffer.alloc(300_000, 'абв');
    await put('long.txt', content);
    const file = await vetLocalFile(project, 'long.txt');
    expect(file.size).toBe(300_000);
    expect(file.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  });
});

describe('отказ — с причиной, путём от каталога проекта и тем, что делать', () => {
  it('нет каталога проекта: пустой, относительный, несуществующий — upload_no_project', async () => {
    for (const dir of ['', 'project']) {
      const payload = await refusal('notes.txt', dir);
      expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_no_project' });
      expect(payload.detail).toContain('CLAUDE_PROJECT_DIR пуст или не абсолютный');
    }
    const missing = await refusal('notes.txt', join(base, 'gone'));
    expect(missing.cause).toBe('upload_no_project');
    expect(missing.detail).toContain(
      `Каталога проекта «${join(base, 'gone')}» нет на диске (ENOENT)`,
    );
    expect(missing.detail).toContain('берёт только из каталога проекта сессии');
    expect(missing.detail).toContain('Открой сессию в папке проекта и положи файл в неё');
  });

  it('нет файла — upload_not_found с путём от проекта и тем, от чего путь считается', async () => {
    const payload = await refusal(join(project, 'docs', 'missing.md'));
    expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_not_found' });
    expect(payload.detail).toContain(
      'Файл «docs/missing.md» не найден (ENOENT). Путь — абсолютный',
    );
    expect(payload.detail).toContain(`или от каталога проекта «${project}»: проверь его`);
    // Сегмент пути — файл, а не папка: тоже «не найден», с кодом системы.
    expect((await refusal('docs/report.md/x')).detail).toContain('(ENOTDIR)');
  });

  it('`..` и абсолютный путь наружу — upload_outside_project, путь назван от проекта', async () => {
    for (const path of ['../outside/plan.txt', join(base, 'outside', 'plan.txt')]) {
      const payload = await refusal(path);
      expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_outside_project' });
      expect(payload.detail).toContain('«../outside/plan.txt» — вне каталога проекта: на Диск');
      expect(payload.detail).toContain('выкладывает файлы только из проекта сессии');
      expect(payload.detail).toContain('скажи человеку: положить его в проект решает он');
      expect(payload.detail).not.toContain(join(base, 'outside'));
    }
  });

  it('файла снаружи нет — тот же отказ, что у существующего: что лежит вне проекта, не сказано', async () => {
    for (const path of ['../outside/missing.txt', join(base, 'outside', 'missing.txt')]) {
      const payload = await refusal(path);
      expect(payload, path).toMatchObject({ code: 'bad_request', cause: 'upload_outside_project' });
      expect(payload.detail).toContain('«../outside/missing.txt» — вне каталога проекта: на Диск');
    }
  });

  it('проект ссылкой: нет файла внутри — «не найден» и по ссылке, и настоящим путём', async () => {
    const link = join(base, 'project-link');
    const real = join(await realpath(project), 'docs', 'missing.md');
    for (const path of ['docs/missing.md', real]) {
      expect((await refusal(path, link)).cause, path).toBe('upload_not_found');
    }
  });

  it('корень диска и домашняя папка — не проект: upload_no_project', async () => {
    const root = await refusal('etc/hosts', '/');
    expect(root.cause).toBe('upload_no_project');
    expect(root.detail).toContain('Каталог проекта сессии — «/», корень диска или домашняя папка');
    vi.stubEnv('HOME', await realpath(project));
    try {
      expect((await refusal('notes.txt')).cause).toBe('upload_no_project');
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await vetLocalFile(project, 'notes.txt')).name).toBe('notes.txt');
  });

  it.skipIf(process.getuid?.() === 0)(
    'файл без права чтения — upload_unreadable с кодом системы',
    async () => {
      await put('locked.md', 'за правами');
      await chmod(join(project, 'locked.md'), 0o000);
      const payload = await refusal('locked.md');
      expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_unreadable' });
      expect(payload.detail).toContain('Файл «locked.md» не читается (EACCES): права на него');
      expect(payload.detail).toContain('права на файлы решает он');
    },
  );

  it('ссылка из проекта наружу — отказ, и текст не называет, куда она ведёт', async () => {
    for (const path of ['link-out.txt', 'ext/plan.txt']) {
      const payload = await refusal(path);
      expect(payload.cause).toBe('upload_outside_project');
      expect(payload.detail).toContain(`«${path}» — ссылка из каталога проекта наружу`);
      expect(payload.detail).not.toContain('outside');
    }
  });

  it('скрытый путь — upload_hidden_path: папка, файл, «..имя» и ссылка на скрытое', async () => {
    const cases = [
      ['.git', '.git', '.git'],
      ['.git/config', '.git/config', '.git'],
      ['docs/.draft.md', 'docs/.draft.md', '.draft.md'],
      ['..foo', '..foo', '..foo'],
      ['cfg.txt', '.config/app.txt', '.config'],
    ] as const;
    for (const [path, inner, segment] of cases) {
      const payload = await refusal(path);
      expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_hidden_path' });
      expect(payload.detail).toContain(`«${inner}» — скрытый путь («${segment}»): в скрытых`);
      expect(payload.detail).toContain('настройки, и на Диск G connect их не выкладывает');
    }
  });

  it('имя похоже на секрет — upload_secret_like с шаблоном, раньше скрытого пути', async () => {
    for (const [path, pattern] of SECRETS) {
      const payload = await refusal(path);
      expect(payload, path).toMatchObject({ code: 'bad_request', cause: 'upload_secret_like' });
      expect(payload.detail).toContain(
        `«${path}» похоже на секрет — имя подходит под «${pattern}»`,
      );
    }
    expect((await refusal('token.json')).detail).toContain('переименовать файл решает он');
  });

  it('не обычный файл: папка, сам каталог проекта, канал — upload_not_file', async () => {
    const cases = [
      ['docs', '«docs» — папка: на Диск'],
      ['.', '«.» — папка'],
      ['pipe', '«pipe» — не обычный файл (сокет, канал или устройство)'],
    ] as const;
    for (const [path, text] of cases) {
      const payload = await refusal(path);
      expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_not_file' });
      expect(payload.detail).toContain(text);
      expect(payload.detail).toContain('выкладывается только обычный файл');
    }
  });
});

describe('предел upload.max-bytes — на разреженных файлах', () => {
  it('на байт больше — policy_denied с размером; ровно предел — проходит, без sha256', async () => {
    const max = limitOf('upload.max-bytes', -1);
    expect(max).toBe(104_857_600);
    await sparseFile(join(project, 'video.mp4'), max + 1);
    await sparseFile(join(project, 'exact.mp4'), max);
    const payload = await refusal('video.mp4');
    expect(payload).toMatchObject({ code: 'policy_denied', cause: 'upload.max-bytes' });
    expect(payload.detail).toContain(`Файл «video.mp4» — ${max + 1} байт, предел — ${max} байт`);
    expect(payload.detail).toContain('выложит его на Диск сам');
    expect(await locateLocalFile(project, 'exact.mp4')).toEqual({
      path: await realpath(join(project, 'exact.mp4')),
      name: 'exact.mp4',
      size: max,
    });
  });
});

describe('тип по расширению', () => {
  it('каждое расширение таблицы — свой тип, регистр не важен', () => {
    const expected = {
      'a.md': 'text/markdown',
      'a.txt': 'text/plain',
      'a.csv': 'text/csv',
      'a.json': 'application/json',
      'a.html': 'text/html',
      'a.pdf': 'application/pdf',
      'a.png': 'image/png',
      'a.jpg': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.gif': 'image/gif',
      'a.webp': 'image/webp',
      'a.svg': 'image/svg+xml',
      'a.mp4': 'video/mp4',
      'a.mov': 'video/quicktime',
      'a.webm': 'video/webm',
      'a.mp3': 'audio/mpeg',
      'a.wav': 'audio/wav',
      'a.zip': 'application/zip',
      'a.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'a.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'a.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'PHOTO.JPG': 'image/jpeg',
      'Отчёт.Pdf': 'application/pdf',
    };
    for (const [name, type] of Object.entries(expected)) expect(mimeTypeOf(name), name).toBe(type);
  });

  it('незнакомое — application/octet-stream, и ключи прототипа таблицу не обманут', () => {
    const unknown = ['README', '.bashrc', 'archive.tar.gz', 'x.xyz', 'x.', 'x.constructor'];
    for (const name of unknown) expect(mimeTypeOf(name), name).toBe('application/octet-stream');
  });

  it('проверка отдаёт тип: файл без расширения — octet-stream', async () => {
    expect((await vetLocalFile(project, 'monkey')).mimeType).toBe('application/octet-stream');
  });
});
