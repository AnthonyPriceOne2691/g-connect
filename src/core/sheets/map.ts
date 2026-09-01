/**
 * Карта листа: шапка, границы данных, профиль колонок (DESIGN.md §7, §8.1, §9.3).
 *
 * Главное здесь — автоопределение строки заголовков. В живых таблицах шапка не в первой
 * строке: сверху название отчёта, пустые строки, объединённые ячейки. Эвристика обязана
 * не только выбрать строку, но и СКАЗАТЬ, что выбрала: иначе её ошибка становится
 * невидимой порчей данных.
 */

import { gcError } from '../errors.ts';
import {
  columnLetter,
  type Cell,
  type CellValue,
  type ColumnProfile,
  type ColumnType,
  type GridRange,
  type SheetData,
  type SheetMap,
  type SheetSnapshot,
  type SpreadsheetSnapshot,
} from './types.ts';

const HEADER_SEARCH_DEPTH = 8;
const SAMPLE_ROWS = 3;
/** Порог «колонка похожа на перечисление»: мало уникальных на много строк. */
const ENUM_MAX_UNIQUE = 8;
const ENUM_MIN_ROWS = 4;

const text = (cell: Cell | undefined): string =>
  cell?.value === null || cell?.value === undefined ? '' : String(cell.value).trim();

const isBlank = (cell: Cell | undefined): boolean => text(cell) === '';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/;
const NUMBER_RE = /^-?\d+([.,]\d+)?$/;
const LINK_RE = /^https?:\/\//i;

function valueType(raw: string): ColumnType {
  if (raw === '') return 'unknown';
  if (DATE_RE.test(raw)) return 'date';
  if (NUMBER_RE.test(raw)) return 'number';
  if (LINK_RE.test(raw)) return 'link';
  if (/^(да|нет|true|false|yes|no)$/i.test(raw)) return 'boolean';
  return 'string';
}

/** Тип колонки — самый частый непустой тип значений; ничья решается в пользу строки. */
function dominantType(values: readonly string[]): ColumnType {
  const counts = new Map<ColumnType, number>();
  for (const v of values) {
    const t = valueType(v);
    if (t === 'unknown') continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: ColumnType = 'unknown';
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount || (count === bestCount && type === 'string')) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/** Формат даты берётся у самой колонки: писать «2026-09-01» в колонку с «01.09.2026» — порча. */
function detectDateFormat(values: readonly string[]): 'iso' | 'dotted' | null {
  let iso = 0;
  let dotted = 0;
  for (const v of values) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) iso += 1;
    else if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(v)) dotted += 1;
  }
  if (iso === 0 && dotted === 0) return null;
  return iso >= dotted ? 'iso' : 'dotted';
}

interface HeaderGuess {
  readonly row: number;
  readonly reason: string;
  readonly confident: boolean;
}

/**
 * Строка заголовков ищется по признакам: заполнена подряд, значения уникальны и
 * нечисловые, а под ней есть данные. Балл важнее любого одного признака — иначе
 * «Отчёт за сентябрь» в первой строке выигрывает у настоящей шапки.
 */
export function detectHeaderRow(rows: readonly (readonly Cell[])[]): HeaderGuess {
  const depth = Math.min(HEADER_SEARCH_DEPTH, rows.length);
  let best: { row: number; score: number; cells: number } | null = null;

  for (let i = 0; i < depth; i += 1) {
    const row = rows[i] ?? [];
    const filled = row.filter((c) => !isBlank(c)).length;
    if (filled < 2) continue;

    const labels = row.map(text).filter((t) => t !== '');
    const unique = new Set(labels.map((t) => t.toLowerCase())).size === labels.length;
    const numeric = labels.filter((t) => NUMBER_RE.test(t) || DATE_RE.test(t)).length;
    const below = rows[i + 1] ?? [];
    const belowFilled = below.filter((c) => !isBlank(c)).length;
    const contiguous = row.findIndex((c) => isBlank(c));
    const gapInside = contiguous !== -1 && contiguous < filled;

    let score = filled * 2;
    if (unique) score += 3;
    score -= numeric * 3;
    if (belowFilled >= Math.max(2, filled - 1)) score += 4;
    if (gapInside) score -= 2;
    if (row.some((c) => c.formula !== undefined)) score -= 4;

    if (best === null || score > best.score) best = { row: i + 1, score, cells: filled };
  }

  if (best === null) {
    return { row: 1, reason: 'данных нет — шапкой считается первая строка', confident: false };
  }
  const reason =
    best.row === 1
      ? `строка 1: ${best.cells} подписей, ниже данные`
      : `строка ${best.row}: выше нет подходящей шапки (${best.cells} подписей, ниже данные)`;
  return { row: best.row, reason, confident: best.score >= 9 };
}

