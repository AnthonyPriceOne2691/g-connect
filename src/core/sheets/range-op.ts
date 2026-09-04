/**
 * Перенос содержимого: копирование, вырезание, автозаполнение, дублирование листа
 * (§6.2 — Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+Shift+V, фаза 2.5b).
 *
 * Адресация та же, что во всём ядре: колонка по ИМЕНИ, строки по ключу. Произвольного
 * прямоугольника здесь нет намеренно — выделения в этом продукте не существует (§6.2), и
 * «вся колонка» это ответ проекта на Ctrl+C, а не упрощение.
 *
 * Форма отката у всех четырёх одна: снимок затронутого прямоугольника ДО правки. У
 * вырезания снимков два — источник и получатель, — поэтому журнал и хранит список.
 */

import { gcError } from '../errors.js';
import type { RangeSnapshot } from '../journal.js';
import { contextOf, finishWrite } from './commit.js';
import {
  anchorColumn,
  assertColumnStill,
  assertSnapshotBudget,
  columnAnchored,
  columnSnapshot,
  prepared,
} from './structure-support.js';
import { assertBeforeValues } from './write-guards.js';
import {
  columnLetter,
  type ColumnProfile,
  type DomainRange,
  type PasteKind,
  type SheetData,
  type SheetMap,
  type SheetsClient,
} from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions, StructuralPlan } from './write-types.js';

export interface RangeInput {
  /** Откуда: имя колонки-источника. */
  readonly column: string;
  /** Куда: имя колонки-получателя. Для автозаполнения не задаётся. */
  readonly toColumn?: string;
  /** Что переносить: всё, только значения или только вид. */
  readonly paste?: PasteKind;
}

/**
 * Копирование колонки в колонку (Ctrl+C / Ctrl+V, а с `paste: "values"` — Ctrl+Shift+V).
 *
 * Переносится тело колонки, без ячейки заголовка: имя колонки — это её identity, и
 * затирать его копией значит переименовать колонку, чего человек не просил. Заголовок
 * правится отдельно, `setCells` по строке шапки.
 */
export async function copyRange(
  client: SheetsClient,
  data: SheetData,
  input: RangeInput,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  return pasteOperation(client, data, input, options, 'copyRange');
}

/**
 * Вырезание: то же плюс очистка источника. Откат возвращает ОБА прямоугольника.
 *
 * Важное про `paste`, проверенное по документации Google: `cutPaste` вычищает источник
 * ЦЕЛИКОМ независимо от типа вставки. То есть с `paste: "values"` формат источника
 * исчезает и на получателе не появляется — чистая потеря, а не перенос. Поэтому при
 * `paste != "all"` план об этом говорит вслух, а не оставляет человека догадываться.
 */
export async function cutRange(
  client: SheetsClient,
  data: SheetData,
  input: RangeInput,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  return pasteOperation(client, data, input, options, 'cutRange');
}

async function pasteOperation(
  client: SheetsClient,
  data: SheetData,
  input: RangeInput,
  options: RowOptions,
  op: 'copyRange' | 'cutRange',
): Promise<ApplyOutcome> {
  const map = data.map;
  const pair = columnPair(map, input, options);
  if ('refusal' in pair) return pair.refusal;
  const { from, to } = pair;

  const rows = data.rows.length;
  if (rows === 0) {
    throw gcError('bad_request', { detail: 'На листе нет строк данных — переносить нечего.' });
  }
  const paste = input.paste ?? 'all';
  const source = bodyRange(map, from, rows);
  const destination = bodyRange(map, to, rows);
  // У вырезания в плане ДВА прямоугольника: получатель и опустошаемый источник. Живой
  // прогон 2026-09-04 показал, что источник в плане не виден вовсе — человек подтверждал
  // половину правки, не видя второй.
  const changes = [
    ...pasteChanges(map, data, from, to, rows),
    ...(op === 'cutRange' ? clearedChanges(map, data, from, rows) : []),
  ];
  // Снимков у вырезания два, но `changes` уже содержат обе стороны — умножать ещё раз
  // значило назвать человеку вдвое большее число (нашёл читатель без прогона).
  assertSnapshotBudget(changes.length);

  const cut = op === 'cutRange';
  const structural: StructuralPlan = {
    kind: op === 'cutRange' ? 'cutRange' : 'copyRange',
    sheet: map.sheet,
    count: rows,
    anchor: `колонка «${from.name}» → «${to.name}»`,
    ...(cut
      ? {
          confirmPhrase: `вырезаю колонку ${from.name} в ${to.name}`,
          confirmToken: from.name,
        }
      : {}),
  };
  // Снимок тела колонки — тем же помощником, что у удаления: гейт копипаста отклонил
  // вторую копию, и он прав, потому что расхождение видно только на откате.
  const body = (column: ColumnProfile): RangeSnapshot =>
    columnSnapshot(map, data, column.name, column.letter, { includeHeader: false });
  const snapshots = [body(to)];
  if (cut) snapshots.push(body(from));
  const notes = pasteNotes({ cut, paste, from, to, data });

  return finishWrite(client, contextOf(map), changes, prepared(notes), options, structural.kind, {
    structural,
    snapshots,
    // Предусловие D-17: у переноса `changes` уже несут «было», и не подключить сверку
    // значило обещать предусловие «у каждой записи» и не иметь его у половины операций.
    precondition: (c) => assertBeforeValues(c, map, changes),
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [
        {
          kind: cut ? 'cutPaste' : 'copyPaste',
          sheetId: map.sheetId,
          source,
          destination,
          paste,
        },
      ]),
  });
}

