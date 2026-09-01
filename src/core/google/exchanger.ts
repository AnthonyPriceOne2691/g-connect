/**
 * `TokenExchanger` над `googleapis`: единственное место, где ядро говорит с OAuth-сервером
 * Google. Обмен и обновление здесь, а не в браузере (§13.5).
 */

import { google } from 'googleapis';

import { fromGoogleError } from '../errors.js';
import type { OAuthClient, StoredToken } from '../profiles.js';
import type { TokenExchanger } from '../auth.js';

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
      throw fromGoogleError(error, 'Обновление токена не удалось — возможно, доступ отозван.');
    }
  },
};
