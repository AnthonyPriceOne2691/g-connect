/**
 * Профили: раскладка `~/.gconnect/<account>/` (DESIGN.md §11.5, §13.5).
 *
 * Один профиль = один аккаунт Google (D-2). Секреты живут только здесь, с правами 600,
 * и наружу из ядра не выходят: функции возвращают СТАТУС, а не токен.
 * Корень переопределяется `GCONNECT_HOME` — это же делает профили тестируемыми.
 */

import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
}

/** То, что видит панель и агент: состояние без секретов (§13.5). */
export interface ProfileStatus {
  readonly account: string;
  readonly state: 'no_profile' | 'no_credentials' | 'needs_reauth' | 'connected';
  readonly hasCredentials: boolean;
  readonly hasToken: boolean;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
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

export async function listProfiles(): Promise<string[]> {
  try {
    const entries = await readdir(profilesRoot(), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
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

export async function readToken(account: string = DEFAULT_ACCOUNT): Promise<StoredToken | null> {
  return readJson<StoredToken>(join(profileDir(account), 'token.json'));
}

/** Пишет токен с правами 600 в каталог с правами 700. Каталог создаётся при нужде. */
export async function writeToken(
  token: StoredToken,
  account: string = DEFAULT_ACCOUNT,
): Promise<void> {
  const dir = profileDir(account);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE).catch(() => undefined);
  const path = join(dir, 'token.json');
  await writeFile(path, JSON.stringify(token, null, 2), { mode: FILE_MODE, flag: 'w' });
  await chmod(path, FILE_MODE);
}

export async function profileStatus(account: string = DEFAULT_ACCOUNT): Promise<ProfileStatus> {
  const dir = profileDir(account);
  const hasDir = await exists(dir);
  const hasCredentials = await exists(join(dir, 'credentials.json'));
  const token = hasDir ? await readToken(account) : null;
  const scopes = token?.scope === undefined ? [] : token.scope.split(/\s+/).filter(Boolean);
  const expiresAt =
    token?.expiry_date === undefined ? null : new Date(token.expiry_date).toISOString();

  const state: ProfileStatus['state'] = !hasDir
    ? 'no_profile'
    : !hasCredentials
      ? 'no_credentials'
      : token === null || token.refresh_token === undefined
        ? 'needs_reauth'
        : 'connected';

  return { account, state, hasCredentials, hasToken: token !== null, scopes, expiresAt };
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
  return status;
}