/**
 * Автозаполнение колонки вниз (§6.2). Образец — заполненная часть колонки, назначение —
 * пустой хвост до конца данных листа. Что именно Google экстраполирует — его дело: числа
 * продолжит рядом, текст размножит; поэтому план говорит «продолжит по образцу», а не
 * обещает конкретные значения.
 */
export async function autoFill(
  client: SheetsClient,
  data: SheetData,
  columnName: string,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const anchored = columnAnchored(data, columnName, options);
  if ('refusal' in anchored) return anchored.refusal;
  const { map, column } = anchored;
  const filled = data.rows.filter((row) => (row[column.name] ?? null) !== null).length;
  const total = data.rows.length;
  if (filled === 0 || filled >= total) {
    throw gcError('bad_request', {
      detail:
        `В колонке «${column.name}» заполнено ${filled} строк из ${total}: ` +
        (filled === 0 ? 'нет образца для продолжения.' : 'продолжать некуда.'),
      cause: 'nothing_to_fill',
    });
  }
  const source = { row: map.headerRow + 1, column: column.index, rowCount: filled, columnCount: 1 };
  const destination = {
    row: map.headerRow + 1 + filled,
    column: column.index,
    rowCount: total - filled,
    columnCount: 1,
  };
  assertSnapshotBudget(destination.rowCount);
  const structural: StructuralPlan = {
    kind: 'autoFill',
    sheet: map.sheet,
    at: destination.row,
    count: destination.rowCount,
    anchor: `колонка «${column.name}», образец из ${filled} строк`,
  };
  return finishWrite(client, contextOf(map), [], prepared(), options, 'autoFill', {
    structural,
    cells: destination.rowCount,
    snapshots: [emptyTailSnapshot(map, column, destination)],
    // Колонка-якорь всё ещё та же и на том же месте: между планом и записью её могли
    // переставить, и тогда автозаполнение поехало бы по чужому столбцу.
    precondition: (c) => assertColumnStill(c, map, column.name, column.index),
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [
        { kind: 'autoFill', sheetId: map.sheetId, source, destination },
      ]),
  });
}

/** Дублирование листа. Откат удаляет копию — если её не тронули (число ячеек то же). */
export async function duplicateSheet(
  client: SheetsClient,
  data: SheetData,
  title: string,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  if (title.trim().length === 0) {
    throw gcError('bad_request', { detail: 'Имя копии не может быть пустым.' });
  }
  const titles = await client.sheetTitles(map.spreadsheetId);
  if (titles.includes(title)) {
    throw gcError('bad_request', {
      detail:
        `Лист «${title}» в книге уже есть. Листы книги: ${titles.join(', ')}. ` +
        `Назови другое имя для копии — например «${title} 2».`,
      cause: 'sheet_title_taken',
    });
  }
  // Число НЕПУСТЫХ ячеек, а не строк: им откат проверяет, что копию не трогали.
  const book = await client.getSpreadsheet(map.spreadsheetId, { sheet: map.sheet });
  const source = book.sheets.find((s) => s.title === map.sheet);
  const cells = (source?.rows ?? []).flat().filter((cell) => (cell.value ?? null) !== null).length;
  const structural: StructuralPlan = {
    kind: 'duplicateSheet',
    sheet: map.sheet,
    title,
    count: cells,
  };
  return finishWrite(client, contextOf(map), [], prepared(), options, 'duplicateSheet', {
    structural,
    cells,
    apply: (c) =>
      c.batchUpdate(map.spreadsheetId, [{ kind: 'duplicateSheet', sheetId: map.sheetId, title }]),
  });
}

/** Тело колонки как прямоугольник: от первой строки данных до последней. */
function bodyRange(map: SheetMap, column: ColumnProfile, rows: number): DomainRange {
  return { row: map.headerRow + 1, column: column.index, rowCount: rows, columnCount: 1 };
}

