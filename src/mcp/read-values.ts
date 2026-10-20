/**
 * `gc_read mode=values` — строки листа окном (D-26): до предела `read.max-rows` за вызов, с
 * любой строки (`fromRow`), и честно о том, есть ли строки дальше.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: карта читает лист легко (первые
 * строки), а строки — отдельным окном. Раньше строки брались из той же лёгкой карты, и
 * `truncated` считался по уже обрезанному ответу: на листе в 1630 строк агент получал 499 и
 * `truncated: false` — правило «усечение помечается» не исполнял никто (оракул проверял
 * число, а не пометку, урок L22).
 *
 * Колонки без подписи со значениями (Q30) окно отдаёт под ключами `(C)` — только читать: в
 * `columns` их нет, и запись по ним резолвер не находит.
 *
 * Конец ответа окно называет само (Q36): `toRow` и предупреждение о срезанном пустом хвосте, пока
 * строки дальше есть; пустая строка с видом или заметкой, о которых просили, не срезается (Q38).
 */

import { asData, limitOf, type UntrustedData } from '../core/policy.js';
import { UNLABELED_WARNING, unlabeledIn, type KeyedColumn } from '../core/sheets/bounds.js';
import { PARTIAL_READ_WARNING, windowRecords } from '../core/sheets/map.js';
import type { Cell, CellFormat, SheetData, SheetsClient } from '../core/sheets/types.js';

export interface ValuesRequest {
  readonly limit?: number | undefined;
  readonly fromRow?: number | undefined;
  /** Вид ячеек по строкам (D-26, Q11) — по умолчанию нет: ответ не растёт без просьбы. */
  readonly withFormat?: boolean | undefined;
  /** Заметки ячеек по строкам (Q25) — тоже только по просьбе. */
  readonly withNotes?: boolean | undefined;
}

/** Поле ячеек строки по именам колонок; ячейка без него в запись не попадает. */
const byColumn = <T>(
  row: readonly Cell[],
  columns: readonly KeyedColumn[],
  pick: (cell: Cell | undefined) => T | undefined,
): Record<string, T> =>
  Object.fromEntries(
    columns.flatMap((column) => {
      const value = pick(row[column.index]);
      return value === undefined ? [] : [[column.name, value] as const];
    }),
  );

/** Слой ячеек окна: по записи на строку, ключ — имя колонки; строка без значений слоя — `{}`. */
type Layer<T> = UntrustedData<Record<string, T>[]>;

/**
 * Вид (Q11) и заметки (Q25) — строка в строку с `rows`, каждый по своей просьбе. Тоже данные:
 * имя шрифта, шаблон формата числа и текст заметки пишет в таблицу кто угодно.
 */
function cellLayers(
  rows: readonly (readonly Cell[])[],
  columns: readonly KeyedColumn[],
  request: ValuesRequest,
  origin: string,
): { formats?: Layer<CellFormat>; notes?: Layer<string> } {
  const layer = <T>(pick: (cell: Cell | undefined) => T | undefined): Layer<T> =>
    asData(
      origin,
      rows.map((row) => byColumn(row, columns, pick)),
    );
  return {
    ...(request.withFormat === true ? { formats: layer((cell) => cell?.format) } : {}),
    ...(request.withNotes === true ? { notes: layer((cell) => cell?.note) } : {}),
  };
}

