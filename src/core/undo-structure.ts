/**
 * Откат правки геометрии (D-19): обратная структурная операция плюс снимок.
 *
 * Отдельным модулем от `undo.ts` по гейту длины — и по делу: там откат отвечает на «в
 * ячейках всё ещё наше?», а здесь на «как вернуть то, чего нет». Это разные вопросы, и
 * охранники у них разные: значение сверяется с записанным, а вставленное — проверяется на
 * пустоту, потому что человек мог успеть туда написать.
 */

import { gcError } from './errors.js';
import type { WriteRecord } from './journal.js';
import { parseA1 } from './sheets/a1.js';
import {
  columnLetter,
  type SheetRequest,
  type SheetSnapshot,
  type SheetsClient,
  type SpreadsheetSnapshot,
} from './sheets/types.js';
import type { UndoOptions, UndoOutcome } from './undo-types.js';

/**
 * Откат правки геометрии (D-19): обратная структурная операция.
 *
 * Снимок здесь ещё не нужен — эта половина поставки про позиционные правки, где терять
 * нечего: вставленное удаляется, имя возвращается. Но охранник нужен ровно поэтому:
 * вставленную строку человек мог успеть ЗАПОЛНИТЬ, и тогда «просто удалить вставленное»
 * уничтожит его работу. Пустое удаляем, непустое — отказ с причиной (G4).
 */
export async function undoStructure(
  client: SheetsClient,
  targetId: string,
  record: WriteRecord,
  options: UndoOptions,
  journal: (record: WriteRecord, targetId: string, options: UndoOptions) => Promise<void>,
): Promise<UndoOutcome> {
  const structure = record.structure;
  if (structure === undefined) throw gcError('internal', { detail: 'Запись без геометрии.' });
  const book = await client.getSpreadsheet(targetId);
  const request = inverseOf(book, structure, options);
  await client.batchUpdate(targetId, [request]);
  // Геометрию вернули — теперь возвращаем содержимое. Порядок обязателен: залить снимок
  // в ещё не существующие строки нельзя, а вернуть строки без снимка значит вернуть
  // пустые (то есть отчитаться успехом, не вернув ничего).
  //
  // Книга перечитывается ПОСЛЕ обратной операции: у пересозданного листа новый sheetId,
  // и вид пришлось бы возвращать по устаревшему адресу — молча в чужой лист.
  const after = await client.getSpreadsheet(targetId);
  const restored = await restoreSnapshot(client, targetId, after, record);
  await journal(record, targetId, options);
  return {
    status: 'ok',
    restored,
    undoneCorrelationId: record.correlationId,
    at: record.at,
    structureUndone: undoneText(structure),
    ...(structure.irreversible === undefined ? {} : { notRestored: structure.irreversible }),
  };
}

/** Обратная операция и охранник к ней. Одна функция: обратная правка и её условие связаны. */
function inverseOf(
  book: SpreadsheetSnapshot,
  structure: NonNullable<WriteRecord['structure']>,
  options: UndoOptions,
): SheetRequest {
  const build = INVERSE[structure.kind];
  if (build === undefined) {
    // Перемещение и сортировка приедут со своими снимками (слайсы 6-7). Пока такой
    // записи в журнале появиться негде, но молчать об этом нельзя.
    throw gcError('bad_request', {
      detail: `Откат правки «${structure.kind}» ещё не построен: такие операции пока не пишутся.`,
      cause: 'undo_not_built',
    });
  }
  return build(book, structure, options);
}

/**
 * Обратная операция по форме правки. Таблица, а не цепочка ветвей: гейт сложности
 * отклонил четырнадцать путей в одной функции, и он прав — здесь не логика, а
 * соответствие «что сделали → чем вернуть», и отсутствие ключа означает «ещё не построено».
 */
type Inverse = (
  book: SpreadsheetSnapshot,
  structure: NonNullable<WriteRecord['structure']>,
  options: UndoOptions,
) => SheetRequest;

