/**
 * `gc_targets` — что этому серверу можно читать и писать, и чей он (D-25).
 *
 * С двумя серверами рядом агент выбирает, через какой идти, по имени инструмента — и здесь
 * видит, какой профиль у этого сервера, а о других — только имена их серверов: их доступ,
 * разрешения и откаты живут в чужих процессах, и показать их отсюда значило бы соврать.
 */

import { gcCommand, serverName } from '../core/profile-names.js';
import { listProfiles, profileStatus, type ProfileStatus } from '../core/profiles.js';
import type { ToolDefinition } from './deps.js';
import { envelopeSummary } from './envelope-view.js';
import { grantSummary } from './grant-tool.js';
import { googleSummary } from './unlock-tool.js';

/** Что делать владельцу, если профиль не готов: без этого агент гадал бы сам. */
function nextStep(status: ProfileStatus): string | undefined {
  const { account } = status;
  switch (status.state) {
    case 'connected':
      return undefined;
    case 'needs_reauth':
      return status.hasToken
        ? `вход истёк — владелец запускает ${gcCommand(account, 'login')}`
        : `нет входа — владелец запускает ${gcCommand(account, 'seal')}`;
    case 'unsealed':
      return `токен лежит открытым файлом — владелец запускает ${gcCommand(account, 'seal')}`;
    // Путей к профилю агенту не даём (оракул B2): каталог с токенами ему читать незачем.
    case 'no_credentials':
      return 'нет ключа клиента — владелец кладёт credentials.json в каталог профиля';
    case 'no_profile':
      return `профиля ${account} нет — владелец создаёт его с ключом клиента`;
  }
}

/** Первая строка инструкций сервера: клиент показывает агенту только их начало. */
export function profileIntro(account: string): string {
  return (
    `**Этот сервер — профиль «${account}» (${serverName(account)}).** Всё, что он читает и ` +
    'пишет, — от аккаунта Google этого профиля; другие профили — свои серверы ' +
    '(`g-connect-<профиль>`) со своим касанием, разрешением и откатом. Чей файл — не знаешь, ' +
    'спроси человека.'
  );
}

export const gcTargets: ToolDefinition = {
  name: 'gc_targets',
  title: 'Доступные цели',
  description:
    'Что агенту разрешено читать и во что писать: цели из реестра с алиасами и правами, ' +
    'профиль этого сервера и его доступ к Google; другие профили — по именам их серверов. ' +
    'Секретов не отдаёт.',
  input: {},
  async handle(_args, deps) {
    const registry = await deps.registry();
    const own = await profileStatus(deps.account);
    const others = (await listProfiles()).filter((account) => account !== deps.account);
    const next = nextStep(own);
    return {
      profile: {
        account: own.account,
        server: serverName(own.account),
        about: `этот сервер — профиль ${own.account}: читает и пишет от аккаунта этого профиля`,
        state: own.state,
        scopes: own.scopes.length,
        // `expiresAt` (срок access-токена, час) агенту НЕ отдаём: в живом прогоне B13
        // он был прочитан как «срок входа истёк 1 сентября», и агент посоветовал
        // перелогиниться при refreshAgeDays=0 и пустых warnings. Актуальное про доступ
        // живёт в warnings, срок access-токена человеку показывает `gc status`.
        ...(own.warnings.length > 0 ? { warnings: own.warnings } : {}),
        ...(next === undefined ? {} : { next }),
      },
      otherProfiles: others.map((account) => `профиль ${account} — сервер ${serverName(account)}`),
      targets: registry.targets.map((t) => ({
        alias: t.alias,
        id: t.id,
        type: t.type,
        allow: t.allow ?? 'read',
        sheet: t.sheet ?? null,
        headerRow: t.headerRow ?? null,
        key: t.key ?? null,
        // Конверт цели (D-18) виден там же, где права: иначе агент узнавал бы о нём
        // только по факту записи, а человек — никогда. Битый конверт называется здесь
        // же — это ответ на «почему по этой цели просят код».
        auto: envelopeSummary(t.auto, t.alias, t.type),
      })),
      // Право проекта (D-23) — рядом с правами целей: без него агент узнавал бы о нём по
      // отказу записи, а человек не видел бы, до какого часа G connect открыт.
      grant: await grantSummary(deps),
      // Доступ к Google (D-24) — рядом с правом: «закрыт» здесь, а не ошибкой первого запроса.
      google: googleSummary(deps),
      note:
        'Google открывается касанием на час (gc_unlock, после строки человеку). ' +
        'Право записи даёт реестр (правило write.allowlist) или разрешение проекта ' +
        '(write.grant): владелец открывает G connect касанием, gc_grant. Без него ' +
        'произвольная ссылка — только для чтения. Цель с конвертом (auto) пишется с первой ' +
        'фразы, без кода плана; всё, что вне конверта, показывает план и требует код от человека.',
    };
  },
};
