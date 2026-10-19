/**
 * Как профиль называется людям и клиентам (D-25): сервер на профиль, профиль — в имени.
 *
 * Одно место для слов, которые расходиться не должны (урок L30): имя MCP-сервера (из него
 * клиент строит имена инструментов `mcp__<сервер>__*`), строка перед окном Touch ID и фраза
 * разрешения проекта. Личный профиль `default` звучит как до D-25 — слово в слово: правило
 * `mcp__g-connect__*`, памятка и привычная фраза владельца остаются верными.
 */

import { DEFAULT_ACCOUNT } from './profiles.js';

/** `g-connect` у личного, `g-connect-<профиль>` у остальных. */
export function serverName(account: string): string {
  return account === DEFAULT_ACCOUNT ? 'g-connect' : `g-connect-${account}`;
}

/** «G connect» или «G connect (work)» — так профиль слышит человек в строке и фразе. */
export function profileLabel(account: string): string {
  return account === DEFAULT_ACCOUNT ? 'G connect' : `G connect (${account})`;
}

/**
 * Строка человеку перед окном Touch ID. По ней окно G connect отличают от чужого, а с двумя
 * профилями — ещё и рабочее от личного: в самом окне текст `age-plugin-se`, не наш.
 */
export function unlockLine(account: string): string {
  return `${profileLabel(account)} попросит палец, чтобы открыть Google этой сессии на час`;
}

/** Фраза владельца, по которой агент открывает разрешение проекта (`gc_grant open`). */
export function grantPhrase(account: string): string {
  return `открой ${profileLabel(account)}`;
}

/** Команда CLI этого профиля: у не-личного — с `GCONNECT_ACCOUNT`, иначе возьмётся личный. */
export function gcCommand(account: string, command: string): string {
  const prefix = account === DEFAULT_ACCOUNT ? '' : `GCONNECT_ACCOUNT=${account} `;
  return `${prefix}npm run gc -- ${command}`;
}
