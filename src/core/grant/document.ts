/**
 * Документ разрешения проекта (D-23): ровно тот текст, который подписывает палец владельца.
 *
 * Подпись ключа Secure Enclave сверяется с текстом байт в байт, поэтому формат строгий:
 * заголовок, шесть строк в фиксированном порядке, ни одной лишней, срок не длиннее суток.
 * Разбор, принимающий «почти тот же» текст, принял бы и подправленный после подписи.
 */

import { createHash, randomBytes } from 'node:crypto';

export const GRANT_HEADER = 'g-connect grant 1';

/** «Всё своё на срок» — решение владельца 2026-10-17; других областей пока нет. */
export const GRANT_SCOPES = ['own'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export interface GrantDocument {
  /** Корень проекта сессии — `CLAUDE_PROJECT_DIR`, как его передал клиент. */
  readonly project: string;
  /** Профиль Google: разрешение одного аккаунта не открывает другой. */
  readonly account: string;
  readonly scope: GrantScope;
  /** Время выдачи и срок — ISO с местным смещением: человек читает «до 23:59», а не UTC. */
  readonly issued: string;
  readonly expires: string;
  /** Случайное значение: два разрешения одного дня — разные тексты и разные подписи. */
  readonly nonce: string;
}

const FIELDS = ['project', 'account', 'scope', 'issued', 'expires', 'nonce'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const NONCE = /^[0-9a-f]{32}$/;

export function grantText(doc: GrantDocument): string {
  return `${[GRANT_HEADER, ...FIELDS.map((field) => `${field}: ${doc[field]}`)].join('\n')}\n`;
}

/** Строгий разбор: любое отклонение от формы — `undefined`, а не догадка. */
export function parseGrantText(text: string): GrantDocument | undefined {
  if (!text.endsWith('\n')) return undefined;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== FIELDS.length + 1 || lines[0] !== GRANT_HEADER) return undefined;
  const values = FIELDS.map((field, index) => {
    const line = lines[index + 1] ?? '';
    const prefix = `${field}: `;
    return line.startsWith(prefix) ? line.slice(prefix.length) : '';
  });
  if (values.some((value) => value === '' || value !== value.trim())) return undefined;
  const [project, account, scope, issued, expires, nonce] = values as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!isScope(scope) || !NONCE.test(nonce)) return undefined;
  const span = Date.parse(expires) - Date.parse(issued);
  if (!Number.isFinite(span) || span <= 0 || span > DAY_MS) return undefined;
  return { project, account, scope, issued, expires, nonce };
}

function isScope(value: string): value is GrantScope {
  return (GRANT_SCOPES as readonly string[]).includes(value);
}

/** 23:59:59 местного дня — срок разрешения по решению владельца. */
export function endOfLocalDay(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  return end;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `2026-10-17T23:59:59+03:00` — местное время со смещением, без миллисекунд. */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function newGrant(project: string, account: string, now: Date): GrantDocument {
  // Касание в последнюю секунду дня дало бы срок длиной ноль — тогда до конца следующего:
  // это всё ещё меньше суток, и разбор такой текст принимает.
  const today = endOfLocalDay(now);
  const end =
    today.getTime() > now.getTime() ? today : endOfLocalDay(new Date(now.getTime() + 60_000));
  return {
    project,
    account,
    scope: 'own',
    issued: localIso(now),
    expires: localIso(end),
    nonce: randomBytes(16).toString('hex'),
  };
}

/** Имя файла разрешения — хэш проекта: путь с пробелами и слэшами в имя файла не кладём. */
export function projectKey(project: string): string {
  return createHash('sha256').update(project).digest('hex');
}
