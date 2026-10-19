/**
 * Профили: раскладка `~/.gconnect/<account>/` (DESIGN.md §11.5, §13.5).
 *
 * Один профиль = один аккаунт Google (D-2). Секреты живут только здесь, с правами 600,
 * и наружу из ядра не выходят: функции возвращают СТАТУС, а не токен.
 * Корень переопределяется `GCONNECT_HOME` — это же делает профили тестируемыми.
 *
 * Токен на диске — только шифротекст (D-24): `token.age` под ключом Secure Enclave,
 * рядом `token.meta.json` без секретов. Писатель принимает лишь шифровальщика — другого
 * пути на диск у токена нет. Открытый `token.json` прежней раскладки ядро не читает: это
 * состояние `unsealed`, и выход из него — `gc seal`.
 */

import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { profilesHome } from './env.js';
import { gcError } from './errors.js';

export const DEFAULT_ACCOUNT = 'default';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface StoredToken {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly scope?: string;
  readonly expiry_date?: number;
  readonly token_type?: string;
  /**
   * Когда получен refresh-токен. Не приходит от Google — ставим сами при записи.
   * Нужен из-за реального ограничения: у приложения в статусе Testing Google обрубает
   * refresh-токен через 7 дней, и без этой отметки истечение выглядит как внезапная
   * поломка доступа вместо «пора войти заново».
   */
  readonly obtained_at?: number;
}

/** Шифровальщик токена: писатель профиля другого пути на диск не знает (D-24). */
export interface TokenSealer {
  /** Получатель (открытый ключ), для которого шифруется, — уходит в метаданные. */
  readonly recipient: string;
  seal(plain: string): Promise<string>;
}

/** Что лежит рядом с шифротекстом: без секретов — для статуса и для разбора отказов. */
export interface TokenMeta {
  readonly scope?: string;
  /** Когда получен refresh-токен: у приложения в Testing Google рубит его через 7 дней. */
  readonly obtained_at: number;
  /** Кому зашифрован: совпал с ключом в файле ключа — отказ значит «касания не было». */
  readonly recipient: string;
  readonly sealed_at: number;
}

const SEALED_FILE = 'token.age';
const META_FILE = 'token.meta.json';
/** Прежняя раскладка: открытый токен. Ядро его не читает — только `gc seal`, чтобы отозвать. */
const PLAIN_FILE = 'token.json';
const IDENTITY_FILE = 'se-identity.txt';

/** То, что видит панель и агент: состояние без секретов (§13.5). */
export interface ProfileStatus {
  readonly account: string;
  readonly state: 'no_profile' | 'no_credentials' | 'needs_reauth' | 'unsealed' | 'connected';
  readonly hasCredentials: boolean;
  /** Есть зашифрованный токен, которым G connect может открыть Google. */
  readonly hasToken: boolean;
  readonly scopes: readonly string[];
  /** Сколько дней живёт refresh-токен; `null`, если отметки нет (старый профиль). */
  readonly refreshAgeDays: number | null;
  /** Предупреждения человеку: пусто — значит всё в порядке. */
  readonly warnings: readonly string[];
}

export function profilesRoot(): string {
  return profilesHome();
}

export function profileDir(account: string = DEFAULT_ACCOUNT): string {
  return join(profilesRoot(), account);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return null;
    if (code === 'EACCES') {
      throw gcError('no_credentials', {
        detail: `Файл ${path} есть, но недоступен для чтения.`,
        cause: 'EACCES',
      });
    }
    throw gcError('internal', {
      detail: `Не удалось прочитать ${path}: файл повреждён или это не JSON.`,
      cause: (error as Error).message,
    });
  }
}

/**
 * Служебные каталоги внутри `~/.gconnect/` — не аккаунты. Нашла живая проба: каталог
 * отчётов `reports` приходил агенту как аккаунт «no_credentials», то есть ядро
 * сообщало о профиле, которого нет.
 */
const RESERVED_DIRS = new Set(['audit', 'reports', 'index', 'cache', 'tmp']);

