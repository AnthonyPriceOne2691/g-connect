/**
 * Разрешение проекта касанием пальца (D-23): выдать, проверить, отозвать.
 *
 * Файл разрешения без подписи — ничто. Подпись проверяется ключом, который ОТДАЁТ агент
 * (Secretive отдаёт только ключи Secure Enclave), а не ключом из файла: файл агент с
 * доступом к диску подменил бы своим программным ключом и подписывал бы без пальца.
 * Источник ключа и подпись внедряются — в тестах программный ключ, живьём Secretive, —
 * а проверка всегда идёт настоящим `ssh-keygen -Y verify`.
 */

import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { profilesHome } from '../env.js';
import { gcError } from '../errors.js';
import { grantPhrase, profileLabel } from '../profile-names.js';
import { grantText, newGrant, parseGrantText, projectKey, type GrantDocument } from './document.js';
import { verifySignature } from './ssh.js';

/** Сколько ждём касания: дольше — `grant_declined`, запрос сервер не держит. */
export const GRANT_TOUCH_TIMEOUT_MS = 60_000;

export interface GrantKeys {
  /** Имя ключа — для человека: «создай ключ „G connect“». */
  readonly keyName: string;
  /** Строка публичного ключа, которую ОТДАЛ агент; `undefined` — агента или ключа нет. */
  signerKey(): Promise<string | undefined>;
  /** Подпись текста — здесь macOS показывает Touch ID; `undefined` — отказ или тишина. */
  sign(text: string, publicKey: string, timeoutMs: number): Promise<string | undefined>;
}

export type GrantRefusal =
  | 'no_project'
  | 'no_grant'
  | 'malformed'
  | 'no_signer_key'
  | 'bad_signature'
  | 'other_project'
  | 'other_account'
  | 'expired';

export type GrantState =
  | { readonly state: 'granted'; readonly grant: GrantDocument }
  | {
      readonly state: 'none';
      readonly reason: GrantRefusal;
      readonly detail: string;
      /** Когда истекло — только у `expired`: человеку важно «вчера в 23:59», а не «нет». */
      readonly expiredAt?: string;
    };

interface StoredGrant {
  readonly text: string;
  readonly signature: string;
}

/**
 * Разрешения профиля (D-25): у каждого профиля свой каталог, файл — на пару «проект,
 * профиль». Раньше файл лежал на проект, и разрешение второго профиля затирало первое.
 * Прежний `grants/<проект>.json` не читается никем: мигрировать нечего — срок до 23:59.
 */
export function grantsDir(account: string): string {
  return join(profilesHome(), 'grants', account);
}

function grantFile(project: string, account: string): string {
  return join(grantsDir(account), `${projectKey(project)}.json`);
}

const none = (reason: GrantRefusal, detail: string, expiredAt?: string): GrantState =>
  expiredAt === undefined
    ? { state: 'none', reason, detail }
    : { state: 'none', reason, detail, expiredAt };

/** Проверенные тройки «ключ, текст, подпись» — подпись не перепроверяется на каждой записи. */
const verified = new Map<string, boolean>();

async function signatureHolds(stored: StoredGrant, publicKey: string): Promise<boolean> {
  const key = `${publicKey}\n${stored.text}\n${stored.signature}`;
  const known = verified.get(key);
  if (known !== undefined) return known;
  const ok = await verifySignature(stored.text, stored.signature, publicKey);
  verified.set(key, ok);
  return ok;
}

async function readStored(
  project: string,
  account: string,
): Promise<StoredGrant | 'absent' | 'malformed'> {
  let raw: string;
  try {
    raw = await readFile(grantFile(project, account), 'utf8');
  } catch {
    return 'absent';
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGrant>;
    return typeof parsed.text === 'string' && typeof parsed.signature === 'string'
      ? { text: parsed.text, signature: parsed.signature }
      : 'malformed';
  } catch {
    return 'malformed';
  }
}

/**
 * Действующее разрешение проекта — или отказ с причиной. Порядок проверок несущий: подпись
 * раньше содержимого, иначе подложенный файл отвечал бы правдоподобной причиной
 * («чужой проект») вместо настоящей («подписи нет»).
 */
export async function currentGrant(
  keys: GrantKeys,
  project: string | undefined,
  account: string,
  now: Date = new Date(),
): Promise<GrantState> {
  if (project === undefined) {
    return none(
      'no_project',
      'клиент не назвал проект сессии (нет CLAUDE_PROJECT_DIR) — только чтение',
    );
  }
  const signed = await signedText(keys, project, account);
  return typeof signed === 'string' ? judgeContent(signed, project, account, now) : signed;
}

