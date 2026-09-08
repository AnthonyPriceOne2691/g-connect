/**
 * Порядок строк: перемещение и сортировка (§6.2, фаза 2.5b).
 *
 * Отдельным модулем от вставок и удалений по гейту длины — и по делу: у этих двух правок
 * своя форма отката. Перемещение возвращается перемещением по выведенной формуле,
 * сортировка — только снимком, потому что она не помнит, откуда приехала строка.
 */

import { gcError } from '../errors.js';
import type { RangeSnapshot, SnapshotCell } from '../journal.js';
import { contextOf, finishWrite } from './commit.js';
import { rowsUnderCondition } from './rows.js';
import {
  anchorText,
  assertAnchorRow,
  assertColumnStill,
  assertContiguous,
  assertNamedRows,
  assertSnapshotBudget,
  snapshotOf,
  columnAnchored,
  subjectOf,
  prepared,
} from './structure-support.js';
import { columnLetter, type SheetData, type SheetMap, type SheetsClient } from './types.js';
import type { ApplyOutcome, RowOptions, RowValues, StructuralPlan } from './write-types.js';

/**
 * Перемещение строк относительно другой строки (§6.2).
 *
 * Оба конца — якоря: «перемести строку проекта X выше проекта Y». Номера здесь особенно
 * опасны, потому что перемещение само их и сдвигает: `destinationIndex` у Google считается
 * ПО КООРДИНАТАМ ДО удаления блока, и это ровно тот класс ошибки, где «удалили не ту
 * строку» выглядит как успех. Формула прямого и обратного хода живёт одна, в
 * `move-math.ts`, и покрыта оракулом на числах из документации.
 */
export async function moveRows(
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  before: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertNamedRows(where, 'Перемещение строк');
  const source = rowsUnderCondition(data, where, options, 'Нечего перемещать: строк нет.');
  if ('refusal' in source) return source.refusal;
  const rows = [...source.rows].sort((a, b) => a - b);
  assertContiguous(rows);
  const target = rowsUnderCondition(data, before, options, 'Некуда перемещать: строки нет.');
  if ('refusal' in target) return target.refusal;

  const at = rows[0]!;
  const count = rows.length;
  const anchor = Math.min(...target.rows);
  if (anchor >= at && anchor < at + count) {
    throw gcError('bad_request', {
      detail: 'Строка-ориентир внутри перемещаемого блока — перемещать некуда.',
      cause: 'move_into_itself',
    });
  }
  // 0-based индекс «перед этой строкой», как ждёт Google.
  const destinationIndex = anchor - 1;
  const structural: StructuralPlan = {
    kind: 'moveRows',
    sheet: map.sheet,
    at,
    count,
    to: destinationIndex,
    anchor: `строка, где ${anchorText(where)} → перед строкой, где ${anchorText(before)}`,
    confirmPhrase: `перемещаю ${subjectOf(where)}`,
    confirmToken: subjectOf(where),
  };
  // План перемещения обязан сказать, ЧТО поедет: живой прогон 2026-09-04 показал пустой
  // `changes` при требовании подтвердить название — то есть человеку предлагали
  // подтвердить то, чего ему не показали. Значений перемещение не меняет, поэтому
  // говорим порядком: какие строки и куда.
  const moved = rows.map((row) => keyOf(data, map, row)).join(', ');
  const anchorKey = keyOf(data, map, anchor);
  const notes = [
    `Поедет ${count === 1 ? 'строка' : `${count} строк`}: ${moved} — станет ` +
      `${anchor < at ? 'выше' : 'ниже'} строки «${anchorKey}». Значения не меняются, ` +
      'меняется порядок; откат вернёт строки на прежнее место.',
  ];
  assertSnapshotBudget(count * Math.max(1, map.columns.length));
  return finishWrite(client, contextOf(map), [], prepared(notes), options, 'moveRows', {
    structural,
    // Снимок перемещаемых строк — обещание четырёх документов и вторая линия обороны:
    // вся обратимость иначе держалась бы на арифметике `inverseMove`, чья ошибка выглядит
    // как успех. Нашёл читатель без прогона 2026-09-04.
    snapshots: [snapshotOf(map, data, rows)],
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [
        {
          kind: 'moveDimension',
          sheetId: map.sheetId,
          dimension: 'rows',
          at,
          count,
          destinationIndex,
        },
      ]),
    precondition: (c) => assertAnchorRow(c, map, where, options, at),
  });
}

