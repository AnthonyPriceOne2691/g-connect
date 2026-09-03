/**
 * Структурные операции: геометрия листа (§6.2, фаза 2.5b).
 *
 * Позиционные — вставка строк и колонок, новый лист, переименование. Их откат не требует
 * снимка: обратная операция удаляет вставленное или возвращает имя. Удаления и сортировка
 * приедут отдельными слайсами: у них другая форма отката, и мешать их здесь значило бы
 * вести две модели в одном модуле.
 *
 * Контур записи (код плана, конверт, предусловие, журнал) НЕ повторяется — он берётся из
 * `commit.ts` через `WriteShape`: этой поставке от него нужны только «чем применить» и
 * «чем проверить предусловие».
 */

import { gcError } from '../errors.js';
import { needsClarification, resolveColumn } from '../resolver.js';
import { buildSheetData } from './map.js';
import { finishWrite, type Prepared } from './commit.js';
import { columnQuestion, clarify, rowsUnderCondition } from './rows.js';
import type { SheetData, SheetMap, SheetsClient } from './types.js';
import type { ApplyOutcome, RowOptions, RowValues, StructuralPlan } from './write-types.js';

const empty = (): Prepared => ({
  resolved: [],
  assumptions: [],
  notes: [],
  questions: [],
  touches: [],
});

/** Якорь словами: то, что человек подтверждает, — «строка проекта X», а не «строка 7». */
function anchorText(where: RowValues): string {
  const parts = Object.entries(where).map(([field, value]) => `${field} = ${String(value)}`);
  return parts.length === 0 ? 'весь лист' : parts.join(', ');
}

/**
 * Вставка строк относительно строки-якоря (§6.2, `Ctrl+Shift+=`).
 *
 * Позиция считается от ключа, а не берётся числом: между планом и записью номер строки
 * может стать чужим — кто-то вставит строку выше. Поэтому предусловие перечитывает лист и
 * сверяет, что якорь всё ещё там же (D-17 для геометрии).
 */
export async function insertRows(
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  count: number,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertCount(count);
  const selected = rowsUnderCondition(
    data,
    where,
    options,
    'Под условие не подошла ни одна строка — относительно чего вставлять, непонятно.',
  );
  if ('refusal' in selected) return selected.refusal;
  const anchorRow = Math.min(...selected.rows);
  const at = options.below === true ? anchorRow + 1 : anchorRow;
  const structural: StructuralPlan = {
    kind: 'insertRows',
    sheet: map.sheet,
    at,
    count,
    anchor: `строка, где ${anchorText(where)}`,
  };
  return finishWrite(client, map, [], empty(), options, 'insertRows', {
    structural,
    apply: (c, m) => insertDimension(c, m, 'rows', at, count),
    precondition: (c, m) => assertAnchorRow(c, m, where, options, anchorRow),
  });
}

/** Вставка колонок относительно колонки-якоря (§6.2). Позиция — от имени, не от буквы. */
export async function insertColumns(
  client: SheetsClient,
  data: SheetData,
  columnName: string,
  count: number,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertCount(count);
  const resolution = resolveColumn(columnName, map.columns, options);
  if (needsClarification(resolution.step) || resolution.column === null) {
    return clarify([columnQuestion(columnName, resolution, map)], map);
  }
  const column = resolution.column;
  const at = options.below === true ? column.index + 2 : column.index + 1;
  const structural: StructuralPlan = {
    kind: 'insertColumns',
    sheet: map.sheet,
    at,
    count,
    anchor: `колонка «${column.name}» (${column.letter})`,
  };
  return finishWrite(client, map, [], empty(), options, 'insertColumns', {
    structural,
    apply: (c, m) => insertDimension(c, m, 'columns', at, count),
    precondition: (c, m) => assertColumnStill(c, m, column.name, column.index),
  });
}

/** Новый лист (§6.2, `Ctrl+N` внутри книги). Имя в книге уникально — это и проверяем. */
export async function addSheet(
  client: SheetsClient,
  data: SheetData,
  title: string,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertTitle(title);
  assertNoSuchSheet(map, title);
  const structural: StructuralPlan = { kind: 'addSheet', sheet: title, title };
  return finishWrite(client, map, [], empty(), options, 'addSheet', {
    structural,
    apply: (c, m) => c.batchUpdate(m.spreadsheetId, [{ kind: 'addSheet', title }]),
    precondition: (c, m) => assertTitleFree(c, m, title),
  });
}

