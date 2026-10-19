/**
 * Переход на токен под пальцем — `gc seal` (D-24). Один раз, командой владельца в терминале.
 *
 * Порядок несущий (урок L19), и каждый шаг держит дверь следующему:
 *   1. программы есть — иначе отказ с командой установки, ничего не тронуто;
 *   2. ключ анклава — новый или прежний, если прошлый запуск оборвался после него;
 *   3. пробное касание — шифруем случайную строку и расшифровываем: ключ работает, и
 *      человек в цепочке ДО необратимого;
 *   4. отзыв старого входа — по документации Google он гасит все токены приложения и не
 *      мгновенно, поэтому —
 *   5. ждём, пока Google не перестанет принимать старый токен, и только тогда —
 *   6. новый вход в браузере: токен сразу шифротекстом тем же ключом, что прошёл пробу;
 *   7. открытый `token.json` удаляется. Его копии в снимках и бэкапах — мусор: токен отозван.
 * Оборвалось на любом шаге — `token.json` на месте, повтор `gc seal` продолжает с начала.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { LoginResult, TokenRevoker } from '../auth.js';
import { gcError } from '../errors.js';
import {
  DEFAULT_ACCOUNT,
  identityPath,
  readOAuthClient,
  readPlaintextToken,
  removePlaintextToken,
  type TokenSealer,
} from '../profiles.js';
import {
  createSeIdentity,
  recipientInIdentity,
  requireAgeTools,
  sealFor,
  unsealWith,
  type AgeTools,
} from './age.js';

/** Сколько ждать подтверждения отзыва: Google обещает «некоторое время». */
const REVOKE_POLLS = 12;
const REVOKE_POLL_MS = 5_000;

export interface SealFlowDeps {
  readonly account?: string;
  readonly tools: AgeTools;
  readonly revoker: TokenRevoker;
  /** Вход в браузере с данным шифровальщиком — токен ложится шифротекстом. */
  login(sealer: TokenSealer): Promise<LoginResult>;
  /** Строка человеку о ходе — печатает фасад. */
  readonly say?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SealReport {
  readonly recipient: string;
  readonly revoked: boolean;
  readonly scopes: readonly string[];
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ключ анклава профиля: прежний, если есть, иначе новый. */
async function identityRecipient(tools: AgeTools, account: string): Promise<string> {
  const file = identityPath(account);
  const existing = recipientInIdentity(await readFile(file, 'utf8').catch(() => ''));
  return existing ?? createSeIdentity(tools, file);
}

/** Пробное касание: ключ работает, и человек рядом. Отказ — дальше не идём. */
async function probeTouch(tools: AgeTools, account: string, recipient: string): Promise<void> {
  const nonce = randomBytes(16).toString('hex');
  const sealed = await sealFor(tools, recipient, nonce);
  const back = await unsealWith(tools, identityPath(account), sealed, recipient);
  if (back !== nonce) {
    throw gcError('internal', {
      detail: 'Пробная расшифровка вернула не то, что зашифровано: ключ анклава не годится.',
      cause: 'probe_mismatch',
    });
  }
}

/** Отозвать и дождаться, пока Google перестанет принимать старый токен. */
async function revokeAndConfirm(deps: SealFlowDeps, account: string, token: string): Promise<void> {
  const sleep = deps.sleep ?? pause;
  await deps.revoker.revoke(token);
  const client = await readOAuthClient(account);
  for (let poll = 0; poll < REVOKE_POLLS; poll += 1) {
    if (!(await deps.revoker.isAlive(client, token))) return;
    await sleep(REVOKE_POLL_MS);
  }
  throw gcError('google_unavailable', {
    detail:
      `Google за ${(REVOKE_POLLS * REVOKE_POLL_MS) / 1000} с не подтвердил отзыв старого входа — ` +
      'новый вход не начат, иначе отзыв погасил бы и его. token.json на месте: повтори gc seal.',
    cause: 'revoke_not_confirmed',
  });
}

export async function sealProfile(deps: SealFlowDeps): Promise<SealReport> {
  const account = deps.account ?? DEFAULT_ACCOUNT;
  const say = deps.say ?? (() => undefined);
  await requireAgeTools(deps.tools);
  const recipient = await identityRecipient(deps.tools, account);
  say('Пробное касание: G connect просит палец или пароль Mac, чтобы проверить ключ анклава.');
  await probeTouch(deps.tools, account, recipient);

  const old = (await readPlaintextToken(account))?.refresh_token;
  if (old !== undefined) {
    say('Отзываю старый вход в Google и жду подтверждения…');
    await revokeAndConfirm(deps, account, old);
  }
  say('Новый вход: откроется браузер — подтверди доступ.');
  const sealer: TokenSealer = {
    recipient,
    seal: (plain) => sealFor(deps.tools, recipient, plain),
  };
  const result = await deps.login(sealer);
  await removePlaintextToken(account);
  return { recipient, revoked: old !== undefined, scopes: result.scopes };
}
