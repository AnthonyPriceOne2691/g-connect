/**
 * Охранники ячеек записи — по месту, куда ляжет правка, а не по колонке целиком (хотфикс 16.11,
 * лист из нескольких таблиц): формула в ячейке записи или строкой выше и дозапись в единственную
 * пустую строку перед следующей таблицей. Своим модулем по гейту длины `rows.ts`.
 */

import { gcError } from '../errors.js';
import type { Prepared } from './commit.js';
import type { ColumnProfile, SheetData, SheetMap } from './types.js';
import type { RowOptions } from './write-types.js';

/** Где пишет правка: номера строк листа; `match` — поиск строк по условию, записи нет. */
export type WriteRows = readonly number[] | 'match';

/**
 * Формульная и защищённая колонка: отметить в плане и не пустить без `force`.
 *
 * Отметка уезжает в код плана (D-16) — подтверждая код, человек подтверждает и то, что
 * правка лезет в такую колонку. Раньше `force` был решением одной модели.
 *
 * Формулы судятся у ячеек записи (`local`), а не по колонке целиком (хотфикс 16.11, весть сессии
 * профиля work): на листе из нескольких таблиц формулы блока итогов ниже запрещали пустые ячейки
 * ввода над ним. Без `local` — колонка целиком, как раньше (вид ячеек).
 */
export function guardColumn(
  column: ColumnProfile,
  out: Prepared,
  options: RowOptions,
  local?: { readonly data: SheetData; readonly rows: readonly number[] },
): void {
  const formula = formulaHere(column, local);
  markTouches(column, out, formula);
  if (!formula && !column.protected) return;
  if (options.force === true) return;
  throw blocked(column, formula);
}

/** Формула там, куда пишем: у ячеек записи (`local`) или, без них, где угодно в колонке. */
function formulaHere(
  column: ColumnProfile,
  local: { readonly data: SheetData; readonly rows: readonly number[] } | undefined,
): boolean {
  if (!column.hasFormula) return false;
  return local === undefined || formulaAtOrAbove(column, local.data, local.rows);
}

/** Отметки плана — в код плана (D-16); формулы в других строках — заметкой, а не отметкой. */
function markTouches(column: ColumnProfile, out: Prepared, formula: boolean): void {
  if (column.hasFormula && !formula) out.notes.push(otherFormulasNote(column));
  if (formula && !out.touches.includes('formula')) out.touches.push('formula');
  if (column.protected && !out.touches.includes('protected')) out.touches.push('protected');
}

const blocked = (column: ColumnProfile, formula: boolean) =>
  gcError('write_blocked', {
    detail: formula
      ? `Колонка «${column.name}» содержит формулы — запись значения их затрёт.`
      : `Колонка «${column.name}» в защищённом диапазоне.`,
    cause: formula ? 'formula_column' : 'protected_range',
  });

/**
 * Формула там, куда пишем: в самой ячейке или прямо над ней в той же колонке — так выглядит
 * формульная колонка у ячейки записи. Строку ниже не смотрим: под ячейками ввода обычно стоит
 * «Итого» с формулой, и колонку ввода она формульной не делает. Шапка — не строка данных.
 */
function formulaAtOrAbove(
  column: ColumnProfile,
  data: SheetData,
  rows: readonly number[],
): boolean {
  const first = data.map.headerRow + 1;
  return rows.some((row) =>
    [row, row - 1].some(
      (at) => at >= first && data.cells[at - first]?.[column.index]?.formula !== undefined,
    ),
  );
}

const otherFormulasNote = (column: ColumnProfile): string =>
  `В колонке «${column.name}» формулы есть в других строках — у ячеек записи и строк над ними ` +
  'формул нет, запись их не затрагивает';

/**
 * Дозапись не занимает единственную пустую строку перед следующей таблицей листа (§9.3): блоки
 * слились бы, и граница пропала бы вместе с разделителем — следующая карта снова считала бы
 * данными шапки всё до конца листа.
 */
export function assertBlockGap(map: SheetMap, rowNumber: number): void {
  const next = map.nextTable;
  if (next === undefined || next.blankRows >= 2) return;
  throw gcError('bad_request', {
    cause: 'block_gap',
    detail:
      `Ниже блока — другая таблица (шапка в строке ${next.headerRow}), а между ними одна пустая ` +
      `строка ${rowNumber}: дописанная строка заняла бы разделитель. Ничего не записано. Вставь ` +
      `строку под последней строкой блока — insertRows с where по ней, below: true и likeRow: ` +
      `${rowNumber - 1}, — и повтори appendRow.`,
  });
}
