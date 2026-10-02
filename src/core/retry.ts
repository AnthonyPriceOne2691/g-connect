/**
 * Повтор с экспоненциальной задержкой (DESIGN.md §11, порт логики из run.js).
 *
 * Повторяем только то, что имеет смысл повторять: 429 и 5xx от Google, обрывы сети.
 * 403 «нет доступа» повторять бессмысленно — там нужен человек, и ретрай лишь
 * прячет проблему за задержкой.
 */

import { fromGoogleError, isGcError } from './errors.js';

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  /** Инжектируется в тестах, чтобы не спать по-настоящему. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Сообщает наружу, что идёт повтор: панель показывает «попытка 2 из 3» (§13.7), сервер
   * пишет строку в stderr. С ПРИЧИНОЙ: без неё всплеск задержки (живьём 2026-10-02 — 30 с
   * и 20,7 с при обычных 0,6) не отличить от медленного ответа Google.
   */
  readonly onRetry?: (
    attempt: number,
    totalAttempts: number,
    delayMs: number,
    reason: string,
  ) => void;
}

const DEFAULTS = { maxRetries: 3, backoffMs: 1000 } as const;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
  const sleep = options.sleep ?? realSleep;
  const totalAttempts = maxRetries + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const gc = isGcError(error) ? error : fromGoogleError(error);
      const isLast = attempt === totalAttempts;
      if (!gc.payload.retryable || isLast) throw gc;
      const delay = backoffMs * 2 ** (attempt - 1);
      const reason =
        gc.payload.cause === undefined
          ? gc.payload.code
          : `${gc.payload.code}: ${gc.payload.cause}`;
      options.onRetry?.(attempt + 1, totalAttempts, delay, reason);
      await sleep(delay);
    }
  }
  /* istanbul ignore next — цикл всегда выходит через return или throw */
  throw isGcError(lastError) ? lastError : fromGoogleError(lastError);
}