const inRange = (range: GridRange, row: number, column: number): boolean =>
  row >= range.startRow &&
  row <= range.endRow &&
  column >= range.startColumn &&
  column <= range.endColumn;

function validationValues(
  sheet: SheetSnapshot,
  columnIndex: number,
  firstDataRow: number,
): readonly string[] | null {
  for (const rule of sheet.validations ?? []) {
    if (inRange(rule.range, firstDataRow, columnIndex) && rule.values.length > 0)
      return rule.values;
  }
  return null;
}

function isProtected(sheet: SheetSnapshot, columnIndex: number, firstDataRow: number): boolean {
  return (sheet.protectedRanges ?? []).some((r) => inRange(r, firstDataRow, columnIndex));
}

/** Строка сетки → запись по именам колонок. Было скопировано дважды (нашёл jscpd). */
function rowToRecord(
  row: readonly Cell[],
  columns: readonly ColumnProfile[],
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const column of columns) out[column.name] = row[column.index]?.value ?? null;
  return out;
}

/**
 * Пустая колонка внутри шапки делит лист на блоки: справа от неё обычно отдельная
 * таблица (или врезка), а не продолжение данных. Молча втянуть её значит выдать
 * колонку с одной заполненной ячейкой и не сказать почему — §9.3 требует обратного.
 */
function detectSideBlock(
  headerCells: readonly Cell[],
): { gapAt: number; rightFrom: number } | null {
  const filledAt: number[] = [];
  headerCells.forEach((cell, index) => {
    if (!isBlank(cell)) filledAt.push(index);
  });
  if (filledAt.length < 2) return null;

  for (let i = 1; i < filledAt.length; i += 1) {
    const previous = filledAt[i - 1]!;
    const current = filledAt[i]!;
    if (current - previous > 1) return { gapAt: previous + 1, rightFrom: current };
  }
  return null;
}

/** Объединённые ячейки, задевающие шапку или область данных. */
function mergeWarnings(sheet: SheetSnapshot, headerRow: number): string[] {
  const merges = sheet.merges ?? [];
  if (merges.length === 0) return [];

  const inHeader = merges.filter((m) => m.startRow <= headerRow && m.endRow >= headerRow);
  const inData = merges.filter((m) => m.startRow > headerRow);
  const out: string[] = [];
  if (inHeader.length > 0) {
    out.push(
      `шапку задевают объединённые ячейки (${inHeader.length}) — имена колонок могут читаться не так, ` +
        'как выглядят на экране',
    );
  }
  if (inData.length > 0) {
    const ranges = inData
      .slice(0, 3)
      .map(
        (m) =>
          `${columnLetter(m.startColumn)}${m.startRow}:${columnLetter(m.endColumn)}${m.endRow}`,
      )
      .join(', ');
    out.push(
      `в области данных ${inData.length} объединённых диапазон(ов) (${ranges}${inData.length > 3 ? ', …' : ''}) — ` +
        'значение принадлежит верхней левой ячейке, остальные читаются пустыми',
    );
  }
  return out;
}

export interface SheetMapOptions {
  /** Имя листа; без него берётся первый. */
  readonly sheet?: string;
  /** Переопределение строки заголовков, если эвристика не угадала. */
  readonly headerRow?: number;
}

