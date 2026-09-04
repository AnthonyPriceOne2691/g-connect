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
import { parseA1, sameCell, valueAt } from './sheets/a1.js';
import { inverseMove } from './sheets/move-math.js';
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
  // Создание файла откатывается не в таблице, а в Drive: обратная операция — корзина.
  if (structure.kind === 'createFile')
    return undoCreate(record, structure, options, journal, targetId);
  const book = await client.getSpreadsheet(targetId);

  // Наши ли ещё ячейки. Живой прогон этого не увидел, а читатель без прогона увидел:
  // структурный откат уходил в обход `assertSafeToUndo`, и заливка снимка поверх чужой
  // правки шла молча. Проверяем там, где есть чем: у копирования, вырезания и удалений в
  // записи лежат ячейки с тем, что мы написали.
  if (options.force !== true) assertOursStill(book, record);
  // Перенос содержимого (копирование, вырезание, автозаполнение) откатывается ОДНИМ
  // снимком: геометрия там не менялась, менялось наполнение прямоугольника. Обратной
  // структурной операции для них нет и быть не должно — «отменить вставку» это и есть
  // «вернуть то, что было в получателе».
  if (!SNAPSHOT_ONLY.has(structure.kind)) {
    const request = inverseOf(book, structure, options);
    await client.batchUpdate(targetId, [request]);
  }
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
    ...(UNVERIFIABLE.has(structure.kind)
      ? {
          notRestored: [
            ...(structure.irreversible ?? []),
            'проверить, что после нашей правки в этот диапазон никто не писал, ядру нечем: ' +
              'у перемещения, сортировки и автозаполнения нет ячеек в записи. Поэтому такой ' +
              'откат работает только на свежих записях',
          ],
        }
      : {}),
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
 * Формы, у которых сверить «в ячейках всё ещё наше» нечем: в записи нет ячеек с тем, что
 * мы написали. Названная непокрытость, а не забытая проверка.
 */
const UNVERIFIABLE: ReadonlySet<NonNullable<WriteRecord['structure']>['kind']> = new Set([
  'moveRows',
  'sortRange',
  'autoFill',
]);

