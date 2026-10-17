/**
 * OAuth: вход и пригодность профиля (DESIGN.md §11.7, §13.5).
 *
 * Обмен кода на токен делает ЯДРО — ни `client_secret`, ни токен не уходят в браузер
 * и наружу из этого модуля: панель получает статус (§13.5). Сетевая часть вынесена
 * за интерфейс `TokenExchanger`, поэтому и петля redirect'а, и логика обновления
 * проверяются без Google. Токен после входа ложится сразу шифротекстом (D-24); обновление
 * access-токена живёт в хранилище процесса — `src/core/token/vault.ts`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { gcError } from './errors.js';
import {
  DEFAULT_ACCOUNT,
  missingScopes,
  readOAuthClient,
  requireProfile,
  writeSealedToken,
  type OAuthClient,
  type StoredToken,
  type TokenSealer,
} from './profiles.js';

/**
 * Набор прав MVP (§11.7). `forms.body.readonly` сознательно НЕ входит: лишний scope —
 * лишняя площадь. Следствие названо в плане: старый token.json не подойдёт, нужен
 * повторный вход, и человеку это надо сказать текстом, а не отдать как ошибку авторизации.
 * `gmail.send` — только отправка, без чтения ящика: письма агентствам из таблицы продаж.
 */
export const MVP_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export const REDIRECT_PORT = 3333;

export interface TokenExchanger {
  exchangeCode(client: OAuthClient, code: string): Promise<StoredToken>;
  refresh(client: OAuthClient, refreshToken: string): Promise<StoredToken>;
}

/**
 * Отзыв входа — для перехода на шифротекст (`gc seal`, D-24). По документации Google отзыв
 * гасит ВСЕ токены приложения и не мгновенно, поэтому вход после него — только когда
 * старый токен уже не принимается (`isAlive` — false).
 */
export interface TokenRevoker {
  revoke(refreshToken: string): Promise<void>;
  isAlive(client: OAuthClient, refreshToken: string): Promise<boolean>;
}

export function buildAuthUrl(
  client: OAuthClient,
  scopes: readonly string[] = MVP_SCOPES,
  state?: string,
): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  // Без `offline` refresh_token не приходит на повторных входах, и «подключено»
  // разваливается через час без объяснимой причины.
  url.searchParams.set('access_type', 'offline');
  // `select_account` — из живого промаха: при одном залогиненном аккаунте Google не
  // показывает выбор, и человек подтверждает доступ НЕ тем аккаунтом, даже не заметив.
  // Для инструмента, у которого профиль = аккаунт, это не мелочь: цена ошибки —
  // токен чужой личности в профиле.
  url.searchParams.set('prompt', 'select_account consent');
  if (state !== undefined) url.searchParams.set('state', state);
  return url.toString();
}

export interface WaitForCodeOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly state?: string;
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:34rem"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Поднимает локальный сервер на redirect-порту и ждёт код. Возврат Google приходит
 * ровно сюда; браузер получает человеческую страницу, а не пустой ответ.
 */
export function waitForCode(options: WaitForCodeOptions = {}): Promise<string> {
  const port = options.port ?? REDIRECT_PORT;
  const timeoutMs = options.timeoutMs ?? 300_000;

  return new Promise<string>((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');

      const finish = (status: number, title: string, body: string): void => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE(title, body));
      };

      if (error !== null) {
        finish(400, 'Доступ не выдан', 'Окно можно закрыть и попробовать снова.');
        cleanup();
        reject(
          gcError('auth_expired', {
            detail:
              error === 'access_denied'
                ? 'Ты отказал в доступе в окне Google — без него ядро не может читать таблицы.'
                : `Google вернул ошибку авторизации: ${error}.`,
            cause: error,
          }),
        );
        return;
      }
      if (options.state !== undefined && state !== options.state) {
        finish(
          400,
          'Не тот запрос',
          'Похоже, это чужой или устаревший переход. Начни вход заново.',
        );
        return;
      }
      if (code === null) {
        finish(404, 'Жду возврата от Google', 'Эта страница откроется сама после подтверждения.');
        return;
      }
      finish(200, 'Готово', 'Аккаунт подключён. Окно можно закрыть.');
      cleanup();
      resolve(code);
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(
        gcError('auth_expired', {
          detail: `Вход не завершён за ${Math.round(timeoutMs / 1000)} с — окно Google закрыто или не открылось.`,
          cause: 'oauth_timeout',
        }),
      );
    }, timeoutMs);
    timer.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        err.code === 'EADDRINUSE'
          ? gcError('internal', {
              detail: `Порт ${port} занят другим процессом — вход через него невозможен.`,
              cause: 'EADDRINUSE',
            })
          : gcError('internal', {
              detail: 'Локальный сервер входа не поднялся.',
              cause: err.message,
            }),
      );
    });

    server.listen(port, '127.0.0.1');
  });
}

export interface LoginOptions {
  readonly account?: string;
  readonly scopes?: readonly string[];
  readonly exchanger: TokenExchanger;
  /** Шифровальщик ключа анклава: токен ложится на диск только шифротекстом (D-24). */
  readonly sealer: TokenSealer;
  /** Как показать ссылку человеку: открыть браузер или напечатать. */
  readonly present?: (url: string) => void | Promise<void>;
  readonly port?: number;
  readonly timeoutMs?: number;
}

export interface LoginResult {
  readonly account: string;
  readonly scopes: readonly string[];
}

/** Полный вход: ссылка → согласие → код → токен в профиль шифротекстом (600). */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const account = options.account ?? DEFAULT_ACCOUNT;
  const scopes = options.scopes ?? MVP_SCOPES;
  const client = await readOAuthClient(account);
  const state = Math.random().toString(36).slice(2);

  const url = buildAuthUrl(client, scopes, state);
  const waiting = waitForCode({
    state,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  await options.present?.(url);

  const code = await waiting;
  const token = await options.exchanger.exchangeCode(client, code);
  if (token.refresh_token === undefined) {
    throw gcError('auth_expired', {
      detail:
        'Google не выдал refresh-токен. Обычно это значит, что вход шёл без access_type=offline ' +
        'или доступ уже был выдан ранее — отзови доступ приложению и войди снова.',
      cause: 'no_refresh_token',
    });
  }
  await writeSealedToken(
    options.sealer,
    {
      refresh_token: token.refresh_token,
      ...(token.scope === undefined ? {} : { scope: token.scope }),
    },
    account,
  );
  return { account, scopes: (token.scope ?? scopes.join(' ')).split(/\s+/).filter(Boolean) };
}

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/**
 * Профиль пригоден и права выданы — или ошибка с действием. Недостающее право — отдельная
 * ошибка с объяснением, ЧТО именно не выдано и зачем: иначе смена набора scopes выглядит
 * как «доступ сломался».
 */
export async function requireUsableProfile(
  account: string,
  required: readonly string[] = MVP_SCOPES,
): Promise<void> {
  const status = await requireProfile(account);
  const lacking = missingScopes(status, required);
  if (lacking.length === 0) return;
  throw gcError('scope_missing', {
    detail:
      `Профилю «${account}» не выдано: ${lacking.map((s) => s.replace(SCOPE_PREFIX, '')).join(', ')}. ` +
      'Нужен повторный вход — набор прав изменился, старый токен их не покрывает.',
    cause: lacking.join(' '),
  });
}