const INVERSE: Partial<Record<NonNullable<WriteRecord['structure']>['kind'], Inverse>> = {
  insertRows: (book, structure, options) => removeInserted(book, structure, options, 'rows'),
  insertColumns: (book, structure, options) => removeInserted(book, structure, options, 'columns'),
  // Удаление откатывается вставкой на то же место; содержимое заливает `restoreSnapshot`.
  deleteRows: (book, structure) => reinsert(book, structure, 'rows'),
  deleteColumns: (book, structure) => reinsert(book, structure, 'columns'),
  // Лист возвращается со своими свойствами: закрепления, цвет ярлыка, скрытость. Всё
  // остальное перечислено в `irreversible` и названо человеку ещё в плане.
  deleteSheet: (book, structure) => {
    if (book.sheets.some((s) => s.title === structure.sheet)) {
      throw gcError('revision_conflict', {
        detail: `Лист «${structure.sheet}» уже есть в книге — откат создал бы второй с тем же именем.`,
        cause: 'sheet_exists',
      });
    }
    return {
      kind: 'addSheet',
      title: structure.sheet,
      ...(structure.properties === undefined ? {} : { properties: structure.properties }),
    };
  },
  addSheet: (book, structure, options) => {
    const sheet = sheetByTitle(book, structure.title ?? structure.sheet);
    if (options.force !== true) assertSheetEmpty(sheet);
    return { kind: 'deleteSheet', sheetId: sheet.sheetId };
  },
  renameSheet: (book, structure) => ({
    kind: 'renameSheet',
    sheetId: sheetByTitle(book, structure.title ?? structure.sheet).sheetId,
    title: structure.previousTitle ?? structure.sheet,
  }),
};

/** Вернуть удалённое место: строки или колонки на прежнюю позицию. */
function reinsert(
  book: SpreadsheetSnapshot,
  structure: NonNullable<WriteRecord['structure']>,
  dimension: 'rows' | 'columns',
): SheetRequest {
  return {
    kind: 'insertDimension',
    sheetId: sheetByTitle(book, structure.sheet).sheetId,
    dimension,
    at: structure.at ?? 1,
    count: structure.count ?? 1,
  };
}

/**
 * Залить снимок обратно: значения через values-API, вид — через `batchUpdate`.
 *
 * Названная непокрытость: строки возвращаются на ТУ ЖЕ позицию, что была записана. Если
 * лист с тех пор сдвинули, они вернутся к другим соседям — поэтому откат без явного id
 * работает только на свежих записях (`assertRecent`), а не «когда-нибудь потом».
 */
async function restoreSnapshot(
  client: SheetsClient,
  targetId: string,
  book: SpreadsheetSnapshot,
  record: WriteRecord,
): Promise<UndoOutcome['restored']> {
  const snapshots = record.snapshots ?? [];
  const restored: { a1: string; column: string; value: string | number | boolean | null }[] = [];
  for (const snapshot of snapshots) {
    restored.push(...(await restoreOne(client, targetId, book, snapshot)));
  }
  return restored;
}

/** Один диапазон обратно: значения через values-API, вид — через `batchUpdate`. */
async function restoreOne(
  client: SheetsClient,
  targetId: string,
  book: SpreadsheetSnapshot,
  snapshot: NonNullable<WriteRecord['snapshots']>[number],
): Promise<UndoOutcome['restored']> {
  const parsed = parseRange(snapshot.a1Range);
  const sheetId = book.sheets.find((s) => s.title === parsed.sheet)?.sheetId ?? 0;
  const restored: { a1: string; column: string; value: string | number | boolean | null }[] = [];
  const formats: SheetRequest[] = [];
  for (const [rowOffset, row] of snapshot.rows.entries()) {
    for (const [columnOffset, cell] of row.entries()) {
      const rowNumber = parsed.row + rowOffset;
      const columnIndex = parsed.column + columnOffset;
      const a1 = `${parsed.sheet}!${columnLetter(columnIndex)}${rowNumber}`;
      await client.updateValues(targetId, a1, [[cell.value]]);
      if (cell.format !== undefined) {
        formats.push({
          kind: 'format',
          sheetId,
          row: rowNumber,
          column: columnIndex,
          format: cell.format,
        });
      }
      restored.push({ a1, column: columnLetter(columnIndex), value: cell.value });
    }
  }
  if (formats.length > 0) await client.batchUpdate(targetId, formats);
  return restored;
}

/** `Лист!B3:D4` → лист, первая строка, первая колонка. Правый край для заливки не нужен. */
function parseRange(range: string): { sheet: string; row: number; column: number } {
  const match = /^(.+)!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/.exec(range);
  const parsed = match === null ? null : parseA1(`${match[1]}!${match[2]}${match[3]}`);
  if (match === null || parsed === null) {
    throw gcError('internal', { detail: `В журнале нечитаемый диапазон ${range}.` });
  }
  return { sheet: match[1]!, row: parsed.row, column: parsed.column };
}

