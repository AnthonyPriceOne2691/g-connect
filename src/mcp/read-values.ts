/**
 * `gc_read mode=values` — строки листа окном (D-26): до предела `read.max-rows` за вызов, с
 * любой строки (`fromRow`), и честно о том, есть ли строки дальше.
 *
 * Отдельным модулем по гейту длины `tools.ts` — и по делу: карта читает лист легко (первые
 * строки), а строки — отдельным окном. Раньше строки брались из той же лёгкой карты, и
 * `truncated` считался по уже обрезанному ответу: на листе в 1630 строк агент получал 499 и
 * `truncated: false` — правило «усечение помечается» не исполнял никто (оракул проверял
 * число, а не пометку, урок L22).
 */

import { asData, limitOf } from '../core/policy.js';
import { PARTIAL_READ_WARNING, windowRecords } from '../core/sheets/map.js';
import type {
  Cell,
  CellFormat,
  ColumnProfile,
  SheetData,
  SheetsClient,
} from '../core/sheets/types.js';

export interface ValuesRequest {
  readonly limit?: number | undefined;
  readonly fromRow?: number | undefined;
  /** Вид ячеек по строкам (D-26, Q11) — по умолчанию нет: ответ не растёт без просьбы. */
  readonly withFormat?: boolean | undefined;
}

/** Явный вид ячеек строки по именам колонок; ячейка без явного вида в запись не попадает. */
const rowFormats = (
  row: readonly Cell[],
  columns: readonly ColumnProfile[],
): Record<string, CellFormat> =>
  Object.fromEntries(
    columns.flatMap((column) => {
      const format = row[column.index]?.format;
      return format === undefined ? [] : [[column.name, format] as const];
    }),
  );

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
  const warnings = map.warnings.filter((w) => !w.startsWith(PARTIAL_READ_WARNING));
  if (request.fromRow !== undefined && request.fromRow < first) {
    warnings.push(`fromRow ${request.fromRow} — шапка или выше неё: строки отданы с ${first}-й`);
  }
  const origin = `таблица ${id}, лист «${map.sheet}»`;
  const records = windowRecords(window.rows, map.columns);
  return {
    sheet: map.sheet,
    headerRow: map.headerRow,
    columns: map.columns.map((c) => c.name),
    // Строка ответа под номером i — строка листа fromRow + i: пропуски в середине остаются.
    fromRow,
    sheetRows: window.gridRows,
    // Содержимое — ДАННЫЕ с пометкой источника (правило content.is-data).
    rows: asData(origin, records),
    // Вид — строка в строку с `rows` (Q11: найти дописанные строки, что выглядят иначе):
    // `windowRecords` срезает только пустой хвост, и первые `records.length` строк окна — ровно
    // строки ответа, а оформленный пустой хвост не попадает ни туда, ни сюда. Тоже данные: имя
    // шрифта и шаблон формата числа пишет в документ кто угодно.
    ...(request.withFormat === true
      ? {
          formats: asData(
            origin,
            window.rows.slice(0, records.length).map((row) => rowFormats(row, map.columns)),
          ),
        }
      : {}),
    truncated,
    ...(truncated ? { nextFromRow: last + 1 } : {}),
    warnings,
  };
}
