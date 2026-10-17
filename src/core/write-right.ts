/**
 * Кто может писать (D-23): реестр целей ИЛИ действующее разрешение проекта.
 *
 * Одна функция и два источника одного ответа, а не два пути (урок L30): разошедшиеся
 * проверки дали бы цель, которую превью считает записываемой, а запись — нет. Порядок
 * несущий и закреплён тестом: реестр с `allow: write` — сразу; цель реестра с
 * `allow: read` — отказ ДАЖЕ под разрешением, потому что ограничение в реестре — прямое
 * решение владельца о конкретном файле, а разрешение говорит обо всех файлах сразу;
 * остальное — по разрешению проекта.
 */

import { gcError } from './errors.js';
import type { GrantDocument } from './grant/document.js';
import type { GrantState } from './grant/grants.js';
import { denyByRule } from './policy.js';
import type { ResolvedTarget } from './targets.js';

export type WriteRight =
  { readonly via: 'registry' } | { readonly via: 'grant'; readonly grant: GrantDocument };

/**
 * Разрешение спрашивается лениво — только когда реестр не решил сам: запись в цель реестра
 * не должна ходить к агенту Secretive, а порядок при этом остаётся в одном месте.
 */
export async function authorizeWrite(
  target: ResolvedTarget,
  grantOf: () => Promise<GrantState>,
): Promise<WriteRight> {
  if (target.allow === 'write') return { via: 'registry' };
  if (target.entry !== null) {
    denyByRule(
      'write.allowlist',
      `Цель «${target.alias ?? target.id}» описана в реестре как read-only. Разрешение проекта ` +
        'её не открывает: ограничение в реестре — решение владельца о конкретном файле.',
    );
  }
  const grant = await grantOf();
  if (grant.state === 'granted') return { via: 'grant', grant: grant.grant };
  throw gcError('needs_grant', {
    detail:
      `Цель ${target.id} не в реестре: писать в неё можно по разрешению проекта, а его нет — ` +
      `${grant.detail}. Попроси владельца сказать «открой G connect» и приложить палец; ` +
      'разрешение не подписывается агентом и не выпрашивается в обход.',
    cause: grant.reason,
  });
}