export async function readValues(
  client: SheetsClient,
  id: string,
  data: SheetData,
  request: ValuesRequest,
) {
  const cap = limitOf('read.max-rows', 5000);
  const limit = Math.min(request.limit ?? cap, cap);
  const { map } = data;
  const first = map.headerRow + 1;
  const fromRow = Math.max(request.fromRow ?? first, first);
  const window = await client.readRows(id, map.sheet, fromRow, limit);
  const last = fromRow + limit - 1;
  // Строки дальше окна есть, пока окно не дошло до конца сетки. Пустые строки сетки за
  // данными тоже «дальше» — следующий вызов вернёт ноль строк и `truncated: false`: лишний
  // вызов дешевле молча потерянной строки.
  const truncated = last < window.gridRows;
  // Колонки без подписи — по самому окну, а не по карте (Q30): карта видит первые 500 строк, а
  // окно бывает и дальше. Их предупреждение карты заменяет своё: здесь значения уже в строках.
  const unlabeled = unlabeledIn(window.rows, fromRow, map.columns, 'values');
  const keyed = [
    ...map.columns,
    ...unlabeled.columns.map((column) => ({ name: column.key, index: column.index })),
  ].sort((left, right) => left.index - right.index);
  const warnings = map.warnings.filter(
    (w) => !w.startsWith(PARTIAL_READ_WARNING) && !w.startsWith(UNLABELED_WARNING),
  );
  warnings.push(...unlabeled.warnings);
  if (request.fromRow !== undefined && request.fromRow < first) {
    warnings.push(`fromRow ${request.fromRow} — шапка или выше неё: строки отданы с ${first}-й`);
  }
  const origin = `таблица ${id}, лист «${map.sheet}»`;
  const records = windowRecords(window.rows, keyed, markedBy(request));
  const end = windowEnd(fromRow, records.length, last, truncated);
  warnings.push(...end.warnings);
  return {
    sheet: map.sheet,
    headerRow: map.headerRow,
    columns: map.columns.map((c) => c.name),
    // Строка ответа под номером i — строка листа fromRow + i: пропуски в середине остаются.
    fromRow,
    // Строка листа последней строки ответа (Q36); строк нет — поля нет.
    ...end.fields,
    sheetRows: window.gridRows,
    // Содержимое — ДАННЫЕ с пометкой источника (правило content.is-data).
    rows: asData(origin, records),
    // Вид и заметки — строка в строку с `rows` (Q11: найти дописанные строки, что выглядят
    // иначе; Q25: прочесть заметки строк): `windowRecords` срезает только пустой хвост, и первые
    // `records.length` строк окна — ровно строки ответа. Пустая строка хвоста с видом или
    // заметкой, о которых просили, — тоже строка ответа (Q38), без просьбы — срезана.
    ...cellLayers(window.rows.slice(0, records.length), keyed, request, origin),
    truncated,
    ...(truncated ? { nextFromRow: last + 1 } : {}),
    warnings,
  };
}

/**
 * Что держит пустую строку хвоста окна (Q38): вид — при `withFormat`, заметка — при `withNotes`.
 * После `insertRows` две пустые оформленные строки 3–4 окно `fromRow 3, limit 2, withFormat`
 * отдавало пустым: хвост срезался вместе с `formats`, а вид этих строк и был вопросом.
 */
const markedBy =
  (request: ValuesRequest) =>
  (cell: Cell | undefined): boolean =>
    (request.withFormat === true && cell?.format !== undefined) ||
    (request.withNotes === true && cell?.note !== undefined);

/**
 * Конец ответа (Q36): `toRow` — строка листа последней строки `rows`, а срезанный пустой хвост
 * окна, пока строки дальше есть, — предупреждением. `fromRow 8, limit 5` при пустой 12-й отдавал
 * четыре строки и `nextFromRow: 13` — сдвига нет, но строк меньше `limit`, и что 12-я пуста, агент
 * не видел. Окно дошло до конца сетки (`truncated: false`) — предупреждать не о чем.
 */
function windowEnd(
  fromRow: number,
  count: number,
  last: number,
  truncated: boolean,
): { fields: { toRow?: number }; warnings: string[] } {
  const cut = fromRow + count;
  const what =
    cut === last
      ? `строка ${cut} окна пуста и в ответ не вошла`
      : `строки ${cut}–${last} окна пусты и в ответ не вошли`;
  return {
    fields: count === 0 ? {} : { toRow: cut - 1 },
    warnings: truncated && cut <= last ? [`${what} — продолжай с nextFromRow`] : [],
  };
}
