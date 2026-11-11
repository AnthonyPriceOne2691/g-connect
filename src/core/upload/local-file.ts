/**
 * Файл с компьютера для загрузки на Drive (D-27, Q45–Q47) — или отказ.
 *
 * Решение владельца 2026-11-09 («Из папки проекта сессии»): агент берёт файлы только внутри
 * каталога проекта своей сессии (`CLAUDE_PROJECT_DIR`), и никогда — скрытые пути и секреты
 * (`.ssh`, `.gconnect`, `.env`, ключи). Без этого агент мог бы выложить на Диск любой файл
 * компьютера, в том числе ключи и токены. Путь сверяется после `realpath`: ссылка из проекта
 * наружу — тоже отказ.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { userHome } from '../env.js';
import { gcError, type GcError } from '../errors.js';
import { denyByRule, limitOf } from '../policy.js';
import { mimeTypeOf } from './mime.js';

/** Проверенный файл: всё, что нужно превью и шву загрузки. */
export interface LocalFile {
  /** Абсолютный путь после `realpath` — внутри каталога проекта. */
  readonly path: string;
  /** Имя файла — последний сегмент пути. */
  readonly name: string;
  /** Байты. */
  readonly size: number;
  /** sha256 содержимого, hex в нижнем регистре. */
  readonly sha256: string;
  /** Тип по расширению; незнакомое — `application/octet-stream`. */
  readonly mimeType: string;
}

/** Файл, прошедший проверки, — до чтения содержимого. */
export type LocatedFile = Pick<LocalFile, 'path' | 'name' | 'size'>;

/**
 * Файл `localPath` (абсолютный или от каталога проекта) — если он внутри `projectDir`, не скрытый,
 * не секрет, обычный файл и не больше предела `upload.max-bytes`. Иначе — отказ `bad_request` или
 * `policy_denied` с причиной. Содержимое (sha256) читается только у файла, прошедшего всё.
 */
export async function vetLocalFile(projectDir: string, localPath: string): Promise<LocalFile> {
  const file = await locateLocalFile(projectDir, localPath);
  return { ...file, sha256: await sha256Of(file), mimeType: mimeTypeOf(file.name) };
}

/**
 * Проверки `vetLocalFile` без чтения содержимого: проект, путь, имя, вид и размер. Секрет и
 * скрытый путь судятся по настоящему пути — после всех ссылок, — а файл больше предела не
 * читается вовсе.
 */
export async function locateLocalFile(projectDir: string, localPath: string): Promise<LocatedFile> {
  const root = await projectRoot(projectDir);
  const asked = resolve(projectDir, localPath);
  const real = await realFile(asked, projectDir, root);
  const inner = relative(root, real);
  assertInside(inner, asked, projectDir);
  assertNotSecret(inner);
  assertNotHidden(inner);
  const size = await regularFileSize(real, inner);
  assertUploadSize(size, inner);
  return { path: real, name: basename(real), size };
}

/**
 * Настоящий путь каталога проекта. Относительный не берётся: он считался бы от каталога процесса
 * сервера, а тот о сессии ничего не говорит. Корень диска и домашняя папка — не проект: в них
 * лежит весь компьютер, и «только из проекта» ничего бы не значило.
 */
async function projectRoot(projectDir: string): Promise<string> {
  if (!isAbsolute(projectDir)) {
    throw noProject('У сессии нет каталога проекта: CLAUDE_PROJECT_DIR пуст или не абсолютный');
  }
  let root: string;
  try {
    root = await realpath(projectDir);
  } catch (error) {
    throw noProject(`Каталога проекта «${projectDir}» нет на диске (${errnoOf(error)})`);
  }
  if ([sep, resolve(userHome())].includes(root)) {
    throw noProject(`Каталог проекта сессии — «${root}», корень диска или домашняя папка`);
  }
  return root;
}

function noProject(what: string): GcError {
  return gcError('bad_request', {
    detail:
      `${what}, а файлы с компьютера G connect берёт только из каталога проекта сессии. ` +
      'Открой сессию в папке проекта и положи файл в неё.',
    cause: 'upload_no_project',
  });
}

/**
 * Настоящий путь файла — после всех ссылок. Нет файла — отказ с путём от каталога проекта; но
 * путь вне проекта получает тот же отказ, что и существующий файл снаружи: есть ли там что-то,
 * G connect не рассказывает.
 */
async function realFile(asked: string, projectDir: string, root: string): Promise<string> {
  try {
    return await realpath(asked);
  } catch (error) {
    if (escapes(relative(projectDir, asked)) && escapes(relative(root, asked))) {
      throw outsideProject(relative(projectDir, asked), 'вне каталога проекта');
    }
    throw gcError('bad_request', {
      detail:
        `Файл «${relative(projectDir, asked)}» не найден (${errnoOf(error)}). Путь — абсолютный ` +
        `или от каталога проекта «${projectDir}»: проверь его.`,
      cause: 'upload_not_found',
    });
  }
}

/**
 * Файл — внутри настоящего каталога проекта: `..`, абсолютный путь наружу и ссылка из проекта
 * наружу — отказ. Текст называет путь от каталога проекта, как его назвал агент; куда ведёт
 * ссылка, он не говорит — это путь вне проекта.
 */
