/**
 * Разрушающая запись путём агента (поправка D-20, 2026-10-01): превью того же запроса →
 * фраза человека в `confirm` и код плана ЭТОГО превью в `planId`. Фраза без кода больше
 * не пишет — её повтор после записи сделал бы правку второй раз.
 */

import type { DocApplyOutcome, DocRunOptions } from '../../src/core/docs/write-support.js';
import type { DocSnapshot, DocsClient } from '../../src/core/docs/types.js';

type DocRunner<R> = (
  client: DocsClient,
  snapshot: DocSnapshot,
  request: R,
  options: DocRunOptions,
) => Promise<DocApplyOutcome>;

export async function named<R>(
  run: DocRunner<R>,
  client: DocsClient,
  request: R,
  phrase: string,
  options: (over?: Partial<DocRunOptions>) => DocRunOptions,
): Promise<DocApplyOutcome> {
  const preview = await run(client, await client.getDocument('d'), request, options());
  return run(
    client,
    await client.getDocument('d'),
    request,
    options({
      dryRun: false,
      confirm: phrase,
      ...(preview.planId === null ? {} : { planId: preview.planId }),
    }),
  );
}
