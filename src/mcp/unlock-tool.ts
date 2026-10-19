/**
 * `gc_unlock` — восьмой инструмент (D-24): открыть Google этой сессии касанием, на час.
 *
 * Только он вызывает окно Touch ID для токена (правило `google.unlock-only-tool`): остальные
 * инструменты при закрытом Google отвечают `google_locked`. Окно ДО вызова объявляется
 * человеку строкой — так «окно не ждали — не касайся» становится выполнимым правилом: окно
 * G connect всегда объявлено в чате, чужое — нет. В самом окне текст `age-plugin-se`, не наш.
 */

import { gcError } from '../core/errors.js';
import { unlockLine } from '../core/profile-names.js';
import { DEFAULT_ACCOUNT } from '../core/profiles.js';
import type { ToolDeps, ToolDefinition } from './deps.js';

/**
 * Строка человеку перед окном личного профиля — слово в слово, чтобы окно G connect
 * узнавалось по ней. У другого профиля строка своя, с его именем (`unlockLine`, D-25).
 */
export const UNLOCK_LINE = unlockLine(DEFAULT_ACCOUNT);

/** Что агент видит о доступе к Google — в `gc_targets` и в ответе `gc_unlock`. */
export function googleSummary(deps: ToolDeps): { readonly state: string; readonly detail: string } {
  const access = deps.google?.status() ?? { state: 'locked' as const };
  if (access.state === 'unlocked') {
    return {
      state: 'unlocked',
      detail: `Google открыт для этой сессии до ${access.until}; после — снова касание (gc_unlock)`,
    };
  }
  return {
    state: 'locked',
    detail:
      'Google в этой сессии закрыт: первое обращение ответит google_locked — тогда скажи ' +
      `человеку «${unlockLine(deps.account)}» и вызови gc_unlock`,
  };
}

export const gcUnlock: ToolDefinition = {
  name: 'gc_unlock',
  title: 'Открыть Google касанием на час',
  description:
    'Открыть Google этой сессии: токен Google зашифрован ключом Secure Enclave, macOS покажет ' +
    'окно Touch ID (палец или пароль Mac), ожидание до 60 с; открыто — на час. Зови после ' +
    'ответа google_locked и ТОЛЬКО сразу после строки человеку из этого ответа: у личного ' +
    `профиля — «${UNLOCK_LINE}», у другого — с его именем («G connect (work) попросит…»). ` +
    'Окно без строки учит касаться не глядя.',
  input: {},
  async handle(_args, deps) {
    if (deps.google === undefined) {
      throw gcError('internal', {
        detail: 'Сервер собран без хранилища токена: открыть Google нечем.',
        cause: 'no_vault',
      });
    }
    const before = deps.google.status();
    if (before.state === 'unlocked') {
      return { status: 'already_unlocked', until: before.until, ...googleSummary(deps) };
    }
    const opened = await deps.google.unlock();
    return {
      status: 'unlocked',
      until: opened.until,
      hint:
        `Скажи человеку: Google открыт для этой сессии до ${opened.until}. Дальше — снова ` +
        'касание; неожиданное окно Touch ID без такой строки — не касаться.',
    };
  },
};