/** Формы, у которых обратной структурной операции нет: откат — это заливка снимка. */
const SNAPSHOT_ONLY: ReadonlySet<NonNullable<WriteRecord['structure']>['kind']> = new Set([
  'copyRange',
  'cutRange',
  'autoFill',
  // Сортировку обратной операцией не отменить: она не помнит, откуда приехала строка.
  'sortRange',
]);

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
  // Копия листа удаляется, если её не тронули: непустых ячеек столько же, сколько было
  // при создании. Названная непокрытость: правку, не изменившую ЧИСЛО ячеек, охранник не
  // заметит — он сторожит «копию заполнили», а не «в копии поправили слово».
  duplicateSheet: (book, structure, options) => {
    const copy = sheetByTitle(book, structure.title ?? structure.sheet);
    const cells = copy.rows.flat().filter((cell) => (cell.value ?? null) !== null).length;
    if (options.force !== true && cells !== (structure.count ?? cells)) {
      throw gcError('revision_conflict', {
        detail:
          `В копии «${copy.title}» было ${structure.count ?? 0} непустых ячеек, сейчас ` +
          `${cells}: её правили после создания. Откат удалил бы лист вместе с этой работой.`,
        cause: 'copy_changed',
      });
    }
    return { kind: 'deleteSheet', sheetId: copy.sheetId };
  },
  // Перемещение возвращается перемещением, но НЕ «туда, откуда взяли»: индекс назначения
  // у Google считается по координатам до удаления блока, и наивный обратный ход
  // промахивается на размер блока. Формула — в `move-math.ts`, с оракулом на числах.
  moveRows: (book, structure) => {
    const at = (structure.at ?? 1) - 1;
    const count = structure.count ?? 1;
    const back = inverseMove(at, count, structure.to ?? at);
    return {
      kind: 'moveDimension',
      sheetId: sheetByTitle(book, structure.sheet).sheetId,
      dimension: 'rows',
      at: back.from + 1,
      count,
      destinationIndex: back.to,
    };
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
  const restored: UndoOutcome['restored'][number][] = [];
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
  const restored: UndoOutcome['restored'][number][] = [];
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
      restored.push({
        a1,
        column: columnLetter(columnIndex),
        kind: cell.format === undefined ? 'value' : 'value+format',
        value: cell.value,
        ...(cell.format === undefined ? {} : { format: cell.format }),
      });
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
    copyRange: `Колонка-получатель возвращена к прежним значениям и виду (${count} строк).`,
    cutRange: `Возвращены обе колонки: и та, из которой вырезали, и та, в которую вставили (${count} строк).`,
    autoFill: `Автозаполнение снято: ${count} строк снова пусты, как было до правки.`,
    duplicateSheet: `Копия листа «${title}» удалена — её не правили после создания.`,
    moveRows: `Перемещённые строки вернулись на прежнее место: ${count} шт. с ${at}-й.`,
    sortRange: `Порядок строк восстановлен из снимка: ${count} строк, со значениями и видом.`,
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

/**
 * Откат создания файла: в корзину Drive.
 *
 * Единственная форма отката, которая нам не принадлежит целиком: из корзины файл достаёт
 * человек сам, в интерфейсе Drive. Поэтому ответ говорит это прямо, а не «удалено» —
 * «удалено» человек прочитает как «насовсем», и будет неправ в обе стороны.
 */
async function undoCreate(
  record: WriteRecord,
  structure: NonNullable<WriteRecord['structure']>,
  options: UndoOptions,
  journal: (record: WriteRecord, targetId: string, options: UndoOptions) => Promise<void>,
  targetId: string,
): Promise<UndoOutcome> {
  const fileId = structure.fileId;
  if (fileId === undefined) {
    throw gcError('internal', {
      detail: 'В записи о создании файла нет его id — откатывать нечем.',
    });
  }
  if (options.trash === undefined) {
    throw gcError('bad_request', {
      detail:
        'Откат создания файла требует доступа к Drive, а этот вызов его не получил. ' +
        'Отправь файл в корзину руками либо повтори откат из клиента с полным доступом.',
      cause: 'trash_unavailable',
    });
  }
  await options.trash(fileId);
  await journal(record, targetId, options);
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    structureUndone:
      `Файл «${structure.title ?? structure.sheet}» отправлен в корзину Drive. ` +
      'Достать его оттуда можно только руками, в интерфейсе Drive — насовсем он не удалён.',
    notRestored: ['содержимое файла, если человек успел в него что-то написать'],
  };
}

/**
 * Сверка «в ячейках всё ещё наше» для структурных записей.
 *
 * У перемещения, сортировки и автозаполнения ячеек в записи нет — там сверять нечем, и
 * это НАЗВАННАЯ непокрытость: их откат заливает записанное состояние безусловно, и
 * поэтому работает только на свежих записях (`undo.recency-minutes`). У остальных форм
 * сверка та же, что у ячеечного отката: если наше значение переписали, откат перетёр бы
 * чужую правку.
 */
function assertOursStill(book: SpreadsheetSnapshot, record: WriteRecord): void {
  for (const change of record.changes) {
    // Удаление: ячейки больше нет, и «текущее пусто» — ожидаемое состояние.
    if (change.after === null) continue;
    const current = valueAt(book, change.a1);
    if (sameCell(current, change.after)) continue;
    throw gcError('revision_conflict', {
      detail:
        `Ячейку ${change.a1} (${change.column}) после нашей записи изменили: мы записали ` +
        `«${String(change.after ?? '')}», сейчас там «${String(current ?? '')}». Откат ` +
        'перетёр бы чужую правку, поэтому не выполнен: перечитай и реши, что вернуть.',
      cause: 'cell_changed_after_write',
    });
  }
}
