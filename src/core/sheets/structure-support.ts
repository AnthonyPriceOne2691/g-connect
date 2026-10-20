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
import { dataWidth, unlabeledCells } from './bounds.js';
import type { Prepared } from './commit.js';
import { columnQuestion, clarify, rowsUnderCondition } from './rows.js';
import { buildSheetData } from './map.js';
import {
  columnLetter,
  type CellValue,
  type ColumnProfile,
  type SheetData,
  type SheetMap,
  type SheetsClient,
} from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions, RowValues } from './write-types.js';

/**
 * Пустое условие у разрушающей правки — не «все строки», а отсутствие адреса.
 *
 * `findRows` на пустом условии возвращает ВСЁ (пустой `every` истинен), и `deleteRows`
 * без условия снёс бы весь блок данных, а подтверждать человеку предлагалось бы «весь
 * лист» — то есть подпись перестала называть предмет. Нашёл читатель без прогона.
 */
export function assertNamedRows(where: RowValues, what: string): void {
  if (Object.keys(where).length > 0) return;
  throw gcError('bad_request', {
    detail:
      `${what} без условия означало бы «все строки блока данных», а подтверждение — ` +
      '«весь лист», то есть подпись перестала бы называть предмет. Назови условие: ключ ' +
      'строки или значение колонки.',
    cause: 'empty_condition',
  });
}

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
export function assertSnapshotBudget(cells: number, options: { estimate?: boolean } = {}): void {
  const max = limitOf('write.snapshot-max-cells', 2000);
  if (cells <= max) return;
  // Оценка и точный счёт различаются словами: «по карте выходит ~N» честнее, чем «N»,
  // когда сетку ещё не читали. Разница нашлась при починке отзывчивости после живого
  // прогона: дешёвая проверка стоит ДО дорогого чтения книги.
  const size = options.estimate === true ? `по карте листа выходит ~${cells}` : `${cells}`;
  denyByRule(
    'write.snapshot-max-cells',
    `Снимок для отката: ${size} ячеек, разрешено ${max}. Записи не было: правку, ` +
      'которую нечем вернуть, ядро не делает. Сузь диапазон или удали руками в интерфейсе.',
  );
}

/**
 * Ячейки удаляемых строк в план: человек должен видеть, ЧТО именно исчезнет. Строка уходит целиком
 * (Q34), и план называет и колонки без подписи (Q37) — ключом `(C)`, как в `values` и `unlabeled`,
 * по месту в строке: раньше он перечислял одни подписи и молчал о «а) доступы» в C3. Пустые ячейки
 * без подписи в план не идут: подписанная колонка есть у каждой строки, пустая без подписи — шум.
 */
export function rowChanges(data: SheetData, rows: readonly number[]): PlannedChange[] {
  const map = data.map;
  return rows.flatMap((rowNumber) => {
    const index = rowNumber - map.headerRow - 1;
    const values = data.rows[index] ?? {};
    const unlabeled = unlabeledCells(map.unlabeled, data.cells[index] ?? []);
    const cells = [
      ...map.columns.map((column) => ({ column, key: column.name, before: values[column.name] })),
      ...unlabeled.map(({ column, value }) => ({ column, key: column.key, before: value })),
    ].sort((left, right) => left.column.index - right.column.index);
    return cells.map(({ column, key, before }): PlannedChange => ({
      kind: 'set',
      a1: `${map.sheet}!${column.letter}${rowNumber}`,
      column: key,
      before: before ?? null,
      after: null,
    }));
  });
}

/**
 * Ширина строки данных (Q33, Q34): от A до последней колонки — подписанной или со значением в
 * строках данных. Не число колонок карты: при шапке A, B, —, D их три, и сортировка брала A–C, а
 * колонка без подписи правее последней подписи не попадала ни в сортировку, ни в снимок.
 */
export function rowWidth(data: SheetData): number {
  const labeled = data.map.columns.map((column) => column.index + 1);
  return Math.max(1, dataWidth(data.cells), ...labeled);
}

/**
 * Снимок строк: значения И вид, иначе откат вернёт неоформленную строку. По всей ширине строки
 * и по индексу колонки листа (Q33, Q34): строка уходит целиком, и снимок по колонкам карты терял
 * колонки без подписи, а при разрыве шапки откат писал значения D в C.
 */
