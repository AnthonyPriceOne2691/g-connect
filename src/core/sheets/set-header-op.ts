/**
 * Подпись пустых ячеек строки шапки — `setHeader` (хотфикс, слово владельца 2026-11-11).
 *
 * Случай соседней сессии: лист создан `addSheet` и пуст, а шапку из шести колонок записать нечем.
 * `upsertRow` по именам отвечал «колонки нет, создавать её сама не буду» (`columns.no-silent-create`),
 * `appendRow` ключами `(A)…(F)` — «в колонку без подписи и без значений не пишу — подпиши шапку», а
 * подписать шапку было нечем.
 *
 * Молча колонки по-прежнему не создаются: это явная операция с планом «A1: ∅ → «№»», и пишет она
 * ТОЛЬКО в пустые ячейки строки шапки. Занятая ячейка — отказ с её адресом и текстом, а не
 * перезапись: переименование колонки — другая правка, мимоходом её делать нельзя. Подпись,
 * повторяющая соседнюю, — тоже отказ: две колонки с одним именем делают адресацию по имени
 * неоднозначной. После подписи колонка — обычная подписанная, и колонке без подписи `(A)` её ключ
 * больше не нужен.
 *
 * Запись — тем же контуром, что `setCells` (`finishWrite`): код плана, конверт по числу ячеек,
 * сверка «ячейки всё ещё пусты» перед записью (`stale_value`), снимок «до» в журнале — откат
 * возвращает пустоту. Отличие одно — текстом (RAW): подпись «2026» или «=итог» остаётся подписью,
 * а не числом и не формулой.
 */

import { z } from 'zod';

import { gcError } from '../errors.js';
import { commonFields } from '../op-fields.js';
import { contextOf, finishWrite } from './commit.js';
import { assertRevision } from './rows.js';
import { prepared } from './structure-support.js';
import {
  columnLetter,
  type ColumnProfile,
  type SheetData,
  type SheetMap,
  type SheetsClient,
} from './types.js';
import { assertBeforeValues } from './write-guards.js';
import type { ApplyOutcome, PlannedChange, RowOptions } from './write-types.js';

/** Операция на внешней границе ядра — своим модулем по гейту длины `ops.ts`, как `uploadFile`. */
export const setHeaderOp = z.object({
  op: z.literal('setHeader'),
  /** Подписи по порядку, слева направо от `startColumn`: одна подпись — одна пустая ячейка. */
  columns: z.array(z.string().min(1)).min(1),
  /** Буква колонки первой подписи, регистр не важен; без неё — A. ZZZ — последняя колонка Google. */
  startColumn: z
    .string()
    .regex(/^[A-Za-z]{1,3}$/, 'буква колонки — от A до ZZZ')
    .default('A'),
  ...commonFields,
});

/** Что подписать: подписи по порядку и буква колонки первой из них. */
export interface HeaderRequest {
  readonly columns: readonly string[];
  readonly startColumn: string;
}

/** Подпись и её ячейка в строке шапки: индекс колонки листа, 0-based. */
interface HeaderCell {
  readonly label: string;
  readonly index: number;
}

/**
 * Подписать пустые ячейки строки шапки — строки `headerRow` вызова или той, что выбрала карта (на
 * пустом листе — первой). Отказы — до плана, и записи при них нет: пустая или повторная подпись,
 * занятая ячейка.
 */
export async function setHeader(
  client: SheetsClient,
  data: SheetData,
  request: HeaderRequest,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertRevision(map, options);
  const start = columnIndex(request.startColumn);
  const cells = checkedLabels(request.columns).map((label, offset) => ({
    label,
    index: start + offset,
  }));
  assertEmpty(map, cells);
  assertNewLabels(map, cells);

  const changes: PlannedChange[] = cells.map(({ label, index }) => ({
    kind: 'set',
    a1: `${map.sheet}!${columnLetter(index)}${map.headerRow}`,
    column: label,
    before: null,
    after: label,
  }));
  // Строку шапки выбрала карта или вызов, и план называет её: иначе ошибка выбора невидима (§9.3).
  const plan = prepared(keyNotes(data.unlabeled, cells), [
    `Строка шапки — ${map.headerRow} (${map.headerRowReason})`,
  ]);
  return finishWrite(client, contextOf(map), changes, plan, options, 'setHeader', {
    // Все подписи — одним запросом и текстом (RAW): «2026» и «=итог» остаются подписями.
    apply: (c) =>
      c.batchUpdateValues(
        map.spreadsheetId,
        changes.map((change) => ({ range: change.a1, value: change.after })),
        'raw',
      ),
    // Сверка «было» (D-17): ячейки шапки всё ещё пусты, иначе `stale_value` и записи нет.
    precondition: (c) => assertBeforeValues(c, map, changes),
  });
}

