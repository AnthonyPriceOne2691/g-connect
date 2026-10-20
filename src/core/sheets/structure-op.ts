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
import { assertChangeBudget } from '../policy.js';
import type { RangeSnapshot, SnapshotCell } from '../journal.js';
import { contextOf, finishWrite } from './commit.js';
import { rowsUnderCondition } from './rows.js';
import {
  anchorText,
  assertAnchorRow,
  assertColumnStill,
  assertNamedRows,
  assertContiguous,
  columnAnchored,
  assertSnapshotBudget,
  columnSnapshot,
  rowChanges,
  snapshotOf,
  subjectOf,
  prepared,
} from './structure-support.js';
import { columnLetter, type CellValue } from './types.js';
import type { SheetData, SheetMap, SheetSnapshot, SheetsClient } from './types.js';
import type {
  ApplyOutcome,
  PlannedChange,
  RowOptions,
  RowValues,
  StructuralPlan,
} from './write-types.js';

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
  return finishWrite(client, contextOf(map), [], prepared(), options, 'insertRows', {
    structural,
    cells: count * Math.max(1, map.columns.length),
    apply: (c) => insertDimension(c, map, 'rows', at, count),
    precondition: (c) => assertAnchorRow(c, map, where, options, anchorRow),
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
  assertCount(count);
  const anchored = columnAnchored(data, columnName, options);
  if ('refusal' in anchored) return anchored.refusal;
  const { map, column } = anchored;
  const at = options.below === true ? column.index + 2 : column.index + 1;
  const structural: StructuralPlan = {
    kind: 'insertColumns',
    sheet: map.sheet,
    at,
    count,
    anchor: `колонка «${column.name}» (${column.letter})`,
  };
  return finishWrite(client, contextOf(map), [], prepared(), options, 'insertColumns', {
    structural,
    cells: count * Math.max(1, map.dataRowCount),
    apply: (c) => insertDimension(c, map, 'columns', at, count),
    precondition: (c) => assertColumnStill(c, map, column.name, column.index),
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
  await assertTitleUnused(client, map, title);
  const structural: StructuralPlan = { kind: 'addSheet', sheet: title, title };
  return finishWrite(client, contextOf(map), [], prepared(), options, 'addSheet', {
    structural,
    apply: (c) => c.batchUpdate(map.spreadsheetId, [{ kind: 'addSheet', title }]),
    precondition: (c) => assertTitleFree(c, map, title),
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
    return finishWrite(client, contextOf(map), [], prepared(), options, 'renameSheet', {});
  }
  await assertTitleUnused(client, map, title);
  const structural: StructuralPlan = {
    kind: 'renameSheet',
    sheet: map.sheet,
    title,
    previousTitle: map.sheet,
  };
  // Реестр держит цель за ИМЕНЕМ листа. Переименование его сносит, и молчать об этом
  // нельзя: следующий вызов по тому же алиасу уйдёт на лист, которого нет (найдено живым
  // прогоном 2026-09-04).
  const breaksTarget = options.registrySheet === map.sheet;
  const notes = breaksTarget
    ? [
        `Внимание: цель «${options.alias ?? 'из реестра'}» привязана в реестре к листу ` +
          `«${map.sheet}». После переименования привязка перестанет совпадать — поправь ` +
          'поле `sheet` у этой цели в реестре, иначе следующий вызов уйдёт на первый лист книги.',
      ]
    : [];
  return finishWrite(client, contextOf(map), [], prepared(notes), options, 'renameSheet', {
    structural,
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [{ kind: 'renameSheet', sheetId: map.sheetId, title }]),
    precondition: (c) => assertTitleFree(c, map, title),
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

/**
 * Сколько вставляем: ноль — не правка, отрицательное — не операция, а слишком много судит
 * ПРАВИЛО, а не схема транспорта.
 *
 * Живой прогон 2026-09-04: `count: 500` отказывал текстом схемы («Number must be less than
 * or equal to 200») без имени правила, хотя и спека, и проба правила обещают
 * `policy_denied` с числом. Схема осталась внешней границей, но судит здесь правило.
 */
function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw gcError('bad_request', {
      detail: `Сколько строк или колонок вставить — целое число больше нуля, а не ${count}.`,
    });
  }
  assertChangeBudget(count);
}

function assertTitle(title: string): void {
  if (title.trim().length > 0) return;
  throw gcError('bad_request', { detail: 'Имя листа не может быть пустым.' });
}

/**
 * Имена листов в книге уникальны: коллизия — не догадка, а отказ со списком И с
 * предложением, что делать.
 *
 * Спрашивает КНИГУ, а не карту: карта строится из усечённого снимка, и её `otherSheets`
 * пуст даже когда листов семь (живой прогон 2026-09-04). Цена — один дешёвый вызов без
 * сетки.
 */
async function assertTitleUnused(
  client: SheetsClient,
  map: SheetMap,
  title: string,
): Promise<void> {
  const titles = (await client.sheetTitles(map.spreadsheetId)).map((s) => s.title);
  if (!titles.includes(title)) return;
  const free = `${title} 2`;
  throw gcError('bad_request', {
    detail:
      `Лист «${title}» в книге уже есть. Листы книги: ${titles.join(', ')}. ` +
      `Назови другое имя — например «${titles.includes(free) ? `${title} (копия)` : free}».`,
    cause: 'sheet_title_taken',
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
 * Удаление строк по якорю (§6.2). Первая операция поставки, которая УНИЧТОЖАЕТ данные,
 * и поэтому у неё три вещи, которых нет у вставки:
 *
 * 1. **Снимок** — значения и вид всех ячеек строки: без него откат вернёт пустую строку,
 *    то есть отчитается успехом, не вернув ничего.
 * 2. **Бюджет** (`write.snapshot-max-cells`): снимок, который не влезает, — это отказ ДО
 *    записи, а не запись без возможности вернуть.
 * 3. **Подтверждение названием** (D-20): человек произносит «удаляю строку X», а не «да».
 */
export async function deleteRows(
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertNamedRows(where, 'Удаление строк');
  const selected = rowsUnderCondition(
    data,
    where,
    options,
    'Под условие не подошла ни одна строка — удалять нечего.',
  );
  if ('refusal' in selected) return selected.refusal;
  const rows = [...selected.rows].sort((a, b) => a - b);
  assertContiguous(rows);
  const at = rows[0]!;
  const count = rows.length;
  const subject = subjectOf(where);
  const changes = rowChanges(data, rows);
  assertSnapshotBudget(changes.length);
  const structural: StructuralPlan = {
    kind: 'deleteRows',
    sheet: map.sheet,
    at,
    count,
    anchor: `строка, где ${anchorText(where)}`,
    confirmPhrase: `удаляю ${count === 1 ? 'строку' : `строки (${count})`} ${subject}`,
    confirmToken: subject,
  };
  return finishWrite(client, contextOf(map), changes, prepared(), options, 'deleteRows', {
    structural,
    snapshots: [snapshotOf(map, data, rows)],
    apply: (c) => deleteDimension(c, map, 'rows', at, count),
    precondition: (c) => assertAnchorRow(c, map, where, options, at),
  });
}

/** Удаление колонки по имени. Тот же контур, что у строк: снимок, бюджет, название. */
export async function deleteColumns(
  client: SheetsClient,
  data: SheetData,
  columnName: string,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const anchored = columnAnchored(data, columnName, options);
  if ('refusal' in anchored) return anchored.refusal;
  const { map, column } = anchored;
  const at = column.index + 1;
  const changes: PlannedChange[] = data.rows.map((row, index) => ({
    kind: 'set',
    a1: `${map.sheet}!${column.letter}${map.headerRow + 1 + index}`,
    column: column.name,
    before: row[column.name] ?? null,
    after: null,
  }));
  assertSnapshotBudget(changes.length);
  const structural: StructuralPlan = {
    kind: 'deleteColumns',
    sheet: map.sheet,
    at,
    count: 1,
    anchor: `колонка «${column.name}» (${column.letter})`,
    confirmPhrase: `удаляю колонку ${column.name}`,
    confirmToken: column.name,
  };
  return finishWrite(client, contextOf(map), changes, prepared(), options, 'deleteColumns', {
    structural,
    snapshots: [
      columnSnapshot(map, data, column.name, column.letter, {
        aboveHeader: await aboveHeaderCells(client, map, column.index),
      }),
    ],
    apply: (c) => deleteDimension(c, map, 'columns', at, 1),
    precondition: (c) => assertColumnStill(c, map, column.name, column.index),
  });
}

function deleteDimension(
  client: SheetsClient,
  map: SheetMap,
  dimension: 'rows' | 'columns',
  at: number,
  count: number,
): Promise<void> {
  return client.batchUpdate(map.spreadsheetId, [
    { kind: 'deleteDimension', sheetId: map.sheetId, dimension, at, count },
  ]);
}

/**
 * Удаление листа (решение владельца 2026-09-03: делать, несмотря на неполный откат).
 *
 * Единственная операция поставки, чей откат вернёт НЕ ВСЁ, и поэтому единственная, где
 * план обязан назвать потерю числом. Вернётся: значения, вид ячеек и модельные свойства
 * листа (закрепления, цвет ярлыка, скрытость). Не вернётся: условное форматирование,
 * проверки данных, защищённые диапазоны, диаграммы, фильтры — они считаются и
 * перечисляются В ПЛАНЕ, до записи, а не выясняются после отката.
 *
 * Читает книгу отдельно: снимок листа нужен ЦЕЛИКОМ, включая строки над шапкой, которых в
 * `SheetData` нет по построению. Цена названа — одно дополнительное чтение на операцию.
 */
export async function deleteSheet(
  client: SheetsClient,
  data: SheetData,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  // Дешёвая оценка ДО полного чтения книги: у владельца лист — это 3800 ячеек, а книга
  // ~28 000, и отказ по бюджету не должен стоить дорогого чтения. Живой прогон 2026-09-04
  // получил на этом вызове 11–15 секунд, а один раз и вовсе таймаут.
  assertSnapshotBudget(map.dataRowCount * Math.max(1, map.columns.length), { estimate: true });
  const book = await client.getSpreadsheet(map.spreadsheetId);
  if (book.sheets.length <= 1) {
    throw gcError('bad_request', {
      detail: `«${map.sheet}» — единственный лист книги, а книги без листов не бывает.`,
      cause: 'last_sheet',
    });
  }
  const sheet = book.sheets.find((s) => s.title === map.sheet);
  if (sheet === undefined) {
    throw gcError('not_found', { detail: `Листа «${map.sheet}» в книге нет.` });
  }
  const cells = sheet.rows.reduce((sum, row) => sum + row.length, 0);
  assertSnapshotBudget(cells);
  const structural: StructuralPlan = {
    kind: 'deleteSheet',
    sheet: map.sheet,
    count: cells,
    ...(sheet.properties === undefined ? {} : { properties: sheet.properties }),
    irreversible: lostWith(sheet),
    confirmPhrase: `удаляю лист ${map.sheet}`,
    confirmToken: map.sheet,
  };
  return finishWrite(client, contextOf(map), [], prepared(), options, 'deleteSheet', {
    structural,
    snapshots: [sheetSnapshotOf(map.sheet, sheet)],
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [{ kind: 'deleteSheet', sheetId: sheet.sheetId }]),
    precondition: (c) => assertSheetStill(c, map.spreadsheetId, map.sheet),
  });
}

/** Что исчезнет безвозвратно — числом, а не признаком. Пусто — тоже утверждение. */
function lostWith(sheet: SheetSnapshot): readonly string[] {
  const extras = sheet.extras;
  if (extras === undefined) return [];
  const named: [number, string][] = [
    [extras.conditionalFormats, 'правил условного форматирования'],
    [extras.dataValidations, 'проверок данных в ячейках'],
    [extras.protectedRanges, 'защищённых диапазонов'],
    [extras.charts, 'диаграмм'],
    [extras.filters, 'фильтров'],
  ];
  const lost = named.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
  // Заметки к ячейкам ядро не читает вовсе, поэтому и не обещает вернуть: непокрытость
  // названа здесь, а не спрятана в «прочее».
  if (lost.length > 0) lost.push('плюс заметки к ячейкам, если они есть: ядро их не читает');
  // Потери ЗА ПРЕДЕЛАМИ листа в его полях не видны, а человек их заметит первым: формулы
  // с других листов станут `#REF!`, именованные диапазоны и диаграммы, смотревшие сюда,
  // осиротеют. Числа тут нет и врать его нельзя — названо словами.
  lost.push(
    'плюс то, что смотрело на этот лист снаружи: формулы других листов станут #REF!, ' +
      'именованные диапазоны и диаграммы на него — осиротеют',
  );
  return lost;
}

/** Снимок всего листа: строки от первой, а не от шапки — восстанавливать надо всё. */
function sheetSnapshotOf(title: string, sheet: SheetSnapshot): RangeSnapshot {
  const width = Math.max(1, ...sheet.rows.map((row) => row.length));
  return {
    a1Range: `${title}!A1:${columnLetter(width - 1)}${Math.max(1, sheet.rows.length)}`,
    rows: sheet.rows.map((row) =>
      row.map((cell): SnapshotCell => ({
        value: cell.value,
        ...(cell.format === undefined ? {} : { format: cell.format }),
      })),
    ),
  };
}

/** Лист всё ещё на месте: между планом и записью его мог удалить другой. */
async function assertSheetStill(
  client: SheetsClient,
  targetId: string,
  title: string,
): Promise<void> {
  const book = await client.getSpreadsheet(targetId);
  if (book.sheets.some((s) => s.title === title)) return;
  throw gcError('stale_value', {
    detail: `Лист «${title}» исчез после построения плана. Правка не выполнена.`,
    cause: 'anchor_moved',
  });
}

/**
 * Ячейки колонки НАД строкой шапки: их в `SheetData` нет по построению, а терять их
 * нельзя — обещание «откат вернёт значения и вид» не делает исключений для заголовка
 * отчёта над таблицей.
 */
async function aboveHeaderCells(
  client: SheetsClient,
  map: SheetMap,
  columnIndex: number,
): Promise<readonly CellValue[]> {
  if (map.headerRow <= 1) return [];
  const book = await client.getSpreadsheet(map.spreadsheetId, { sheet: map.sheet });
  const sheet = book.sheets.find((s) => s.title === map.sheet);
  const rows = (sheet?.rows ?? []).slice(0, map.headerRow - 1);
  return rows.map((row) => row[columnIndex]?.value ?? null);
}
