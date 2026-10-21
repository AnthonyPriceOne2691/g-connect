/**
 * Домен → запрос библиотеки: единственное место такого перевода (§2, гейт
 * `core-no-library`).
 *
 * Отдельным модулем от `sheets.ts` по гейту длины — и по делу: там ответ Google
 * превращается в доменный снимок, здесь доменная правка превращается в запрос. Это разные
 * направления, и ошибка в них выглядит по-разному: наверху «internal вместо данных»,
 * внизу «удалили не ту строку».
 */

import type { sheets_v4 } from 'googleapis';

import type {
  CellFormat,
  DomainRange,
  FormatRequest,
  PasteKind,
  SheetRequest,
} from '../sheets/types.js';

/**
 * Доменный запрос → запрос библиотеки. Единственное место такого перевода (§2, гейт
 * `core-no-library`): за этой таблицей типы `googleapis` в ядро не проходят.
 *
 * Таблица, а не цепочка ветвей: гейт сложности отклонил десять `if` подряд, и он прав —
 * это соответствие «форма правки → форма запроса», а не логика. Отсутствие ключа тут
 * невозможно по типу: TypeScript требует запись на каждую форму.
 */
type Mapper<K extends SheetRequest['kind']> = (
  request: Extract<SheetRequest, { kind: K }>,
) => sheets_v4.Schema$Request;

const MAPPERS: { [K in SheetRequest['kind']]: Mapper<K> } = {
  format: (request) => toRepeatCell(request),
  // `inheritFromBefore: false` осознанно: иначе вставленная строка приезжает с
  // оформлением соседа, которого человек в плане не видел.
  insertDimension: (request) => ({
    insertDimension: { range: toDimensionRange(request), inheritFromBefore: false },
  }),
  deleteDimension: (request) => ({ deleteDimension: { range: toDimensionRange(request) } }),
  addSheet: (request) => ({ addSheet: { properties: sheetProperties(request) } }),
  deleteSheet: (request) => ({ deleteSheet: { sheetId: request.sheetId } }),
  // `fields` обязателен: без него Google обнулит остальные свойства листа.
  renameSheet: (request) => ({
    updateSheetProperties: {
      properties: { sheetId: request.sheetId, title: request.title },
      fields: 'title',
    },
  }),
  // У `copyPaste` получатель — ДИАПАЗОН: если он меньше источника, Google всё равно
  // скопирует источник целиком, вылезая за границы. Мы всегда задаём равный размер.
  copyPaste: (request) => ({
    copyPaste: {
      source: toGridRange(request.sheetId, request.source),
      destination: toGridRange(request.sheetId, request.destination),
      pasteType: PASTE_TYPES[request.paste],
    },
  }),
  // А у `cutPaste` получатель — ТОЧКА (`GridCoordinate`), размер берётся от источника.
  // Разница неочевидна и стоила бы отладки на живой таблице.
  cutPaste: (request) => ({
    cutPaste: {
      source: toGridRange(request.sheetId, request.source),
      destination: {
        sheetId: request.sheetId,
        rowIndex: request.destination.row - 1,
        columnIndex: request.destination.column,
      },
      pasteType: PASTE_TYPES[request.paste],
    },
  }),
  // Источник задаём явно (`sourceAndDestination`), а не через `range`: во втором случае
  // Google сам решает эвристикой, что считать образцом, и человек этим не управляет.
  autoFill: (request) => ({
    autoFill: {
      useAlternateSeries: false,
      sourceAndDestination: {
        source: toGridRange(request.sheetId, request.source),
        dimension: 'ROWS',
        fillLength: request.destination.rowCount,
      },
    },
  }),
  duplicateSheet: (request) => ({
    duplicateSheet: { sourceSheetId: request.sheetId, newSheetName: request.title },
  }),
  moveDimension: (request) => ({
    moveDimension: {
      source: toDimensionRange(request),
      destinationIndex: request.destinationIndex,
    },
  }),
  // `startColumnIndex: 0` не случайность: в документации не сказано, относительно чего
  // считается `dimensionIndex` у `sortSpecs` — листа или диапазона. При диапазоне от
  // колонки A оба чтения совпадают, и неоднозначность перестаёт быть нашей проблемой.
  sortRange: (request) => ({
    sortRange: {
      range: toGridRange(request.sheetId, request.range),
      sortSpecs: [
        {
          dimensionIndex: request.column,
          sortOrder: request.descending === true ? 'DESCENDING' : 'ASCENDING',
        },
      ],
    },
  }),
};

