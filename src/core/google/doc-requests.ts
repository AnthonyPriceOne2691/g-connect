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
      fields: request.exact === true ? ALL_STYLE_FIELDS : styleFields(request.style),
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
  insertTable: (request: Extract<DocRequest, { kind: 'insertTable' }>) => ({
    insertTable: {
      location: { index: request.at, tabId: request.tabId },
      rows: request.rows,
      columns: request.columns,
    },
  }),
  // Таблица и строка адресуются startIndex'ом таблицы — так велит Docs API
  // (tableStartLocation); columnIndex у вставки строки не важен, ставим 0.
  insertTableRow: (request: Extract<DocRequest, { kind: 'insertTableRow' }>) => ({
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: request.tableStart, tabId: request.tabId },
        rowIndex: request.rowIndex,
        columnIndex: 0,
      },
      insertBelow: request.below,
    },
  }),
  insertTableColumn: (request: Extract<DocRequest, { kind: 'insertTableColumn' }>) => ({
    insertTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: request.tableStart, tabId: request.tabId },
        rowIndex: 0,
        columnIndex: request.columnIndex,
      },
      insertRight: request.right,
    },
  }),
  deleteTableRow: (request: Extract<DocRequest, { kind: 'deleteTableRow' }>) => ({
    deleteTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: request.tableStart, tabId: request.tabId },
        rowIndex: request.rowIndex,
        columnIndex: 0,
      },
    },
  }),
  deleteTableColumn: (request: Extract<DocRequest, { kind: 'deleteTableColumn' }>) => ({
    deleteTableColumn: {
      tableCellLocation: {
        tableStartLocation: { index: request.tableStart, tabId: request.tabId },
        rowIndex: 0,
        columnIndex: request.columnIndex,
      },
    },
  }),
  insertPageBreak: (request: Extract<DocRequest, { kind: 'insertPageBreak' }>) => ({
    insertPageBreak: { location: { index: request.at, tabId: request.tabId } },
  }),
  insertInlineImage: (request: Extract<DocRequest, { kind: 'insertInlineImage' }>) => ({
    insertInlineImage: { location: { index: request.at, tabId: request.tabId }, uri: request.uri },
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
  if (style.color !== undefined) out.foregroundColor = { color: { rgbColor: rgbOf(style.color) } };
  if (style.background !== undefined) out.backgroundColor = backgroundOf(style.background);
  return out;
}

/** `#rrggbb` → доли, как их ждёт Google (обратная сторона `rgbToHex` шва). */
function rgbOf(hex: string): docs_v1.Schema$RgbColor {
  const part = (at: number): number => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { red: part(1), green: part(3), blue: part(5) };
}

/**
 * Фон текста — выделение маркером (27.11). `'none'` — `OptionalColor` БЕЗ `color`, по
 * документации Docs API (`OptionalColor.color`): «If set, this will be used as an opaque color.
 * If unset, this represents a transparent color.» Прозрачный фон и есть снятое выделение — и
 * поверх фона из стиля абзаца, тогда как поле в маске без значения вернуло бы фон родителя.
 */
const backgroundOf = (background: string): docs_v1.Schema$OptionalColor =>
  background === 'none' ? {} : { color: { rgbColor: rgbOf(background) } };

const STYLE_FIELD_NAMES: Readonly<Record<string, string>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strikethrough',
  link: 'link',
  fontSize: 'fontSize',
  color: 'foregroundColor',
  background: 'backgroundColor',
};

/**
 * Маска точного стиля: каждое управляемое поле — отсутствующее в стиле сбросится. Документация
 * `UpdateTextStyleRequest.fields`: «To reset a property to its default value, include its field
 * name in the field mask but leave the field itself unset.» — так откат снимает и выделение,
 * которого до правки не было.
 */
const ALL_STYLE_FIELDS = Object.values(STYLE_FIELD_NAMES).join(',');

function styleFields(style: DocTextStyle): string {
  return Object.keys(style)
    .map((key) => STYLE_FIELD_NAMES[key])
    .filter((v): v is string => v !== undefined)
    .join(',');
}

export function toDocRequest(request: DocRequest): docs_v1.Schema$Request {
  return (TRANSLATORS[request.kind] as (r: DocRequest) => docs_v1.Schema$Request)(request);
}
