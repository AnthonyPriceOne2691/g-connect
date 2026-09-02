/**
 * Единственное место, где ядро читает переменные окружения (CQG-гейт `config-access`).
 *
 * Смысл правила: опечатка в настройке должна падать здесь и с объяснением, а не тихо
 * уходить в дефолт где-то в середине логики. Поэтому доступ типизирован и собран в одном
 * файле — гейт следит, чтобы `process.env` больше нигде не появился.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { gcError } from './errors.js';

const read = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

/**
 * Корень профилей. Переопределяется `GCONNECT_HOME` — этим живут тесты.
 *
 * Под тест-раннером переопределение ОБЯЗАТЕЛЬНО, и это не стиль, а защита.
 * 2026-09-02: мутационный прогон мутировал этот модуль, изоляция через `GCONNECT_HOME`
 * отвалилась, и тесты записали свои фикстуры в РЕАЛЬНЫЙ `~/.gconnect` — снесли токен и
 * файл OAuth-клиента владельца. Дыра была не в мутанте: сьют В ПРИНЦИПЕ мог писать в
 * рабочий профиль, потому что отсутствие переменной означало «пиши в домашний каталог».
 * Теперь означает отказ.
 */
export function profilesHome(): string {
  const explicit = read('GCONNECT_HOME');
  if (explicit !== undefined) return explicit;
  if (read('VITEST') !== undefined || read('GCONNECT_FORBID_REAL_HOME') !== undefined) {
    throw gcError('bad_request', {
      detail:
        'GCONNECT_HOME не задан под тест-раннером. Тесты не пишут в реальный ~/.gconnect: ' +
        'задай временный каталог в beforeEach (см. tests/profiles.test.ts).',
      cause: 'test_home_not_isolated',
    });
  }
  return join(homedir(), '.gconnect');
}

/** Активный профиль (аккаунт Google). */
export function defaultAccount(): string {
  return read('GCONNECT_ACCOUNT') ?? 'default';
}
