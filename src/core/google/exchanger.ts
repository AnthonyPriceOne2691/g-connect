/**
 * `TokenExchanger` над `googleapis`: единственное место, где ядро говорит с OAuth-сервером
 * Google. Обмен и обновление здесь, а не в браузере (§13.5).
 */

import { google } from 'googleapis';

import { fromGoogleError } from '../errors.js';
import type { OAuthClient, StoredToken } from '../profiles.js';
import type { TokenExchanger, TokenRevoker } from '../auth.js';

/** То, что мы читаем из ответа Google. Нужен свой тип: `Credentials` из googleapis
 *  не имеет индексной подписи, а приведение к `Record` — лишнее звено. */
interface RawCredentials {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
}

const oauthClient = (client: OAuthClient) =>
  new google.auth.OAuth2(client.clientId, client.clientSecret, client.redirectUri);

const toStored = (credentials: RawCredentials): StoredToken => {
  const out: {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expiry_date?: number;
    token_type?: string;
  } = {};
  const access = credentials.access_token ?? undefined;
  const refresh = credentials.refresh_token ?? undefined;
  const scope = credentials.scope ?? undefined;
  const expiry = credentials.expiry_date ?? undefined;
  const type = credentials.token_type ?? undefined;
  if (access !== undefined) out.access_token = access;
  if (refresh !== undefined) out.refresh_token = refresh;
  if (scope !== undefined) out.scope = scope;
  if (expiry !== undefined) out.expiry_date = expiry;
  if (type !== undefined) out.token_type = type;
  return out;
};

export const googleExchanger: TokenExchanger = {
  async exchangeCode(client: OAuthClient, code: string): Promise<StoredToken> {
    try {
      const { tokens } = await oauthClient(client).getToken(code);
      return toStored(tokens);
    } catch (error) {
      throw fromGoogleError(error, 'Обмен кода на токен не удался.');
    }
  },

  async refresh(client: OAuthClient, refreshToken: string): Promise<StoredToken> {
    try {
      const auth = oauthClient(client);
      auth.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await auth.refreshAccessToken();
      return toStored(credentials);
    } catch (error) {
      throw fromGoogleError(
        error,
        'Обновление токена не удалось. Частая причина: приложение в Cloud Console стоит ' +
          'в статусе Testing, а Google обрубает refresh-токен через 7 дней. Помогает ' +
          'повторный вход (npm run gc -- login) или публикация приложения.',
      );
    }
  },
};

interface GoogleAuthFailure {
  readonly message?: unknown;
  readonly response?: { readonly data?: { readonly error?: unknown } };
}

/**
 * Отказ обмена — «токена больше нет», а не сбой. По документации OAuth Google: HTTP 400,
 * `{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}`.
 */
export function isInvalidGrant(error: unknown): boolean {
  const raw = (error ?? {}) as GoogleAuthFailure;
  return (
    raw.response?.data?.error === 'invalid_grant' ||
    (typeof raw.message === 'string' && raw.message.includes('invalid_grant'))
  );
}

/** Отзыв уже отозванного: HTTP 400 `{"error": "invalid_token"}` — цель достигнута. */
export function isAlreadyRevoked(error: unknown): boolean {
  return ((error ?? {}) as GoogleAuthFailure).response?.data?.error === 'invalid_token';
}

export const googleRevoker: TokenRevoker = {
  async revoke(refreshToken: string): Promise<void> {
    try {
      await new google.auth.OAuth2().revokeToken(refreshToken);
    } catch (error) {
      if (isAlreadyRevoked(error)) return;
      throw fromGoogleError(error, 'Отзыв старого входа в Google не удался.');
    }
  },

  async isAlive(client: OAuthClient, refreshToken: string): Promise<boolean> {
    try {
      const auth = oauthClient(client);
      auth.setCredentials({ refresh_token: refreshToken });
      await auth.refreshAccessToken();
      return true;
    } catch (error) {
      if (isInvalidGrant(error)) return false;
      throw fromGoogleError(error, 'Не удалось спросить Google, жив ли старый вход.');
    }
  },
};
