/**
 * Токен Google процесса (D-24) — одно хранилище на процесс сервера или команды.
 *
 * Access-токен живёт только в памяти и только до истечения (запас 60 с, чтобы не упасть на
 * середине запроса). Refresh-токен расшифровывается касанием на время обмена у Google и тут
 * же выбрасывается: в памяти не остаётся недельного секрета, поэтому через час — снова
 * касание (цена, принятая владельцем 2026-10-17).
 *
 * Хранилище окна само не вызывает: `accessToken()` при закрытом Google отвечает
 * `google_locked`, окно — только `unlock()` (правило `google.unlock-only-tool`).
 */

import { requireUsableProfile, type TokenExchanger } from '../auth.js';
import { gcError } from '../errors.js';
import { unlockLine } from '../profile-names.js';
import {
  readOAuthClient,
  readSealedToken,
  writeSealedToken,
  type TokenSealer,
} from '../profiles.js';
import type { TokenUnsealer } from './sealing.js';

/** Токен считается истёкшим заранее: запрос, начатый за секунду до срока, упал бы на середине. */
const EXPIRY_SKEW_MS = 60_000;
/** Google не назвал срок — живёт час, как все его access-токены. */
const DEFAULT_LIFETIME_MS = 3_600_000;

export interface VaultDeps {
  readonly account: string;
  readonly exchanger: TokenExchanger;
  readonly unsealer: TokenUnsealer;
  /** Шифровальщик для нового refresh-токена от Google — касания не нужно. */
  sealer(): Promise<TokenSealer>;
  readonly now?: () => number;
}

export type GoogleAccess =
  { readonly state: 'locked' } | { readonly state: 'unlocked'; readonly until: string };

export interface TokenVault {
  status(): GoogleAccess;
  /** Действующий access-токен или `google_locked` — окна здесь нет. */
  accessToken(): string;
  /** Открыть Google касанием; уже открыт — без окна. Одновременные вызовы — одно окно. */
  unlock(): Promise<{ readonly state: 'unlocked'; readonly until: string }>;
}

/** Время по часам машины, «19:42»: так его называет человек. */
export function clockTime(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Расшифрованное — `{"refresh_token": "..."}`; всё иное не токен. */
function refreshTokenOf(plain: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    parsed = null;
  }
  const token = (parsed as { refresh_token?: unknown } | null)?.refresh_token;
  if (typeof token !== 'string' || token === '') {
    throw gcError('internal', {
      detail: 'Расшифровано не то: в шифротексте нет refresh-токена. Войди заново: gc login.',
      cause: 'sealed_not_a_token',
    });
  }
  return token;
}

/**
 * Access-токен для клиентов Google — на каждое обращение. Час истёк — `google_locked`, а не
 * тихое открытие: окно вызывает только `gc_unlock` (правило `google.unlock-only-tool`).
 */
export function tokenForClients(vault: TokenVault): () => Promise<string> {
  // Отказ — отклонённым обещанием, а не броском: клиенты ждут обещание.
  return () => Promise.resolve().then(() => vault.accessToken());
}

export function tokenVault(deps: VaultDeps): TokenVault {
  const now = deps.now ?? Date.now;
  let access: { readonly token: string; readonly expiresAt: number } | undefined;
  let pending: Promise<{ readonly state: 'unlocked'; readonly until: string }> | undefined;

  const usableUntil = (): number | undefined =>
    access === undefined ? undefined : access.expiresAt - EXPIRY_SKEW_MS;
  const open = (): boolean => (usableUntil() ?? 0) > now();
  const unlocked = (): { readonly state: 'unlocked'; readonly until: string } => ({
    state: 'unlocked',
    until: clockTime(usableUntil() ?? now()),
  });

  async function exchange(): Promise<{ readonly state: 'unlocked'; readonly until: string }> {
    await requireUsableProfile(deps.account);
    const stored = await readSealedToken(deps.account);
    if (stored === null) {
      throw gcError('auth_expired', {
        detail: `У профиля «${deps.account}» нет зашифрованного токена — нужен вход: gc login.`,
        cause: 'no_sealed_token',
      });
    }
    const refreshToken = refreshTokenOf(await deps.unsealer.unseal(stored.sealed, stored.meta));
    const refreshed = await deps.exchanger.refresh(
      await readOAuthClient(deps.account),
      refreshToken,
    );
    if (refreshed.access_token === undefined) {
      throw gcError('auth_expired', {
        detail: 'Google не вернул access-токен при обновлении.',
        cause: 'refresh_without_access_token',
      });
    }
    // Google редко, но выдаёт новый refresh-токен: он ложится шифротекстом сразу, без
    // касания, а срок входа считается от прежнего — предупреждение не опаздывает.
    if (refreshed.refresh_token !== undefined && refreshed.refresh_token !== refreshToken) {
      const scope = refreshed.scope ?? stored.meta.scope;
      await writeSealedToken(
        await deps.sealer(),
        {
          refresh_token: refreshed.refresh_token,
          obtained_at: stored.meta.obtained_at,
          ...(scope === undefined ? {} : { scope }),
        },
        deps.account,
      );
    }
    access = {
      token: refreshed.access_token,
      expiresAt: refreshed.expiry_date ?? now() + DEFAULT_LIFETIME_MS,
    };
    return unlocked();
  }

  return {
    status: () => (open() ? unlocked() : { state: 'locked' }),
    accessToken() {
      if (open() && access !== undefined) return access.token;
      const until = usableUntil();
      throw gcError('google_locked', {
        // Строка своего профиля — в самом отказе (D-25): с двумя серверами рядом агент
        // говорит человеку, ЧЕЙ Google просит касание, а не общее «G connect».
        detail:
          (until === undefined
            ? 'Google в этой сессии ещё не открыт: токен под пальцем владельца.'
            : `Доступ к Google в этой сессии истёк в ${clockTime(until)}: нужно касание снова.`) +
          ` Скажи человеку «${unlockLine(deps.account)}» и вызови gc_unlock.`,
        cause: until === undefined ? 'not_unlocked' : 'expired',
      });
    },
    unlock() {
      if (open()) return Promise.resolve(unlocked());
      pending ??= exchange().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
