/**
 * Порядок строк: перемещение и сортировка (§6.2, фаза 2.5b).
 *
 * Отдельным модулем от вставок и удалений по гейту длины — и по делу: у этих двух правок
 * своя форма отката. Перемещение возвращается перемещением по выведенной формуле,
 * сортировка — только снимком, потому что она не помнит, откуда приехала строка.
 */

import { gcError } from '../errors.js';
import { listed, unlabeledCells } from './bounds.js';
import { contextOf, finishWrite } from './commit.js';
import { rowsUnderCondition } from './rows.js';
import {
  anchorText,
  assertAnchorRow,
  assertColumnStill,
  assertContiguous,
  assertNamedRows,
  assertSnapshotBudget,
  rowWidth,
  snapshotOf,
  columnAnchored,
  subjectOf,
  prepared,
} from './structure-support.js';
import type { SheetData, SheetMap, SheetsClient } from './types.js';
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
    ...wholeRowNote(data, rows),
  ];
  assertSnapshotBudget(count * rowWidth(data));
  const plan = prepared(notes, [...(source.assumptions ?? []), ...(target.assumptions ?? [])]);
  return finishWrite(client, contextOf(map), [], plan, options, 'moveRows', {
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
 * Правый край — последняя колонка строк данных (Q33), а не число колонок карты: Google двигает
 * только ячейки диапазона, и колонка за его краем оставалась на месте, пока строка уезжала.
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
  const width = rowWidth(data);
  assertSnapshotBudget(rows * width);
  const range = { row: map.headerRow + 1, column: 0, rowCount: rows, columnCount: width };
  const block = Array.from({ length: rows }, (_unused, index) => range.row + index);
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
    ...wholeRowNote(data, block),
  ];
  return finishWrite(client, contextOf(map), [], prepared(notes), options, 'sortRange', {
    structural,
    // Снимок всего блока данных — той же ширины, что диапазон: порядок строк восстанавливается
    // только заливкой, и каждая ячейка — в свою колонку (Q33).
    snapshots: [snapshotOf(map, data, block)],
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

/**
 * Строки едут целиком (Q33, Q34) — вместе с колонками без подписи, и план называет их ключами
 * (Q37), пять и многоточие, как предупреждение карты: подписанные колонки видны в плане сами, а о
 * подпунктах в C человек узнавал, только когда они уже уехали. Значений без подписи в этих строках
 * нет — заметки нет.
 */
function wholeRowNote(data: SheetData, rows: readonly number[]): string[] {
  const { map } = data;
  const moving = new Set(
    rows
      .flatMap((row) => unlabeledCells(map.unlabeled, data.cells[row - map.headerRow - 1] ?? []))
      .map(({ column }) => column),
  );
  if (moving.size === 0) return [];
  // По порядку листа, а не строк: подпункт в E выше по листу, чем в C, — ключи всё равно (C), (E).
  const keys = [...moving].sort((left, right) => left.index - right.index).map(({ key }) => key);
  return [`строки едут целиком — вместе с колонками без подписи ${listed(keys)}`];
}

/** Ключ строки словами: им человек узнаёт строку в плане, а не по номеру. */
function keyOf(data: SheetData, map: SheetMap, rowNumber: number): string {
  const index = rowNumber - map.headerRow - 1;
  const first = map.columns[0]?.name;
  const value = first === undefined ? undefined : data.rows[index]?.[first];
  return value === undefined || value === null ? `строка ${rowNumber}` : String(value);
}