export function toRequest(request: SheetRequest): sheets_v4.Schema$Request {
  const mapper = MAPPERS[request.kind] as (r: SheetRequest) => sheets_v4.Schema$Request;
  return mapper(request);
}

/** Свойства нового листа: ими откат возвращает удалённый «как был» (D-19). */
function sheetProperties(request: {
  readonly title: string;
  readonly properties?: {
    readonly frozenRows?: number;
    readonly frozenColumns?: number;
    readonly tabColor?: string;
    readonly hidden?: boolean;
  };
}): sheets_v4.Schema$SheetProperties {
  const properties = request.properties ?? {};
  const grid = {
    ...(properties.frozenRows === undefined ? {} : { frozenRowCount: properties.frozenRows }),
    ...(properties.frozenColumns === undefined
      ? {}
      : { frozenColumnCount: properties.frozenColumns }),
  };
  return {
    title: request.title,
    ...(Object.keys(grid).length === 0 ? {} : { gridProperties: grid }),
    ...(properties.tabColor === undefined
      ? {}
      : { tabColorStyle: { rgbColor: fromHex(properties.tabColor) } }),
    ...(properties.hidden === undefined ? {} : { hidden: properties.hidden }),
  };
}

/** Что переносит вставка → перечисление Google. Таблицей: это соответствие, не логика. */
const PASTE_TYPES: Record<PasteKind, string> = {
  all: 'PASTE_NORMAL',
  values: 'PASTE_VALUES',
  format: 'PASTE_FORMAT',
  validation: 'PASTE_DATA_VALIDATION',
};

/** Доменный прямоугольник → `GridRange`: 1-based строка и полуинтервал Google. */
function toGridRange(sheetId: number, range: DomainRange): sheets_v4.Schema$GridRange {
  return {
    sheetId,
    startRowIndex: range.row - 1,
    endRowIndex: range.row - 1 + range.rowCount,
    startColumnIndex: range.column,
    endColumnIndex: range.column + range.columnCount,
  };
}

/**
 * Диапазон измерения. Google ждёт 0-based полуинтервал, домен говорит 1-based «перед
 * этим номером» — перевод здесь, чтобы ядро не считало индексы библиотеки.
 */
function toDimensionRange(request: {
  readonly sheetId: number;
  readonly dimension: 'rows' | 'columns';
  readonly at: number;
  readonly count: number;
}): sheets_v4.Schema$DimensionRange {
  return {
    sheetId: request.sheetId,
    dimension: request.dimension === 'rows' ? 'ROWS' : 'COLUMNS',
    startIndex: request.at - 1,
    endIndex: request.at - 1 + request.count,
  };
}

/**
 * Поле вида → пути в маске Google. Таблицей, как `MAPPERS`: это соответствие, а не логика, и
 * пропущенное поле TypeScript не пустит — без пути в маске правка ушла бы в никуда.
 *
 * У фона и цвета текста путей ДВА (Q16, Q18): Google хранит цвет в устаревшем поле
 * (`backgroundColor`, `foregroundColor`) и в стиле (`…ColorStyle`), и стиль, если задан, главнее —
 * документация Sheets API, `CellFormat` и `TextFormat`. Маска с одним устаревшим полем не
 * перекрыла бы заливку, поставленную шаблоном через стиль, а сброс её не снял бы.
 */