export function buildSheetData(
  snapshot: SpreadsheetSnapshot,
  options: SheetMapOptions = {},
): SheetData {
  const requested = options.sheet;
  const sheet =
    requested === undefined
      ? snapshot.sheets[0]
      : snapshot.sheets.find((s) => s.title === requested);
  if (sheet === undefined) {
    throw gcError('not_found', {
      detail:
        requested === undefined
          ? 'В таблице нет ни одного листа.'
          : `Листа «${requested}» нет. Есть: ${snapshot.sheets.map((s) => s.title).join(', ')}.`,
    });
  }

  const rows = sheet.rows;
  const guess =
    options.headerRow === undefined
      ? detectHeaderRow(rows)
      : { row: options.headerRow, reason: 'строка заголовков задана вызывающим', confident: true };
  const headerCells = rows[guess.row - 1] ?? [];
  const dataRows = rows.slice(guess.row);
  const warnings: string[] = [];

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns: ColumnProfile[] = [];
  const seen = new Map<string, number>();

  for (let index = 0; index < headerCells.length; index += 1) {
    const name = text(headerCells[index]);
    if (name === '') continue;
    const previous = seen.get(name.toLowerCase());
    if (previous !== undefined) {
      warnings.push(
        `колонки ${columnLetter(previous)} и ${columnLetter(index)} названы одинаково («${name}») — ` +
          'адресация по имени будет неоднозначной',
      );
    }
    seen.set(name.toLowerCase(), index);

    const cells = dataRows.map((row) => row[index]);
    const values = cells.map(text);
    const nonEmpty = values.filter((v) => v !== '');
    const uniqueValues = new Set(nonEmpty.map((v) => v.toLowerCase()));
    // Первая строка ДАННЫХ, а не строка шапки: правила валидации и защита диапазонов
    // объявлены на данных. Проверка по шапке молча теряла enum из таблицы.
    const firstDataRow = guess.row + 1;
    const validation = validationValues(sheet, index, firstDataRow);
    const inferredEnum =
      validation === null &&
      nonEmpty.length >= ENUM_MIN_ROWS &&
      uniqueValues.size <= ENUM_MAX_UNIQUE &&
      uniqueValues.size < nonEmpty.length
        ? [...new Set(nonEmpty)]
        : null;

    columns.push({
      name,
      letter: columnLetter(index),
      index,
      type: dominantType(values),
      dateFormat: detectDateFormat(nonEmpty),
      enumValues: validation ?? inferredEnum,
      enumSource: validation !== null ? 'validation' : inferredEnum !== null ? 'inferred' : null,
      filled: nonEmpty.length,
      unique: uniqueValues.size,
      hasFormula: cells.some((c) => c?.formula !== undefined),
      protected: isProtected(sheet, index, firstDataRow),
    });
  }

  if (columns.length === 0) {
    warnings.push(`в строке ${guess.row} не нашлось ни одной подписи колонки`);
  }

  const side = detectSideBlock(headerCells);
  if (side !== null) {
    const gap = columnLetter(side.gapAt);
    const right = columnLetter(side.rightFrom);
    warnings.push(
      `колонка ${gap} пуста, а правее (с ${right}) снова есть подписи — похоже, на листе ДВА блока. ` +
        `Правая часть в данные втянута как обычные колонки; если это отдельная таблица или врезка, ` +
        `читай её отдельным вызовом или задай область явно`,
    );
  }
  warnings.push(...mergeWarnings(sheet, guess.row));
  if (!guess.confident && options.headerRow === undefined) {
    warnings.push(
      `строка заголовков выбрана неуверенно (${guess.reason}) — проверь и при нужде задай headerRow`,
    );
  }
  if (guess.row > 1) {
    const above = rows.slice(0, guess.row - 1).filter((r) => r.some((c) => !isBlank(c))).length;
    if (above > 0) warnings.push(`над шапкой ${above} непустых строк — они в данные не попадают`);
  }

  const dataRowCount = dataRows.filter((row) => row.some((c) => !isBlank(c))).length;
  const usedRange =
    rows.length === 0 || width === 0
      ? `${sheet.title}!A1:A1`
      : `${sheet.title}!A1:${columnLetter(width - 1)}${rows.length}`;

  const allRows = dataRows.map((row) => rowToRecord(row, columns));
  const sampleRows = allRows.slice(0, SAMPLE_ROWS);

  const map: SheetMap = {
    spreadsheetId: snapshot.id,
    spreadsheetTitle: snapshot.title,
    revisionId: snapshot.revisionId ?? null,
    sheet: sheet.title,
    sheetId: sheet.sheetId,
    headerRow: guess.row,
    headerRowReason: guess.reason,
    headerRowConfident: guess.confident,
    usedRange,
    dataRowCount,
    columns,
    sampleRows,
    otherSheets: snapshot.sheets
      .filter((s) => s.title !== sheet.title)
      .map((s) => ({ title: s.title, rowCount: s.rows.length })),
    warnings,
  };

  return { map, rows: allRows };
}

/** Только карта — когда данные не нужны (ответ агенту на «что в этой таблице»). */
export function buildSheetMap(
  snapshot: SpreadsheetSnapshot,
  options: SheetMapOptions = {},
): SheetMap {
  return buildSheetData(snapshot, options).map;
}