/** Переименование листа. Прежнее имя уезжает в журнал: им и откатывается. */
export async function renameSheet(
  client: SheetsClient,
  data: SheetData,
  title: string,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertTitle(title);
  if (title === map.sheet) {
    return finishWrite(client, map, [], empty(), options, 'renameSheet', {});
  }
  assertNoSuchSheet(map, title);
  const structural: StructuralPlan = {
    kind: 'renameSheet',
    sheet: map.sheet,
    title,
    previousTitle: map.sheet,
  };
  return finishWrite(client, map, [], empty(), options, 'renameSheet', {
    structural,
    apply: (c, m) =>
      c.batchUpdate(m.spreadsheetId, [{ kind: 'renameSheet', sheetId: m.sheetId, title }]),
    precondition: (c, m) => assertTitleFree(c, m, title),
  });
}

function insertDimension(
  client: SheetsClient,
  map: SheetMap,
  dimension: 'rows' | 'columns',
  at: number,
  count: number,
): Promise<void> {
  return client.batchUpdate(map.spreadsheetId, [
    { kind: 'insertDimension', sheetId: map.sheetId, dimension, at, count },
  ]);
}

/** Сколько вставляем: ноль — не правка, отрицательное — не операция. */
function assertCount(count: number): void {
  if (Number.isInteger(count) && count > 0) return;
  throw gcError('bad_request', {
    detail: `Сколько строк или колонок вставить — целое число больше нуля, а не ${count}.`,
  });
}

function assertTitle(title: string): void {
  if (title.trim().length > 0) return;
  throw gcError('bad_request', { detail: 'Имя листа не может быть пустым.' });
}

/** Имена листов в книге уникальны: коллизия — не догадка, а отказ со списком. */
function assertNoSuchSheet(map: SheetMap, title: string): void {
  const known = [map.sheet, ...map.otherSheets.map((s) => s.title)];
  if (!known.includes(title)) return;
  throw gcError('bad_request', {
    detail: `Лист «${title}» в книге уже есть. Известные листы: ${known.join(', ')}.`,
  });
}

/**
 * Предусловие для строки-якоря: та же строка на том же месте (D-17 для геометрии).
 *
 * Без этого вставка «выше проекта X» между планом и записью попала бы выше ЧУЖОЙ строки:
 * номер в плане уже не тот, если кто-то вставил строку раньше нас.
 */
async function assertAnchorRow(
  client: SheetsClient,
  map: SheetMap,
  where: RowValues,
  options: RowOptions,
  expected: number,
): Promise<void> {
  const fresh = await freshData(client, map);
  const selected = rowsUnderCondition(fresh, where, options, 'Строка-якорь исчезла.');
  const now = 'refusal' in selected ? null : Math.min(...selected.rows);
  if (now === expected) return;
  throw gcError('stale_value', {
    detail:
      `Строка, где ${anchorText(where)}, была ${expected}-й, а сейчас ` +
      `${now === null ? 'её нет вовсе' : `${now}-я`}. Правка не выполнена: перечитай и ` +
      'подтверди новый план.',
    cause: 'anchor_moved',
  });
}

/** То же для колонки: имя на месте и на том же индексе. */
async function assertColumnStill(
  client: SheetsClient,
  map: SheetMap,
  name: string,
  index: number,
): Promise<void> {
  const fresh = await freshData(client, map);
  const column = fresh.map.columns.find((c) => c.name === name);
  if (column !== undefined && column.index === index) return;
  throw gcError('stale_value', {
    detail:
      `Колонка «${name}» была ${index + 1}-й, а сейчас ` +
      `${column === undefined ? 'её нет вовсе' : `${column.index + 1}-я`}. Правка не выполнена.`,
    cause: 'anchor_moved',
  });
}

/** Имя листа всё ещё свободно: между планом и записью его мог занять другой. */
async function assertTitleFree(client: SheetsClient, map: SheetMap, title: string): Promise<void> {
  const snapshot = await client.getSpreadsheet(map.spreadsheetId);
  if (!snapshot.sheets.some((s) => s.title === title)) return;
  throw gcError('stale_value', {
    detail: `Лист «${title}» появился в книге после построения плана. Правка не выполнена.`,
    cause: 'anchor_moved',
  });
}

/**
 * Перечитанный лист для предусловия. Один помощник на строки и колонки: гейт копипаста
 * отклонил вторую копию этого чтения, и он прав — разъехавшись, они читали бы лист с
 * разной шапкой, и один якорь проверялся бы не по той карте.
 */
async function freshData(client: SheetsClient, map: SheetMap): Promise<SheetData> {
  const snapshot = await client.getSpreadsheet(map.spreadsheetId, { sheet: map.sheet });
  return buildSheetData(snapshot, { sheet: map.sheet, headerRow: map.headerRow });
}