export async function listProfiles(): Promise<string[]> {
  try {
    const entries = await readdir(profilesRoot(), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name));
    // Профиль — каталог, в котором есть креды или токен. Пустая папка профилем не
    // считается: иначе любой каталог рядом становится «аккаунтом».
    const checked = await Promise.all(
      dirs.map(async (dir) => {
        const path = join(profilesRoot(), dir.name);
        const hasAny =
          (await exists(join(path, 'credentials.json'))) ||
          (await exists(join(path, SEALED_FILE))) ||
          (await exists(join(path, PLAIN_FILE)));
        return hasAny ? dir.name : null;
      }),
    );
    return checked.filter((name): name is string => name !== null).sort();
  } catch {
    return [];
  }
}

/**
 * Формат `credentials.json` из Google Cloud: секция `web` (нужный нам тип) или `installed`.
 * Оба варианта поддерживаются, потому что оба лежат у людей на диске.
 */
export async function readOAuthClient(account: string = DEFAULT_ACCOUNT): Promise<OAuthClient> {
  const path = join(profileDir(account), 'credentials.json');
  const raw = await readJson<Record<string, unknown>>(path);
  if (raw === null) {
    throw gcError('no_credentials', {
      detail: `Положи credentials.json в ${profileDir(account)} (OAuth Client ID, тип Web application).`,
      cause: 'ENOENT',
    });
  }
  const section = (raw['web'] ?? raw['installed']) as Record<string, unknown> | undefined;
  const clientId = section?.['client_id'];
  const clientSecret = section?.['client_secret'];
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw gcError('no_credentials', {
      detail: 'В credentials.json нет секции web/installed с client_id и client_secret.',
      cause: 'malformed_credentials',
    });
  }
  const redirects = section?.['redirect_uris'];
  const redirectUri =
    Array.isArray(redirects) && typeof redirects[0] === 'string'
      ? redirects[0]
      : 'http://localhost:3333';
  return { clientId, clientSecret, redirectUri };
}

/** Файл ключа анклава профиля: ссылка на ключ в Secure Enclave этого Mac (D-24). */
export function identityPath(account: string = DEFAULT_ACCOUNT): string {
  return join(profileDir(account), IDENTITY_FILE);
}

/** Секрет — во временный файл 600 и переименованием на место: половины файла не бывает. */
async function writeSecret(path: string, text: string): Promise<void> {
  const draft = `${path}.part`;
  await writeFile(draft, text, { mode: FILE_MODE, flag: 'w' });
  await chmod(draft, FILE_MODE);
  await rename(draft, path);
}

/**
 * Записать refresh-токен — только через шифровальщика (правило `token.sealed-at-rest`).
 * Шифротекст, в котором виден сам токен, на диск не ложится: последний ремень на случай,
 * если «шифровальщик» вернул открытый текст.
 */
export async function writeSealedToken(
  sealer: TokenSealer,
  token: { readonly refresh_token: string; readonly scope?: string; readonly obtained_at?: number },
  account: string = DEFAULT_ACCOUNT,
): Promise<TokenMeta> {
  const sealed = await sealer.seal(JSON.stringify({ refresh_token: token.refresh_token }));
  if (sealed.includes(token.refresh_token)) {
    throw gcError('internal', {
      detail: 'Шифровальщик вернул открытый токен — на диск он не ляжет.',
      cause: 'seal_returned_plaintext',
    });
  }
  const dir = profileDir(account);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE).catch(() => undefined);
  const now = Date.now();
  const meta: TokenMeta = {
    ...(token.scope === undefined ? {} : { scope: token.scope }),
    obtained_at: token.obtained_at ?? now,
    recipient: sealer.recipient,
    sealed_at: now,
  };
  await writeSecret(join(dir, SEALED_FILE), sealed);
  await writeSecret(join(dir, META_FILE), JSON.stringify(meta, null, 2));
  return meta;
}

export function readTokenMeta(account: string = DEFAULT_ACCOUNT): Promise<TokenMeta | null> {
  return readJson<TokenMeta>(join(profileDir(account), META_FILE));
}

/** Шифротекст и метаданные; нет любого — `null`: зашифрованного токена нет. */
export async function readSealedToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<{ readonly sealed: string; readonly meta: TokenMeta } | null> {
  const meta = await readTokenMeta(account);
  const sealed = await readFile(join(profileDir(account), SEALED_FILE), 'utf8').catch(() => null);
  return meta === null || sealed === null ? null : { sealed, meta };
}