/** Что исчезнет в источнике при вырезании: те же ячейки, но «значение → пусто». */
function clearedChanges(
  map: SheetMap,
  data: SheetData,
  from: ColumnProfile,
  rows: number,
): PlannedChange[] {
  return Array.from({ length: rows }, (_unused, index) => ({
    kind: 'set' as const,
    a1: `${map.sheet}!${from.letter}${map.headerRow + 1 + index}`,
    column: from.name,
    before: data.rows[index]?.[from.name] ?? null,
    after: null,
  }));
}

/** Что изменится в получателе: человек видит «было → станет» по каждой ячейке. */
function pasteChanges(
  map: SheetMap,
  data: SheetData,
  from: ColumnProfile,
  to: ColumnProfile,
  rows: number,
): PlannedChange[] {
  return Array.from({ length: rows }, (_unused, index) => ({
    kind: 'set' as const,
    a1: `${map.sheet}!${to.letter}${map.headerRow + 1 + index}`,
    column: to.name,
    before: data.rows[index]?.[to.name] ?? null,
    after: data.rows[index]?.[from.name] ?? null,
  }));
}

/**
 * Снимок пустого хвоста перед автозаполнением. Пустой — не значит ненужный: без него
 * откат не знал бы, до какой строки чистить, и оставил бы дописанное Google.
 */
function emptyTailSnapshot(
  map: SheetMap,
  column: ColumnProfile,
  destination: DomainRange,
): RangeSnapshot {
  const last = destination.row + destination.rowCount - 1;
  return {
    a1Range: `${map.sheet}!${column.letter}${destination.row}:${columnLetter(column.index)}${last}`,
    rows: Array.from({ length: destination.rowCount }, () => [{ value: null }]),
  };
}

/**
 * Обе колонки переноса: источник и получатель. Вынесено из операции по гейту сложности —
 * и по делу: «какие колонки» и «что с ними делать» разные вопросы, а отказов тут три.
 */
function columnPair(
  map: SheetMap,
  input: RangeInput,
  options: RowOptions,
): { from: ColumnProfile; to: ColumnProfile } | { refusal: ApplyOutcome } {
  const from = anchorColumn(map, input.column, options);
  if ('refusal' in from) return from;
  if (input.toColumn === undefined) {
    throw gcError('bad_request', { detail: 'Не сказано, в какую колонку переносить.' });
  }
  const to = anchorColumn(map, input.toColumn, options);
  if ('refusal' in to) return to;
  if (from.column.name === to.column.name) {
    throw gcError('bad_request', {
      detail: `Колонка «${from.column.name}» и источник, и получатель — переносить нечего.`,
    });
  }
  return { from: from.column, to: to.column };
}

/**
 * Перенос в колонку со списком допустимых значений.
 *
 * Правило `values.enum-ask` требует спрашивать про значение вне списка — но там речь про
 * значение, которое НАЗВАЛА модель. Здесь колонки называет человек, и отказ от переноса
 * всей колонки был бы отказом от операции целиком. Поэтому не вопрос, а громкая оговорка
 * с числом: названная непокрытость, найденная живым прогоном 2026-09-04.
 */
function enumWarning(to: ColumnProfile, data: SheetData, from: ColumnProfile): readonly string[] {
  const allowed = to.enumValues;
  if (allowed === null || allowed.length === 0) return [];
  const offending = data.rows
    .map((row) => row[from.name])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .filter((value) => !allowed.includes(value));
  if (offending.length === 0) return [];
  const unique = [...new Set(offending)];
  return [
    `У колонки «${to.name}» есть список допустимых значений (${allowed.join(', ')}), и ` +
      `${offending.length} переносимых значений в него не входят: ${unique.join(', ')}. ` +
      'Проверка данных таблицы их пометит или отклонит — скажи это человеку до подтверждения.',
  ];
}

/**
 * Оговорки переноса: что теряется и что не влезает в список допустимых.
 *
 * Вынесено из операции по гейту сложности — и по делу: «что произойдёт» и «о чём
 * предупредить» разные вопросы, а предупреждений тут два и оба нашлись живыми прогонами.
 */
function pasteNotes(input: {
  cut: boolean;
  paste: PasteKind;
  from: ColumnProfile;
  to: ColumnProfile;
  data: SheetData;
}): readonly string[] {
  const { cut, paste, from, to, data } = input;
  const lossy =
    cut && paste !== 'all'
      ? [
          `Вырезание вычищает источник целиком, а переносит только «${paste}»: ` +
            'остальное (вид, формулы) исчезнет и на получателе не появится. Откат вернёт.',
        ]
      : [];
  return [...lossy, ...enumWarning(to, data, from)];
}
