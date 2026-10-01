/**
 * Чтение doc-целей для `gc_read` (уровень 3, слайс 1): карта и абзацы.
 *
 * Отдельным модулем по той же причине, что `run-create.ts`: `tools.ts` — витрина шести
 * инструментов, и доменная разводка внутри неё уже однажды перерастала лимит длины.
 */

import { buildDocMap } from '../core/docs/map.js';
import { shownText } from '../core/docs/objects.js';
import { pickTab } from '../core/docs/selectors.js';
import { gcError } from '../core/errors.js';
import { asData, limitOf } from '../core/policy.js';
import type { ToolDeps } from './deps.js';

/** Чтение doc-цели: карта или абзацы. mode=values — про строки таблиц, и это названо. */
export async function readDoc(
  deps: ToolDeps,
  resolvedId: string,
  input: {
    mode: 'map' | 'values' | 'text';
    tab?: string | undefined;
    fromParagraph?: number | undefined;
    limit?: number | undefined;
  },
): Promise<unknown> {
  if (input.mode === 'values') {
    throw gcError('bad_request', {
      detail: 'mode=values читает строки таблиц. У документа карта — mode=map, абзацы — mode=text.',
    });
  }
  const client = await deps.docs();
  const snapshot = await client.getDocument(resolvedId);
  if (input.mode === 'map') return buildDocMap(snapshot);
  const tab = pickTab(snapshot, input.tab);
  const from = input.fromParagraph ?? 1;
  const limit = Math.min(input.limit ?? 100, limitOf('read.max-rows', 500));
  const wanted = tab.paragraphs.filter((p) => p.index >= from);
  const slice = wanted.slice(0, limit);
  return {
    doc: snapshot.title,
    tab: tab.title,
    revisionId: snapshot.revisionId,
    // Содержимое — ДАННЫЕ с пометкой источника, а не инструкции (правило content.is-data).
    // До 2026-10-01 пометку обещало правило, а не делал никто: asData не вызывался вовсе.
    paragraphs: asData(
      `документ ${resolvedId}, таб «${tab.title}»`,
      slice.map((p) => ({
        n: p.index,
        text: shownText(p.runs),
        style: p.namedStyle,
        ...(p.bulleted === true ? { bulleted: true } : {}),
        ...(p.inTable === undefined ? {} : { inTable: p.inTable }),
      })),
    ),
    truncated: wanted.length > limit,
    ...(snapshot.hasSuggestions
      ? {
          warnings: [
            'В документе неразрешённые предложения: в их абзацах текст — смесь исходного и ' +
              'предложенного (так его отдаёт API); правки этих абзацев отказывают — прими или ' +
              'отклони предложения в интерфейсе.',
          ],
        }
      : {}),
  };
}