/** Открытый токен прежней раскладки — только для `gc seal`: отозвать старый вход. */
export function readPlaintextToken(account: string = DEFAULT_ACCOUNT): Promise<StoredToken | null> {
  return readJson<StoredToken>(join(profileDir(account), PLAIN_FILE));
}

export async function removePlaintextToken(account: string = DEFAULT_ACCOUNT): Promise<void> {
  await rm(join(profileDir(account), PLAIN_FILE), { force: true });
}

const DAY_MS = 86_400_000;

/** Предупреждения человеку о доступе: срок входа и открытый файл. */
function accessWarnings(refreshAgeDays: number | null, plaintext: boolean): string[] {
  const warnings: string[] = [];
  // 7 дней — предел Google для приложения в статусе Testing; предупреждаем на шестой,
  // чтобы «перестало работать» не случилось посреди работы.
  if (refreshAgeDays !== null && refreshAgeDays >= 6) {
    warnings.push(
      `Вход сделан ${refreshAgeDays} дн. назад. У приложения в статусе Testing Google ` +
        'обрубает доступ через 7 дней — войди заново (npm run gc -- login) или опубликуй ' +
        'приложение в Cloud Console, чтобы ограничение снялось.',
    );
  }
  if (plaintext) {
    warnings.push(
      'Токен Google лежит открытым файлом token.json — его читает любая программа под этим ' +
        'пользователем. G connect его не берёт: владелец запускает npm run gc -- seal.',
    );
  }
  return warnings;
}

export async function profileStatus(account: string = DEFAULT_ACCOUNT): Promise<ProfileStatus> {
  const dir = profileDir(account);
  const hasDir = await exists(dir);
  const hasCredentials = await exists(join(dir, 'credentials.json'));
  const meta = hasDir ? await readTokenMeta(account) : null;
  const sealed = meta !== null && (await exists(join(dir, SEALED_FILE)));
  const plaintext = hasDir && (await exists(join(dir, PLAIN_FILE)));
  const scopes = meta?.scope === undefined ? [] : meta.scope.split(/\s+/).filter(Boolean);
  const refreshAgeDays =
    meta === null ? null : Math.floor((Date.now() - meta.obtained_at) / DAY_MS);

  const state: ProfileStatus['state'] = !hasDir
    ? 'no_profile'
    : !hasCredentials
      ? 'no_credentials'
      : sealed
        ? 'connected'
        : plaintext
          ? 'unsealed'
          : 'needs_reauth';

  return {
    account,
    state,
    hasCredentials,
    hasToken: sealed,
    scopes,
    refreshAgeDays,
    warnings: accessWarnings(refreshAgeDays, plaintext),
  };
}

/**
 * Требуемые scopes выданы? Список приходит от вызывающего, потому что MVP-набор (§11.7)
 * ещё меняется, и зашивать его в профили нельзя.
 */
export function missingScopes(
  status: ProfileStatus,
  required: readonly string[],
): readonly string[] {
  return required.filter((scope) => !status.scopes.includes(scope));
}

/** Профиль готов к работе — или ошибка с действием, а не ENOENT (пример A12 спеки). */
export async function requireProfile(account: string = DEFAULT_ACCOUNT): Promise<ProfileStatus> {
  const status = await profileStatus(account);
  if (status.state === 'no_profile') {
    throw gcError('no_profile', {
      detail: `Профиль «${account}» не найден: нет каталога ${profileDir(account)}.`,
    });
  }
  if (status.state === 'no_credentials') {
    throw gcError('no_credentials', { detail: `В профиле «${account}» нет credentials.json.` });
  }
  if (status.state === 'needs_reauth') {
    throw gcError('auth_expired', {
      detail: `В профиле «${account}» нет действующего refresh-токена — нужен повторный вход.`,
      cause: 'no_refresh_token',
    });
  }
  if (status.state === 'unsealed') {
    throw gcError('token_unsealed', {
      detail:
        `Токен профиля «${account}» лежит открытым файлом token.json, и G connect его не берёт ` +
        '(D-24). Владелец запускает в терминале: npm run gc -- seal — он зашифрует вход ключом ' +
        'анклава и отзовёт старый.',
    });
  }
  return status;
}