export function snapshotOf(map: SheetMap, data: SheetData, rows: readonly number[]): RangeSnapshot {
  const width = rowWidth(data);
  const cells = rows.map((rowNumber) => {
    const row = data.cells[rowNumber - map.headerRow - 1] ?? [];
    return Array.from({ length: width }, (_unused, index): SnapshotCell => {
      const format = row[index]?.format;
      return { value: row[index]?.value ?? null, ...(format === undefined ? {} : { format }) };
    });
  });
  return {
    a1Range: `${map.sheet}!A${rows[0] ?? 1}:${columnLetter(width - 1)}${rows[rows.length - 1] ?? 1}`,
    rows: cells,
  };
}

/** Снимок колонки: столбец значений от строки заголовка вниз. */
export function columnSnapshot(
  map: SheetMap,
  data: SheetData,
  name: string,
  letter: string,
  options: { readonly includeHeader?: boolean; readonly aboveHeader?: readonly CellValue[] } = {},
): RangeSnapshot {
  const withHeader = options.includeHeader !== false;
  const body = data.rows.map((row, index): SnapshotCell[] => {
    const format = data.formats[index]?.[name];
    return [{ value: row[name] ?? null, ...(format === undefined ? {} : { format }) }];
  });
  // Строки НАД шапкой тоже уходят в снимок: у владельца над ней живёт заголовок отчёта,
  // и удаление колонки без них теряло ячейки безвозвратно, обещая «откат вернёт значения
  // и вид». Нашёл читатель без прогона 2026-09-04 — оба живых прогона это пропустили.
  const above = withHeader ? (options.aboveHeader ?? []).map((value) => [{ value }]) : [];
  const rows = withHeader ? [...above, [{ value: name }], ...body] : body;
  const first = withHeader ? map.headerRow - above.length : map.headerRow + 1;
  return {
    a1Range: `${map.sheet}!${letter}${first}:${letter}${first + rows.length - 1}`,
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

/**
 * Колонка-якорь вместе с картой листа: то, чем начинается любая операция «по имени
 * колонки».
 *
 * Гейт копипаста нашёл одиннадцать одинаковых строк в удалении колонки и в
 * автозаполнении — и он прав: это один вопрос «какая колонка на какой карте», а две его
 * копии разъехались бы на первом же уточнении резолвера.
 */
export function columnAnchored(
  data: SheetData,
  columnName: string,
  options: RowOptions,
): { map: SheetMap; column: ColumnProfile } | { refusal: ApplyOutcome } {
  const map = data.map;
  const anchor = anchorColumn(map, columnName, options);
  if ('refusal' in anchor) return anchor;
  return { map, column: anchor.column };
}

/** Якорь словами: то, что человек подтверждает, — «строка проекта X», а не «строка 7». */
export function anchorText(where: RowValues): string {
  const parts = Object.entries(where).map(([field, value]) => `${field} = ${String(value)}`);
  return parts.length === 0 ? 'весь лист' : parts.join(', ');
}

/**
 * Предусловие для строки-якоря: та же строка на том же месте (D-17 для геометрии).
 *
 * Без этого вставка «выше проекта X» между планом и записью попала бы выше ЧУЖОЙ строки:
 * номер в плане уже не тот, если кто-то вставил строку раньше нас.
 */
export async function assertAnchorRow(
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

/**
 * Перечитанный лист для предусловия. Один помощник на строки и колонки: гейт копипаста
 * отклонил вторую копию этого чтения, и он прав — разъехавшись, они читали бы лист с
 * разной шапкой, и один якорь проверялся бы не по той карте.
 */
export async function freshData(client: SheetsClient, map: SheetMap): Promise<SheetData> {
  const snapshot = await client.getSpreadsheet(map.spreadsheetId, { sheet: map.sheet });
  return buildSheetData(snapshot, { sheet: map.sheet, headerRow: map.headerRow });
}

/**
 * Заготовка плана: пустая или с оговорками. `notes` уезжают человеку в ответ, а не в
 * комментарий кода — поэтому заготовка одна на все структурные операции: гейт копипаста
 * отклонил вторую копию, и он прав, иначе половина операций молчала бы там, где другая
 * половина предупреждает.
 */
export const prepared = (notes: readonly string[] = []): Prepared => ({
  resolved: [],
  assumptions: [],
  notes: [...notes],
  questions: [],
  touches: [],
});

/** То же для колонки: имя на месте и на том же индексе. */
export async function assertColumnStill(
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