const FORMAT_MASKS: Readonly<Record<keyof CellFormat, readonly string[]>> = {
  bold: ['userEnteredFormat.textFormat.bold'],
  italic: ['userEnteredFormat.textFormat.italic'],
  underline: ['userEnteredFormat.textFormat.underline'],
  fontFamily: ['userEnteredFormat.textFormat.fontFamily'],
  fontSize: ['userEnteredFormat.textFormat.fontSize'],
  textColor: [
    'userEnteredFormat.textFormat.foregroundColor',
    'userEnteredFormat.textFormat.foregroundColorStyle',
  ],
  align: ['userEnteredFormat.horizontalAlignment'],
  background: ['userEnteredFormat.backgroundColor', 'userEnteredFormat.backgroundColorStyle'],
  numberFormat: ['userEnteredFormat.numberFormat'],
};

/**
 * Поля `textFormat` — у Google они вложены, у домена лежат рядом с остальными. Цвета текста здесь
 * нет: он уходит парой полей (`foreground`), а не одним.
 */
const TEXT_KEYS = ['bold', 'italic', 'underline', 'fontFamily', 'fontSize'] as const;

/**
 * Доменная правка вида → запрос библиотеки.
 *
 * Маска — из ЗАДАННЫХ полей, и `null` (сброс, слово отката, D-26) в ней тоже есть, а в теле
 * его нет: поле в маске без значения Google сбрасывает к виду листа. Иначе откат шрифта, которого
 * до правки не было, нечем было бы записать — нейтрального шрифта, как `bold: false`, нет. Сброс
 * фона и цвета текста (`"none"`, Q16, Q18) — оба их пути в маске и ни одного поля в теле.
 */
function toRepeatCell(request: FormatRequest): sheets_v4.Schema$Request {
  const { format } = request;
  const keys = (Object.keys(FORMAT_MASKS) as (keyof CellFormat)[]).filter(
    (key) => format[key] !== undefined,
  );
  return {
    repeatCell: {
      range: {
        sheetId: request.sheetId,
        startRowIndex: request.row - 1,
        endRowIndex: request.row,
        startColumnIndex: request.column,
        endColumnIndex: request.column + 1,
      },
      cell: { userEnteredFormat: toUserEnteredFormat(format) },
      fields: keys.flatMap((key) => FORMAT_MASKS[key]).join(','),
    },
  };
}

/** Тело правки вида: только поля со значением — `undefined` и `null` в тело не идут. */
function toUserEnteredFormat(format: CellFormat): sheets_v4.Schema$CellFormat {
  const textFormat = {
    ...Object.fromEntries(
      TEXT_KEYS.flatMap((key) => {
        const value = format[key];
        return value === undefined || value === null ? [] : [[key, value] as const];
      }),
    ),
    ...foreground(format.textColor),
  };
  const { numberFormat } = format;
  return {
    ...(Object.keys(textFormat).length === 0 ? {} : { textFormat }),
    ...(format.align === undefined ? {} : { horizontalAlignment: format.align.toUpperCase() }),
    ...background(format.background),
    ...(numberFormat === undefined || numberFormat === null
      ? {}
      : { numberFormat: { ...numberFormat } }),
  };
}

/**
 * Цвет — в ОБА поля Google, устаревшее и стиль `rgbColor` (Q16, Q18, см. `FORMAT_MASKS`): стиль
 * главнее, а устаревшее рядом — чтобы и его читатель не видел прежний цвет. Сброс `null` в тело
 * не идёт: он живёт в маске.
 */
const background = (hex: string | null | undefined): sheets_v4.Schema$CellFormat =>
  typeof hex === 'string'
    ? { backgroundColor: fromHex(hex), backgroundColorStyle: { rgbColor: fromHex(hex) } }
    : {};

const foreground = (hex: string | null | undefined): sheets_v4.Schema$TextFormat =>
  typeof hex === 'string'
    ? { foregroundColor: fromHex(hex), foregroundColorStyle: { rgbColor: fromHex(hex) } }
    : {};

/** `#ff8000` → доли, как их ждёт Google. Обратная сторона `toHex`. */
function fromHex(hex: string): sheets_v4.Schema$Color {
  const clean = hex.replace('#', '');
  const part = (at: number): number => parseInt(clean.slice(at, at + 2), 16) / 255;
  return { red: part(0), green: part(2), blue: part(4) };
}