function sheetByTitle(book: SpreadsheetSnapshot, title: string): SheetSnapshot {
  const sheet = book.sheets.find((s) => s.title === title);
  if (sheet !== undefined) return sheet;
  throw gcError('revision_conflict', {
    detail: `Листа «${title}» в книге больше нет — откатывать нечего, перечитай документ.`,
    cause: 'sheet_gone',
  });
}

/** Вставленное всё ещё пусто? Иначе откат удалил бы то, что человек туда написал. */
function assertInsertedEmpty(
  sheet: SheetSnapshot,
  dimension: 'rows' | 'columns',
  structure: NonNullable<WriteRecord['structure']>,
): void {
  const start = (structure.at ?? 1) - 1;
  const count = structure.count ?? 1;
  const cells =
    dimension === 'rows'
      ? sheet.rows.slice(start, start + count).flat()
      : sheet.rows.flatMap((row) => row.slice(start, start + count));
  const filled = cells.filter((cell) => cell !== undefined && !isBlank(cell));
  if (filled.length === 0) return;
  throw gcError('revision_conflict', {
    detail:
      `Во вставленное после записи что-то написали (${filled.length} ` +
      'непустых ячеек). Откат удалил бы эти данные, поэтому не выполнен: перечитай и реши, ' +
      'что вернуть. Если удалить всё равно — откат с force.',
    cause: 'inserted_not_empty',
  });
}

/** Лист, созданный нами, всё ещё пуст? Удалять заполненный людьми лист откат не вправе. */
function assertSheetEmpty(sheet: SheetSnapshot): void {
  const filled = sheet.rows.flat().filter((cell) => cell !== undefined && !isBlank(cell));
  if (filled.length === 0) return;
  throw gcError('revision_conflict', {
    detail:
      `На листе «${sheet.title}» после создания появились данные (${filled.length} ` +
      'непустых ячеек). Откат удалил бы лист вместе с ними, поэтому не выполнен.',
    cause: 'sheet_not_empty',
  });
}

const isBlank = (cell: { value: unknown; formula?: string }): boolean =>
  (cell.value === null || cell.value === '') && cell.formula === undefined;

/**
 * Что сказать человеку про откат геометрии. Текст, а не ветвление на стороне клиента —
 * и тоже таблицей: у каждой формы своя фраза, и «вернулось со значениями и видом» это
 * утверждение, которое человек обязан прочитать (урок L5).
 */
function undoneText(structure: NonNullable<WriteRecord['structure']>): string {
  const at = structure.at ?? 1;
  const count = structure.count ?? 1;
  const title = structure.title ?? structure.sheet;
  const texts: Partial<Record<NonNullable<WriteRecord['structure']>['kind'], string>> = {
    insertRows: `Вставленные строки удалены: ${count} шт. начиная с ${at}-й.`,
    insertColumns: `Вставленные колонки удалены: ${count} шт. начиная с ${at}-й.`,
    addSheet: `Лист «${title}» удалён — он был пуст.`,
    deleteRows: `Удалённые строки возвращены на место: ${count} шт. с ${at}-й, со значениями и видом.`,
    deleteColumns: `Удалённая колонка возвращена на место (${at}-я), со значениями и видом.`,
    renameSheet: `Лист переименован обратно: «${title}» → «${structure.previousTitle ?? ''}».`,
    deleteSheet:
      `Лист «${structure.sheet}» создан заново: значения, вид ячеек и свойства листа ` +
      'на месте. Что не вернулось — в notRestored.',
  };
  return texts[structure.kind] ?? `Правка «${structure.kind}» откачена.`;
}

/** Удалить вставленное — с охранником «оно ещё пусто». Одна форма на строки и колонки. */
function removeInserted(
  book: SpreadsheetSnapshot,
  structure: NonNullable<WriteRecord['structure']>,
  options: UndoOptions,
  dimension: 'rows' | 'columns',
): SheetRequest {
  const sheet = sheetByTitle(book, structure.sheet);
  if (options.force !== true) assertInsertedEmpty(sheet, dimension, structure);
  return {
    kind: 'deleteDimension',
    sheetId: sheet.sheetId,
    dimension,
    at: structure.at ?? 1,
    count: structure.count ?? 1,
  };
}