/**
 * Сортировка данных листа по колонке (§6.2).
 *
 * Диапазон — от первой строки данных до последней и от колонки A: так снимается
 * неоднозначность документации про `dimensionIndex` (относительно листа или диапазона —
 * не сказано, а при начале от A оба чтения совпадают). Шапка в сортировку не попадает.
 *
 * Откат — только снимком: порядок строк обратной операцией не восстановить, потому что
 * сортировка не запоминает, откуда какая строка приехала.
 */
export async function sortRange(
  client: SheetsClient,
  data: SheetData,
  columnName: string,
  options: RowOptions & { readonly descending?: boolean } = {},
): Promise<ApplyOutcome> {
  const anchored = columnAnchored(data, columnName, options);
  if ('refusal' in anchored) return anchored.refusal;
  const { map, column } = anchored;
  const rows = data.rows.length;
  if (rows < 2) {
    throw gcError('bad_request', {
      detail: `На листе ${rows} строк данных — сортировать нечего.`,
      cause: 'nothing_to_sort',
    });
  }
  const width = map.columns.length;
  assertSnapshotBudget(rows * width);
  const range = { row: map.headerRow + 1, column: 0, rowCount: rows, columnCount: width };
  const structural: StructuralPlan = {
    kind: 'sortRange',
    sheet: map.sheet,
    at: range.row,
    count: rows,
    anchor: `по колонке «${column.name}»${options.descending === true ? ', по убыванию' : ''}`,
    confirmPhrase: `сортирую лист ${map.sheet} по колонке ${column.name}`,
    confirmToken: column.name,
  };
  // Что именно станет — план не обещает намеренно: сортирует Google, по своим правилам
  // сравнения строк, и подставлять сюда собственный порядок значило бы обещать не то,
  // что произойдёт. Зато план говорит, ЧТО поедет и чем это вернуть.
  const current = data.rows
    .slice(0, 5)
    .map((row) => String(row[map.columns[0]?.name ?? column.name] ?? ''))
    .join(', ');
  const notes = [
    `Порядок ${rows} строк изменится: сортировка по «${column.name}»` +
      `${options.descending === true ? ' по убыванию' : ' по возрастанию'}. Сейчас первые ` +
      `строки идут так: ${current}${rows > 5 ? ' …' : ''}. Итоговый порядок задаёт Google ` +
      '(его правила сравнения), поэтому план его не обещает — но снимок в журнале ' +
      'позволяет вернуть прежний порядок целиком.',
  ];
  return finishWrite(client, contextOf(map), [], prepared(notes), options, 'sortRange', {
    structural,
    snapshots: [sortSnapshot(map, data, rows)],
    // Колонка сортировки всё ещё на том же месте: иначе Google отсортирует по чужому
    // индексу, а снимок в журнале окажется от другого порядка.
    precondition: (c) => assertColumnStill(c, map, column.name, column.index),
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [
        {
          kind: 'sortRange',
          sheetId: map.sheetId,
          range,
          column: column.index,
          ...(options.descending === true ? { descending: true } : {}),
        },
      ]),
  });
}

/** Снимок всего блока данных: порядок строк восстанавливается только заливкой. */
function sortSnapshot(map: SheetMap, data: SheetData, rows: number): RangeSnapshot {
  const first = map.headerRow + 1;
  const last = columnLetter(map.columns.length - 1);
  return {
    a1Range: `${map.sheet}!A${first}:${last}${first + rows - 1}`,
    rows: data.rows.map((row, index) =>
      map.columns.map((col): SnapshotCell => {
        const format = data.formats[index]?.[col.name];
        return {
          value: row[col.name] ?? null,
          ...(format === undefined ? {} : { format }),
        };
      }),
    ),
  };
}

/** Ключ строки словами: им человек узнаёт строку в плане, а не по номеру. */
function keyOf(data: SheetData, map: SheetMap, rowNumber: number): string {
  const index = rowNumber - map.headerRow - 1;
  const first = map.columns[0]?.name;
  const value = first === undefined ? undefined : data.rows[index]?.[first];
  return value === undefined || value === null ? `строка ${rowNumber}` : String(value);
}
