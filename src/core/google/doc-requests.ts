/**
 * Доменный запрос документа → запрос `documents.batchUpdate` (уровень 3).
 *
 * Зеркало `requests.ts` таблиц и тот же класс риска: промах перевода правит НЕ ТОТ
 * диапазон живого документа и выглядит успехом. Числа в тестах — из документации
 * Docs API (урок L3): `insertText.location.index` — UTF-16 позиция, `deleteContentRange`
 * — полуинтервал `[startIndex, endIndex)`, `tabId` живёт внутри location/range.
 */

import type { docs_v1 } from 'googleapis';

import type { DocRequest, DocTextStyle } from '../docs/types.js';

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
  // `fields` перечисляет РОВНО задаваемые поля: маска '*' обнулила бы остальные — тот же
  // класс, что `fields:'title'` у листов (уровень 2, G1).
  updateTextStyle: (request: Extract<DocRequest, { kind: 'updateTextStyle' }>) => ({
    updateTextStyle: {
      range: {
        startIndex: request.startIndex,
        endIndex: request.endIndex,
        tabId: request.tabId,
      },
      textStyle: toGoogleTextStyle(request.style),
      fields: styleFields(request.style),
    },
  }),
  updateParagraphStyle: (request: Extract<DocRequest, { kind: 'updateParagraphStyle' }>) => ({
    updateParagraphStyle: {
      range: {
        startIndex: request.startIndex,
        endIndex: request.endIndex,
        tabId: request.tabId,
      },
      paragraphStyle: { namedStyleType: request.namedStyle },
      fields: 'namedStyleType',
    },
  }),
  setBullets: (request: Extract<DocRequest, { kind: 'setBullets' }>) =>
    request.bulleted
      ? {
          createParagraphBullets: {
            range: {
              startIndex: request.startIndex,
              endIndex: request.endIndex,
              tabId: request.tabId,
            },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        }
      : {
          deleteParagraphBullets: {
            range: {
              startIndex: request.startIndex,
              endIndex: request.endIndex,
              tabId: request.tabId,
            },
          },
        },
};

/** Доменный стиль → форма библиотеки. Заполняются только заданные поля. */
function toGoogleTextStyle(style: DocTextStyle): docs_v1.Schema$TextStyle {
  const out: docs_v1.Schema$TextStyle = {};
  if (style.bold !== undefined) out.bold = style.bold;
  if (style.italic !== undefined) out.italic = style.italic;
  if (style.underline !== undefined) out.underline = style.underline;
  if (style.strikethrough !== undefined) out.strikethrough = style.strikethrough;
  if (style.link !== undefined) out.link = { url: style.link };
  if (style.fontSize !== undefined) out.fontSize = { magnitude: style.fontSize, unit: 'PT' };
  if (style.color !== undefined) {
    const hex = style.color.replace('#', '');
    out.foregroundColor = {
      color: {
        rgbColor: {
          red: parseInt(hex.slice(0, 2), 16) / 255,
          green: parseInt(hex.slice(2, 4), 16) / 255,
          blue: parseInt(hex.slice(4, 6), 16) / 255,
        },
      },
    };
  }
  return out;
}

const STYLE_FIELD_NAMES: Readonly<Record<string, string>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strikethrough',
  link: 'link',
  fontSize: 'fontSize',
  color: 'foregroundColor',
};

function styleFields(style: DocTextStyle): string {
  return Object.keys(style)
    .map((key) => STYLE_FIELD_NAMES[key])
    .filter((v): v is string => v !== undefined)
    .join(',');
}

export function toDocRequest(request: DocRequest): docs_v1.Schema$Request {
  return (TRANSLATORS[request.kind] as (r: DocRequest) => docs_v1.Schema$Request)(request);
}