/** Фаза первая — файл и подпись. Текст отдаётся дальше, только если подпись сошлась. */
async function signedText(
  keys: GrantKeys,
  project: string,
  account: string,
): Promise<string | GrantState> {
  const stored = await readStored(project, account);
  if (stored === 'absent')
    return none('no_grant', `для проекта ${project} ${profileLabel(account)} не открыт`);
  if (stored === 'malformed')
    return none('malformed', `файл разрешения повреждён — ${grantPhrase(account)} заново`);
  const publicKey = await keys.signerKey();
  if (publicKey === undefined) {
    return none(
      'no_signer_key',
      `агент Secretive не отдаёт ключ «${keys.keyName}» — подпись проверить нечем`,
    );
  }
  return (await signatureHolds(stored, publicKey))
    ? stored.text
    : none('bad_signature', 'подпись разрешения не сходится с ключом владельца — файл не принят');
}

/** Фаза вторая — содержимое подписанного текста: форма, проект, профиль, срок. */
function judgeContent(text: string, project: string, account: string, now: Date): GrantState {
  const grant = parseGrantText(text);
  if (grant === undefined)
    return none('malformed', `текст разрешения не той формы — ${grantPhrase(account)} заново`);
  if (grant.project !== project)
    return none('other_project', `разрешение выдано проекту ${grant.project}`);
  if (grant.account !== account)
    return none('other_account', `разрешение выдано профилю ${grant.account}`);
  if (Date.parse(grant.expires) <= now.getTime()) {
    return none('expired', `разрешение истекло ${grant.expires}`, grant.expires);
  }
  return { state: 'granted', grant };
}

/**
 * Выдать разрешение: построить текст, получить подпись пальцем, проверить её тем же путём,
 * что и при записи, и только тогда положить файл (600, каталог 700).
 */
export async function issueGrant(
  keys: GrantKeys,
  project: string,
  account: string,
  now: Date = new Date(),
  timeoutMs: number = GRANT_TOUCH_TIMEOUT_MS,
): Promise<GrantDocument> {
  const publicKey = await keys.signerKey();
  if (publicKey === undefined) {
    throw gcError('grant_key_missing', {
      detail:
        `Агент Secretive не отдаёт ключ «${keys.keyName}». Создай в Secretive ключ с этим именем ` +
        'и включённым Require Authentication — тогда каждое разрешение просит палец.',
    });
  }
  const grant = newGrant(project, account, now);
  const text = grantText(grant);
  const signature = await keys.sign(text, publicKey, timeoutMs);
  if (signature === undefined || !(await verifySignature(text, signature, publicKey))) {
    throw gcError('grant_declined', {
      detail: `Подписи нет: касание отменено или не пришло за ${Math.round(timeoutMs / 1000)} с.`,
    });
  }
  // `mode` у mkdir и writeFile действует только при СОЗДАНИИ: подложенный заранее файл с
  // правами 644 их бы сохранил. Права ставятся явно в обоих случаях.
  const dir = grantsDir(account);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dirname(dir), 0o700);
  await chmod(dir, 0o700);
  const file = grantFile(project, account);
  await writeFile(file, `${JSON.stringify({ text, signature })}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return grant;
}

/** Отозвать разрешение проекта у профиля; `false` — его и не было. */
export async function revokeGrant(project: string, account: string): Promise<boolean> {
  const stored = await readStored(project, account);
  if (stored === 'absent') return false;
  await rm(grantFile(project, account), { force: true });
  return true;
}

/** Строка списка разрешений машины — для человека в терминале (`gc grant`). */
export interface GrantListing {
  readonly project: string;
  readonly expires: string | null;
  readonly state: GrantState['state'] | GrantRefusal;
}

/**
 * Все разрешения машины: проект, срок и состояние — каждое проверено тем же путём, что
 * при записи. Файл с чужой подписью показывается как `bad_signature`, а не как разрешение.
 */
export async function listGrants(
  keys: GrantKeys,
  account: string,
  now: Date = new Date(),
): Promise<GrantListing[]> {
  let names: string[];
  try {
    names = (await readdir(grantsDir(account))).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const listing: GrantListing[] = [];
  for (const name of names) {
    const project = projectOf(
      await readFile(join(grantsDir(account), name), 'utf8').catch(() => ''),
    );
    if (project === undefined) {
      listing.push({ project: `(файл ${name})`, expires: null, state: 'malformed' });
      continue;
    }
    const state = await currentGrant(keys, project, account, now);
    listing.push({
      project,
      expires: state.state === 'granted' ? state.grant.expires : (state.expiredAt ?? null),
      state: state.state === 'granted' ? 'granted' : state.reason,
    });
  }
  return listing;
}

/** Проект из файла разрешения — только для подписи строки списка; битый файл — `undefined`. */
function projectOf(raw: string): string | undefined {
  try {
    const text = (JSON.parse(raw) as { text?: unknown }).text;
    return typeof text === 'string' ? parseGrantText(text)?.project : undefined;
  } catch {
    return undefined;
  }
}
