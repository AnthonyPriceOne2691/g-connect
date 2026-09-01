/**
 * Единственное место, где ядро читает переменные окружения (CQG-гейт `config-access`).
 *
 * Смысл правила: опечатка в настройке должна падать здесь и с объяснением, а не тихо
 * уходить в дефолт где-то в середине логики. Поэтому доступ типизирован и собран в одном
 * файле — гейт следит, чтобы `process.env` больше нигде не появился.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const read = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

/** Корень профилей. Переопределяется `GCONNECT_HOME` — этим же живут тесты. */
export function profilesHome(): string {
  return read('GCONNECT_HOME') ?? join(homedir(), '.gconnect');
}

/** Активный профиль (аккаунт Google). */
export function defaultAccount(): string {
  return read('GCONNECT_ACCOUNT') ?? 'default';
}
