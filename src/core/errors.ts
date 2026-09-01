/**
 * Типизированные ошибки ядра (DESIGN.md §13.7, решение D-15).
 *
 * Правило: ошибка — объект с названием проблемы и предлагаемым действием, а не строка
 * и не код. Код и correlationId остаются, но их место — «подробности» и аудит-лог,
 * а не первый экран человека.
 */

import { ERROR_CATALOG, type ActionKind, type ErrorCode } from './error-catalog.ts';

export interface GcAction {
  readonly kind: Exclude<ActionKind, null>;
  readonly label: string;
}

export interface GcErrorPayload {
  readonly code: ErrorCode;
  readonly title: string;
  /** Конкретика этого случая: какой файл, какой профиль, какая колонка. */
  readonly detail?: string;
  /** Техническая причина от источника (`invalid_grant`, `ECONNRESET`, статус). */
  readonly cause?: string;
  readonly retryable: boolean;
  readonly action: GcAction | null;
  readonly correlationId: string;
}

export interface GcErrorOptions {
  detail?: string;
  cause?: string;
  /** Переопределить `retryable` из каталога — только когда источник сказал точнее. */
  retryable?: boolean;
  correlationId?: string;
}

let counter = 0;

/** `gc-<время в 36-й системе><счётчик>` — коротко, сортируемо, без внешних зависимостей. */
export function newCorrelationId(): string {
  counter = (counter + 1) % 1296;
  return `gc-${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
}

export class GcError extends Error {
  readonly payload: GcErrorPayload;

  constructor(payload: GcErrorPayload) {
    super(`${payload.code}: ${payload.title}`);
    this.name = 'GcError';
    this.payload = payload;
  }

  /** Для показа человеку: без стектрейса и без внутренних полей. */
  toPayload(): GcErrorPayload {
    return this.payload;
  }
}

export function gcError(code: ErrorCode, options: GcErrorOptions = {}): GcError {
  const entry = ERROR_CATALOG[code];
  const action: GcAction | null =
    entry.action === null || entry.actionLabel === null
      ? null
      : { kind: entry.action, label: entry.actionLabel };
  return new GcError({
    code,
    title: entry.title,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    retryable: options.retryable ?? entry.retryable,
    action,
    correlationId: options.correlationId ?? newCorrelationId(),
  });
}

export function isGcError(value: unknown): value is GcError {
  return value instanceof GcError;
}

/** Форма ошибки, как её отдают клиенты googleapis и fetch. */
interface UnknownApiError {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  errors?: unknown;
  response?: { status?: unknown; data?: unknown };
}

function httpStatusOf(error: UnknownApiError): number | undefined {
  for (const candidate of [error.status, error.code, error.response?.status]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

const NETWORK_CAUSES = [
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
];

/**
 * Ошибка Google API → код ядра. Разбор идёт по статусу и по тексту причины: 401 с
 * `invalid_grant` — это истёкший доступ (человеку надо переподключиться), а 401 без него
 * может быть отозванным правом, и путать их нельзя — действия разные.
 */
export function fromGoogleError(error: unknown, detail?: string): GcError {
  if (isGcError(error)) return error;

  const raw = (error ?? {}) as UnknownApiError;
  const message = typeof raw.message === 'string' ? raw.message : String(error);
  const codeText = typeof raw.code === 'string' ? raw.code : '';
  const status = httpStatusOf(raw);
  const opts = (cause: string): GcErrorOptions =>
    detail === undefined ? { cause } : { detail, cause };

  const networkCause = NETWORK_CAUSES.find((c) => codeText === c || message.includes(c));
  if (networkCause !== undefined) return gcError('offline', opts(networkCause));

  if (status === 401) {
    if (message.includes('invalid_grant')) return gcError('auth_expired', opts('invalid_grant'));
    return gcError('auth_expired', opts(`HTTP 401: ${message}`));
  }
  if (status === 403) {
    if (/insufficient|scope/i.test(message)) return gcError('scope_missing', opts(message));
    if (/rate limit|quota|userRateLimitExceeded/i.test(message)) {
      return gcError('quota_exceeded', opts(message));
    }
    return gcError('forbidden', opts(`HTTP 403: ${message}`));
  }
  if (status === 404) return gcError('not_found', opts(`HTTP 404: ${message}`));
  if (status === 429) return gcError('quota_exceeded', opts(`HTTP 429: ${message}`));
  if (status === 400) return gcError('bad_request', opts(`HTTP 400: ${message}`));
  if (status !== undefined && status >= 500) {
    return gcError('google_unavailable', opts(`HTTP ${status}: ${message}`));
  }
  return gcError('internal', opts(message));
}
