/**
 * Доменный запрос документа → запрос `documents.batchUpdate` (уровень 3).
 *
 * Зеркало `requests.ts` таблиц и тот же класс риска: промах перевода правит НЕ ТОТ
 * диапазон живого документа и выглядит успехом. Числа в тестах — из документации
 * Docs API (урок L3): `insertText.location.index` — UTF-16 позиция, `deleteContentRange`
 * — полуинтервал `[startIndex, endIndex)`, `tabId` живёт внутри location/range.
 */

import type { docs_v1 } from 'googleapis';

import type { DocRequest } from '../docs/types.js';

type Translator = (request: never) => docs_v1.Schema$Request;

const TRANSLATORS: Readonly<Record<DocRequest['kind'], Translator>> = {
  insertText: (request: Extract<DocRequest, { kind: 'insertText' }>) => ({
    insertText: {
      location: { index: request.at, tabId: request.tabId },
      text: request.text,
    },
  }),
  deleteRange: (request: Extract<DocRequest, { kind: 'deleteRange' }>) => ({
    deleteContentRange: {
      range: {
        startIndex: request.startIndex,
        endIndex: request.endIndex,
        tabId: request.tabId,
      },
    },
  }),
};

export function toDocRequest(request: DocRequest): docs_v1.Schema$Request {
  return (TRANSLATORS[request.kind] as (r: DocRequest) => docs_v1.Schema$Request)(request);
}
