/**
 * Проба правила фразы (подсветка, 27.11) — отдельным модулем, как `header-probes.ts`: реестр
 * проб в policy.test.ts у предела длины. Структурный оракул «у КАЖДОГО правила есть проба — и
 * наоборот» судит реестр целиком.
 */

import { expect } from 'vitest';

import { runDocStyle } from '../../src/core/docs/style-op.js';
import { FakeDocsClient, forecastDoc } from './doc.js';

export const highlightProbes: Record<string, () => Promise<void>> = {
  // Фраза — как есть и одна: «Palmeiras» есть в документе, но не в абзаце `where`, а «о» в нём
  // не одна. Оба раза отказ, и запросов записи ноль даже под конвертом.
  'docs.fragment-exact': async () => {
    const refused = [
      ['Palmeiras', 'fragment_not_found'],
      ['о', 'fragment_ambiguous'],
    ] as const;
    for (const [fragment, cause] of refused) {
      const client = new FakeDocsClient(forecastDoc());
      const request = {
        op: 'updateTextStyle',
        tab: 'Прогноз',
        where: { textStartsWith: 'Ставим на победу' },
        fragment,
        style: { background: '#fff2cc' },
      } as const;
      await expect(
        runDocStyle(client, await client.getDocument(), request, {
          dryRun: false,
          authorize: () => ({ authorized: true }),
        }),
      ).rejects.toMatchObject({ payload: { code: 'bad_request', cause } });
      expect(client.applied).toHaveLength(0);
    }
  },
};
