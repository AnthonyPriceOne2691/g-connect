/**
 * Общее для структурных операций: якоря, бюджет снимка, снимки диапазонов.
 *
 * Отдельным модулем по гейту длины — и по делу: вставка и удаление задают позицию
 * ОДИНАКОВО (ключ строки, имя колонки), а бюджет снимка судит их обе. Гейт копипаста уже
 * отклонял вторую копию резолва колонки: разъехавшись, они по-разному отвечали бы на
 * «Дата» при двух похожих колонках.
 */

import { gcError } from '../errors.js';
import type { RangeSnapshot, SnapshotCell } from '../journal.js';
import { denyByRule, limitOf } from '../policy.js';
import { needsClarification, resolveColumn } from '../resolver.js';
import { columnQuestion, clarify } from './rows.js';
import { columnLetter, type ColumnProfile, type SheetData, type SheetMap } from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions, RowValues } from './write-types.js';

/** Предмет правки словами: то, что человек произносит в подтверждении (D-20). */
export function subjectOf(where: RowValues): string {
  const values = Object.values(where).map((v) => String(v));
  return values.length === 0 ? 'весь лист' : values.join(' / ');
}

/**
 * Удаление идёт непрерывным блоком: `deleteDimension` умеет только диапазон.
 *
 * Разрозненные строки — не повод удалить «первую подходящую» и не повод удалить всё между
 * ними: и то и другое человек не просил. Отказ называет номера.
 */
export function assertContiguous(rows: readonly number[]): void {
  const gaps = rows.some((row, i) => i > 0 && row !== rows[i - 1]! + 1);
  if (!gaps) return;
  throw gcError('bad_request', {
    detail:
      `Под условие подошли строки ${rows.join(', ')} — они не подряд, а удаление идёт ` +
      'непрерывным блоком. Уточни условие так, чтобы строки шли одна за другой.',
    cause: 'rows_not_contiguous',
  });
}

/** Бюджет снимка: не влез — отказ ДО записи, с обоими числами. */
export function assertSnapshotBudget(cells: number): void {
  const max = limitOf('write.snapshot-max-cells', 2000);
  if (cells <= max) return;
  denyByRule(
    'write.snapshot-max-cells',
    `Снимок для отката — ${cells} ячеек, разрешено ${max}. Записи не было: правку, ` +
      'которую нечем вернуть, ядро не делает. Сузь диапазон.',
  );
}

/** Ячейки удаляемых строк в план: человек должен видеть, ЧТО именно исчезнет. */
export function rowChanges(data: SheetData, rows: readonly number[]): PlannedChange[] {
  const map = data.map;
  const out: PlannedChange[] = [];
  for (const rowNumber of rows) {
    const index = rowNumber - map.headerRow - 1;
    const values = data.rows[index] ?? {};
    for (const column of map.columns) {
      out.push({
        kind: 'set',
        a1: `${map.sheet}!${column.letter}${rowNumber}`,
        column: column.name,
        before: values[column.name] ?? null,
        after: null,
      });
    }
  }
  return out;
}

/** Снимок удаляемых строк: значения И вид, иначе откат вернёт неоформленную строку. */
export function snapshotOf(map: SheetMap, data: SheetData, rows: readonly number[]): RangeSnapshot {
  const last = columnLetter(map.columns.length - 1);
  const cells = rows.map((rowNumber) => {
    const index = rowNumber - map.headerRow - 1;
    const values = data.rows[index] ?? {};
    const formats = data.formats[index] ?? {};
    return map.columns.map((column): SnapshotCell => {
      const format = formats[column.name];
      return {
        value: values[column.name] ?? null,
        ...(format === undefined ? {} : { format }),
      };
    });
  });
  return {
    a1Range: `${map.sheet}!A${rows[0] ?? 1}:${last}${rows[rows.length - 1] ?? 1}`,
    rows: cells,
  };
}

/** Снимок колонки: столбец значений от строки заголовка вниз. */
export function columnSnapshot(
  map: SheetMap,
  data: SheetData,
  name: string,
  letter: string,
): RangeSnapshot {
  const rows: SnapshotCell[][] = [[{ value: name }]];
  data.rows.forEach((row, index) => {
    const format = data.formats[index]?.[name];
    rows.push([{ value: row[name] ?? null, ...(format === undefined ? {} : { format }) }]);
  });
  return {
    a1Range: `${map.sheet}!${letter}${map.headerRow}:${letter}${map.headerRow + data.rows.length}`,
    rows,
  };
}

/**
 * Колонка-якорь по имени: те же шесть ступеней резолвера, что у записи значений.
 *
 * Один помощник на вставку и удаление — гейт копипаста отклонил вторую копию, и он прав:
 * разъехавшись, они по-разному отвечали бы на «Дата» при двух похожих колонках.
 */
export function anchorColumn(
  map: SheetMap,
  columnName: string,
  options: RowOptions,
): { column: ColumnProfile } | { refusal: ApplyOutcome } {
  const resolution = resolveColumn(columnName, map.columns, options);
  if (needsClarification(resolution.step) || resolution.column === null) {
    return { refusal: clarify([columnQuestion(columnName, resolution, map)], map) };
  }
  return { column: resolution.column };
}