function assertInside(inner: string, asked: string, projectDir: string): void {
  if (!escapes(inner)) return;
  const named = relative(projectDir, asked);
  throw outsideProject(
    named,
    escapes(named) ? 'вне каталога проекта' : 'ссылка из каталога проекта наружу',
  );
}

/**
 * Отказ «вне проекта». Скопировать файл в проект агент не решает сам: решение владельца — файлы
 * из проекта, и что в него класть, решает человек.
 */
function outsideProject(named: string, where: string): GcError {
  return gcError('bad_request', {
    detail:
      `«${named}» — ${where}: на Диск G connect выкладывает файлы только из проекта сессии. ` +
      'Нужен этот файл на Диске — скажи человеку: положить его в проект решает он.',
    cause: 'upload_outside_project',
  });
}

/** Относительный путь выходит из каталога, от которого посчитан. `..имя` — не выход. */
function escapes(rel: string): boolean {
  return rel.split(sep)[0] === '..';
}

/**
 * Имя похоже на ключ, токен или пароль — отказ и внутри проекта. Шаблоны — как их пишет человек,
 * внутри функции (урок бюджета мутаций). Судится раньше скрытого пути: `.netrc` — секрет, и
 * причина точнее.
 */
function assertNotSecret(inner: string): void {
  const patterns = [
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.kdbx',
    '*.p8',
    '*.ppk',
    '*.age',
    '*.gpg',
    'id_rsa*',
    'id_ed25519*',
    'id_ecdsa*',
    'id_dsa*',
    '*.env',
    '*credentials*.json',
    'client_secret*.json',
    'token*.json',
    '.netrc',
    '.npmrc',
    '*.keychain*',
  ];
  const name = basename(inner);
  const hit = patterns.find((pattern) => globMatches(pattern, name));
  if (hit === undefined) return;
  throw gcError('bad_request', {
    detail:
      `«${inner}» похоже на секрет — имя подходит под «${hit}»: ключи, токены и пароли G connect ` +
      'на Диск не выкладывает. Если это не секрет — скажи человеку: переименовать файл решает он.',
    cause: 'upload_secret_like',
  });
}

/** Шаблон имени: `*` — любые символы, точка — точка; регистр не важен (`ID_RSA` — тоже ключ). */
function globMatches(pattern: string, name: string): boolean {
  const source = pattern.replaceAll('.', '\\.').replaceAll('*', '.*');
  return new RegExp(`^${source}$`, 'i').test(name);
}

/** Сегмент пути внутри проекта начинается с точки (`.git`, `.env`, `.ssh`, `.config`) — отказ. */
function assertNotHidden(inner: string): void {
  const hidden = inner.split(sep).find((segment) => segment.startsWith('.'));
  if (hidden === undefined) return;
  throw gcError('bad_request', {
    detail:
      `«${inner}» — скрытый путь («${hidden}»): в скрытых файлах и папках живут ключи, токены и ` +
      'настройки, и на Диск G connect их не выкладывает. Нужен этот файл на Диске — скажи человеку.',
    cause: 'upload_hidden_path',
  });
}

/** Размер обычного файла. Папка, сокет, канал — отказ: открытый канал повесил бы чтение. */
async function regularFileSize(real: string, inner: string): Promise<number> {
  const info = await stat(real);
  if (info.isFile()) return info.size;
  const kind = info.isDirectory() ? 'папка' : 'не обычный файл (сокет, канал или устройство)';
  throw gcError('bad_request', {
    detail: `«${inner || '.'}» — ${kind}: на Диск выкладывается только обычный файл. Назови файл.`,
    cause: 'upload_not_file',
  });
}

/** Предел `upload.max-bytes`: больше — отказ правилом с размером файла, до чтения содержимого. */
function assertUploadSize(size: number, inner: string): void {
  const max = limitOf('upload.max-bytes', 104_857_600);
  if (size <= max) return;
  denyByRule(
    'upload.max-bytes',
    `Файл «${inner}» — ${size} байт, предел — ${max} байт. Сожми файл — или пусть человек ` +
      'выложит его на Диск сам.',
  );
}

/** sha256 потоком: ролик в 100 МиБ в память целиком не читается. Не читается — отказ с кодом. */
async function sha256Of(file: LocatedFile): Promise<string> {
  const hash = createHash('sha256');
  const chunks: AsyncIterable<Buffer> = createReadStream(file.path);
  try {
    for await (const chunk of chunks) hash.update(chunk);
  } catch (error) {
    throw gcError('bad_request', {
      detail:
        `Файл «${file.name}» не читается (${errnoOf(error)}): права на него не дают чтения. ` +
        'Скажи человеку — права на файлы решает он.',
      cause: 'upload_unreadable',
    });
  }
  return hash.digest('hex');
}

/** Код системной ошибки (`ENOENT`, `ENOTDIR`, `ELOOP`) — без её текста: там абсолютный путь. */
function errnoOf(error: unknown): string {
  return String((error as { code?: unknown }).code);
}