/** Буква колонки → индекс колонки листа, 0-based: A → 0, Z → 25, AA → 26. */
const columnIndex = (letter: string): number =>
  [...letter.toUpperCase()].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;

const refusal = (cause: string, detail: string) => gcError('bad_request', { detail, cause });

/** Ячейка шапки глазами человека: адрес и текст — «C1 «Статус»». */
const cellOf = (column: ColumnProfile, map: SheetMap): string =>
  `${column.letter}${map.headerRow} «${column.name}»`;

/** Одно имя — одна колонка: две с одним именем делают адресацию по имени неоднозначной. */
const AMBIGUOUS = 'две колонки с одним именем сделали бы адресацию по имени неоднозначной';

/** Подписи без пробелов по краям: пустая и повторная (без учёта регистра) — отказ. */
function checkedLabels(columns: readonly string[]): string[] {
  const labels = columns.map((label) => label.trim());
  const blank = labels.indexOf('');
  if (blank !== -1) {
    throw refusal(
      'header_label_empty',
      `Подпись ${blank + 1} в columns пустая — одни пробелы. Ничего не записано: пустой подписью ` +
        'ячейку шапки не подписать — убери её или спроси человека, как назвать колонку.',
    );
  }
  const repeats = repeated(labels);
  if (repeats.length > 0) {
    throw refusal(
      'header_label_duplicate',
      `Подписи в columns повторяются (без учёта регистра): ${repeats.join(', ')}. Ничего не ` +
        `записано: ${AMBIGUOUS} — у каждой колонки своё имя.`,
    );
  }
  return labels;
}

/** Подписи, встреченные в списке не впервые, — первым написанием, без учёта регистра. */
function repeated(labels: readonly string[]): string[] {
  const first = new Map<string, string>();
  const out = new Set<string>();
  for (const label of labels) {
    const seen = first.get(label.toLowerCase());
    if (seen === undefined) first.set(label.toLowerCase(), label);
    else out.add(`«${seen}»`);
  }
  return [...out];
}

/** Занятая ячейка шапки — отказ со всеми занятыми: адрес и текст, а не перезапись. */
function assertEmpty(map: SheetMap, cells: readonly HeaderCell[]): void {
  const indexes = new Set(cells.map((cell) => cell.index));
  const taken = map.columns.filter((column) => indexes.has(column.index));
  if (taken.length === 0) return;
  throw refusal(
    'header_cell_occupied',
    `Ячейки шапки заняты: ${taken.map((column) => cellOf(column, map)).join(', ')} (лист ` +
      `«${map.sheet}», строка шапки ${map.headerRow}). Ничего не записано: setHeader подписывает ` +
      'только пустые ячейки, занятую не перезаписывает. Колонки шапки с буквами — в карте ' +
      '(gc_read mode=map): сдвинь startColumn к пустым ячейкам или спроси человека, что делать с ' +
      'занятыми.',
  );
}

/** Подпись, которая уже стоит в шапке (без учёта регистра), — отказ с её ячейкой. */
function assertNewLabels(map: SheetMap, cells: readonly HeaderCell[]): void {
  const clashes = cells.flatMap(({ label }) => {
    const same = map.columns.find((column) => column.name.toLowerCase() === label.toLowerCase());
    return same === undefined ? [] : [`«${label}» — уже ${cellOf(same, map)}`];
  });
  if (clashes.length === 0) return;
  throw refusal(
    'header_label_duplicate',
    `Подпись уже есть в шапке (без учёта регистра): ${clashes.join(', ')}. Ничего не записано: ` +
      `${AMBIGUOUS} — спроси человека, как назвать новую колонку.`,
  );
}

/** Колонка без подписи со значениями получает имя (Q40): ключ `(A)` ей больше не нужен. */
const keyNotes = (unlabeled: readonly ColumnProfile[], cells: readonly HeaderCell[]): string[] =>
  cells.flatMap(({ label, index }) => {
    const keyed = unlabeled.find((column) => column.index === index);
    return keyed === undefined
      ? []
      : [
          `${keyed.name} — колонка без подписи со значениями: после записи это колонка ` +
            `«${label}», ключ ${keyed.name} больше не нужен — пиши по имени`,
        ];
  });
