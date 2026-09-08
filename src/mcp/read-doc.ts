/**
 * Чтение doc-целей для `gc_read` (уровень 3, слайс 1): карта и абзацы.
 *
 * Отдельным модулем по той же причине, что `run-create.ts`: `tools.ts` — витрина шести
 * инструментов, и доменная разводка внутри неё уже однажды перерастала лимит длины.
 */

import { buildDocMap } from '../core/docs/map.js';
import type { DocSnapshot, DocTab } from '../core/docs/types.js';
import { gcError } from '../core/errors.js';
import { limitOf } from '../core/policy.js';
import type { ToolDeps } from './deps.js';

/**
 * Таб по заголовку. Документ с одним табом отдаёт его без вопросов; с несколькими —
 * требует имя: «возьму первый» прочитал бы человеку не тот текст (та же неоднозначность,
 * что у селекторов §4 — вопрос, а не догадка).
 */
export function pickTab(snapshot: DocSnapshot, wanted: string | undefined): DocTab {
  const titles = snapshot.tabs.map((t) => t.title).join(', ');
  if (wanted !== undefined) {
    const matches = snapshot.tabs.filter((t) => t.title === wanted);
    if (matches.length === 1) return matches[0]!;
    throw gcError(matches.length === 0 ? 'bad_request' : 'ambiguous_target', {
      detail:
        matches.length === 0
          ? `Таба «${wanted}» в документе нет. Есть: ${titles}.`
          : `Заголовок «${wanted}» носят несколько табов (${matches.length}); адресуй по mode=map.`,
    });
  }
  const first = snapshot.tabs[0];
  if (snapshot.tabs.length === 1 && first !== undefined) return first;
  throw gcError('bad_request', {
    detail: `В документе ${snapshot.tabs.length} табов — назови tab. Есть: ${titles}.`,
  });
}

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
    paragraphs: slice.map((p) => ({
      n: p.index,
      text: p.text,
      style: p.namedStyle,
      ...(p.bulleted === true ? { bulleted: true } : {}),
      ...(p.inTable === undefined ? {} : { inTable: p.inTable }),
    })),
    truncated: wanted.length > limit,
    ...(snapshot.hasSuggestions
      ? {
          warnings: [
            'В документе есть неразрешённые предложения: текст показан без них, принять их можно только в интерфейсе.',
          ],
        }
      : {}),
  };
}
