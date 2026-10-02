/**
 * Общее у клиентов-швов (`sheets.ts`, `docs.ts`): авторизация и перевод цвета.
 *
 * Вынесено не для красоты: две копии авторизации и hex-перевода уже разъехались бы
 * молча — это тот же класс, что два списка операций (урок L21), только в шве.
 */

import { google } from 'googleapis';

import { withRetry } from '../retry.js';

/** Авторизованный OAuth2-клиент из готового access-токена. */
export function authorizedClient(accessToken: string): InstanceType<typeof google.auth.OAuth2> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/** Сообщает о повторе, чтобы наверху можно было показать «попытка 2 из 3». */
export type RetryReporter = (
  attempt: number,
  total: number,
  delayMs: number,
  reason: string,
) => void;

/** `{red: 1, green: 0.5}` (доли) → `#ff8000`. Google отдаёт доли, человек вводит hex. */
export function rgbToHex(rgb: {
  red?: number | null;
  green?: number | null;
  blue?: number | null;
}): string {
  const part = (v: number | null | undefined): string =>
    Math.round((v ?? 0) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb.red)}${part(rgb.green)}${part(rgb.blue)}`;
}

/** Повтор с ретраями клиента: одна обёртка на оба шва, отчёт о попытках — наверх. */
export function makeRetry(
  onRetry: RetryReporter | undefined,
): <T>(fn: () => Promise<T>) => Promise<T> {
  return (fn) => withRetry(fn, onRetry === undefined ? {} : { onRetry });
}
