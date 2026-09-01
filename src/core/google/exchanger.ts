/**
 * `TokenExchanger` над `googleapis`: единственное место, где ядро говорит с OAuth-сервером
 * Google. Обмен и обновление здесь, а не в браузере (§13.5).
 */

import { google } from 'googleapis';

import { fromGoogleError } from '../errors.ts';
import type { OAuthClient, StoredToken } from '../profiles.ts';
import type { TokenExchanger } from '../auth.ts';

const oauthClient = (client: OAuthClient) =>
  new google.auth.OAuth2(client.clientId, client.clientSecret, client.redirectUri);

const toStored = (credentials: Record<string, unknown>): StoredToken => {
  const pick = <T>(key: string): T | undefined =>
    credentials[key] === null ? undefined : (credentials[key] as T | undefined);
  const out: Record<string, unknown> = {};
  const access = pick<string>('access_token');
  const refresh = pick<string>('refresh_token');
  const scope = pick<string>('scope');
  const expiry = pick<number>('expiry_date');
  const type = pick<string>('token_type');
  if (access !== undefined) out['access_token'] = access;
  if (refresh !== undefined) out['refresh_token'] = refresh;
  if (scope !== undefined) out['scope'] = scope;
  if (expiry !== undefined) out['expiry_date'] = expiry;
  if (type !== undefined) out['token_type'] = type;
  return out as StoredToken;
};

export const googleExchanger: TokenExchanger = {
  async exchangeCode(client: OAuthClient, code: string): Promise<StoredToken> {
    try {
      const { tokens } = await oauthClient(client).getToken(code);
      return toStored(tokens as Record<string, unknown>);
    } catch (error) {
      throw fromGoogleError(error, 'Обмен кода на токен не удался.');
    }
  },

  async refresh(client: OAuthClient, refreshToken: string): Promise<StoredToken> {
    try {
      const auth = oauthClient(client);
      auth.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await auth.refreshAccessToken();
      return toStored(credentials as Record<string, unknown>);
    } catch (error) {
      throw fromGoogleError(error, 'Обновление токена не удалось — возможно, доступ отозван.');
    }
  },
};
