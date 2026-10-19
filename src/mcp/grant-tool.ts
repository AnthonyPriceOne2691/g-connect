/**
 * `gc_grant` — седьмой инструмент (D-23): разрешение проекта касанием пальца.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: шесть инструментов работают с
 * документами, а этот — с правом на них. Выдаёт разрешение палец владельца: инструмент
 * только просит macOS показать Touch ID, а подпись ставит ключ Secure Enclave. Поэтому
 * `open` — по просьбе человека («открой G connect»), а не способ обойти `needs_grant`:
 * окно Touch ID, вызванное без просьбы, учит касаться не глядя (канон замерил четыре
 * касания подряд без знания о подписываемом).
 */

import { z } from 'zod';

import { gcError } from '../core/errors.js';
import { issueGrant, revokeGrant, type GrantState } from '../core/grant/grants.js';
import { grantPhrase, profileLabel } from '../core/profile-names.js';
import type { ToolDeps, ToolDefinition } from './deps.js';

/** Что агент видит о праве проекта — в `gc_targets` и в ответах `gc_grant`. */
export interface GrantSummary {
  readonly project: string | null;
  readonly state: 'granted' | GrantRefusalState;
  readonly expires?: string;
  readonly detail: string;
}

type GrantRefusalState = Exclude<GrantState, { state: 'granted' }>['reason'];

/** Фраза — своего профиля (D-25): «открой G connect» у личного, «… (work)» у другого. */
const openAdvice = (account: string): string =>
  `записи вне реестра нет: попроси владельца сказать «${grantPhrase(account)}» и приложить палец`;

export async function grantSummary(deps: ToolDeps): Promise<GrantSummary> {
  if (deps.project === undefined || deps.grant === undefined) {
    return {
      project: null,
      state: 'no_project',
      detail: 'клиент не назвал проект сессии — право записи даёт только реестр',
    };
  }
  const state = await deps.grant();
  if (state.state === 'granted') {
    return {
      project: deps.project,
      state: 'granted',
      expires: state.grant.expires,
      detail: `${profileLabel(deps.account)} открыт для этого проекта до ${state.grant.expires}: свои таблицы и документы пишутся через превью, журнал и откат`,
    };
  }
  return {
    project: deps.project,
    state: state.reason,
    detail: `${state.detail}; ${openAdvice(deps.account)}`,
  };
}

const grantInput = {
  action: z
    .enum(['open', 'status', 'revoke'])
    .default('status')
    .describe(
      'open — выдать касанием (ТОЛЬКО когда владелец сам сказал «открой G connect»; у ' +
        'другого профиля — с его именем: «открой G connect (work)»); ' +
        'status — показать; revoke — отозвать',
    ),
};

export const gcGrant: ToolDefinition = {
  name: 'gc_grant',
  title: 'Разрешение проекта касанием пальца',
  description:
    'Разрешение ЭТОГО проекта писать в свои таблицы и документы вне реестра — до 23:59. ' +
    'open — только по просьбе владельца («открой G connect», у другого профиля — с его ' +
    'именем): macOS покажет Touch ID, палец ' +
    'подписывает разрешение, ожидание до 60 с. Не вызывай open сам, чтобы обойти needs_grant. ' +
    'status — что сейчас; revoke — отозвать досрочно.',
  input: grantInput,
  async handle(args, deps) {
    const { action } = z.object(grantInput).parse(args);
    const project = deps.project;
    if (project === undefined || deps.grantKeys === undefined) {
      throw gcError('needs_grant', {
        detail:
          'Клиент не назвал проект сессии (нет CLAUDE_PROJECT_DIR): разрешение выдать некому. ' +
          'Запись — только в цели реестра.',
        cause: 'no_project',
      });
    }
    if (action === 'revoke') {
      const revoked = await revokeGrant(project, deps.account);
      return { status: revoked ? 'revoked' : 'nothing_to_revoke', project };
    }
    const now = await grantSummary(deps);
    if (action === 'status' || now.state === 'granted') {
      return { status: action === 'status' ? 'status' : 'already_granted', ...now };
    }
    const grant = await issueGrant(deps.grantKeys, project, deps.account);
    return {
      status: 'granted',
      project,
      expires: grant.expires,
      hint:
        `Скажи владельцу: ${profileLabel(deps.account)} открыт для проекта ${project} до ${grant.expires}. ` +
        'Неразрушающее — с первой фразы через превью и журнал, разрушающее — его фразой.',
    };
  },
};
