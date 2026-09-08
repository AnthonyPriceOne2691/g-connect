/**
 * Фикстура таблицы из spec.md и фейковый клиент. Форма фикстуры намеренно «живая»:
 * название отчёта в первой строке, шапка во второй.
 */

import { appendRow, upsertRow } from '../../src/core/sheets/rows.js';
import { setCells } from '../../src/core/sheets/set-cells-op.js';
import type { ApplyOutcome, RowOptions } from '../../src/core/sheets/rows.js';
import type {
  AutoFillRequest,
  Cell,
  CellValue,
  CopyPasteRequest,
  CutPasteRequest,
  DeleteDimensionRequest,
  MoveDimensionRequest,
  SortRangeRequest,
  FormatRequest,
  InsertDimensionRequest,
  SheetRequest,
  SheetSnapshot,
  SheetsClient,
  SpreadsheetSnapshot,
} from '../../src/core/sheets/types.js';

const cell = (value: CellValue, formula?: string): Cell =>
  formula === undefined ? { value } : { value, formula };

export const row = (...values: (CellValue | Cell)[]): Cell[] =>
  values.map((v) => (typeof v === 'object' && v !== null && 'value' in v ? v : cell(v)));

export const STATUS_VALUES = ['в работе', 'готово', 'пауза'] as const;

export function reportSheet(): SheetSnapshot {
  return {
    title: 'Лист1',
    sheetId: 0,
    rows: [
      row('Отчёт за сентябрь', null, null, null),
      row('Дата', 'Проект', 'Статус', 'Часы'),
      row('2026-09-01', 'G connect', 'в работе', 2),
      row('2026-08-31', 'lash-try-on', 'готово', 5),
    ],
    frozenRows: 2,
    validations: [
      {
        range: { startRow: 3, endRow: 1000, startColumn: 2, endColumn: 2 },
        values: [...STATUS_VALUES],
      },
    ],
  };
}

/** Лист с двумя датами — пример A5 (неоднозначность). */
export function twoDatesSheet(): SheetSnapshot {
  return {
    title: 'Сроки',
    sheetId: 1,
    rows: [
      row('Проект', 'Дата начала', 'Дата сдачи'),
      row('G connect', '01.09.2026', '30.09.2026'),
      row('lash-try-on', '01.08.2026', '31.08.2026'),
    ],
  };
}

/** Лист с формульной колонкой — пример A10. */
/**
 * Лист с оформлением: жирная шапка, правое выравнивание числовой колонки, цветная ячейка.
 * Нужен, чтобы карта могла показать вид, а откат — вернуть его.
 */
export function formattedSheet(): SheetSnapshot {
  const header = (value: CellValue): Cell => ({
    value,
    format: { bold: true, align: 'center' },
  });
  return {
    title: 'Оформленный',
    sheetId: 7,
    rows: [
      [header('Проект'), header('Часы'), header('Статус')],
      [
        { value: 'G connect' },
        { value: 2, format: { align: 'right' } },
        { value: 'в работе', format: { background: '#ffcc00' } },
      ],
      [{ value: 'lash-try-on' }, { value: 5, format: { align: 'right' } }, { value: 'готово' }],
    ],
    frozenRows: 1,
  };
}

export function formulaSheet(): SheetSnapshot {
  return {
    title: 'Итоги',
    sheetId: 2,
    rows: [
      row('Проект', 'Часы', 'Итого'),
      row('G connect', 2, cell(2, '=B2*1')),
      row('lash-try-on', 5, cell(5, '=B3*1')),
    ],
  };
}

/**
 * Лист-инструкция по образцу живой таблицы владельца: заголовок-баннер в строке 1,
 * назначение в 3–5, шапка в строке 7, ПУСТАЯ колонка D и отдельный жёлтый блок
 * E:H с объединёнными ячейками. Ровно тот случай, где ридер молча втягивал врезку
 * в данные как колонку с одной заполненной ячейкой.
 */
export function instructionSheet(): SheetSnapshot {
  const blank = [null, null, null, null] as const;
  return {
    title: 'Инструкция',
    sheetId: 3,
    rows: [
      row('Реестр инфраструктуры ИИ-отдела', ...blank),
      row(null, ...blank),
      row('Назначение', ...blank),
      row(null, ...blank),
      row('Единая точка контроля всех ИИ-проектов', ...blank),
      row(null, ...blank),
      row('Вкладка', 'Кто заполняет', 'Когда обновлять', null, 'Критерии завершения задачи'),
      row(
        'Проекты',
        'ИИ-инженер / руководитель',
        'При старте',
        null,
        '• Все объекты на корпоративных аккаунтах',
      ),
      row('Аккаунты и сервисы', 'ИИ-инженер / IT', 'При создании аккаунта', null, null),
      row('API и интеграции', 'ИИ-инженер', 'При ротации ключа', null, null),
    ],
    merges: [
      { startRow: 1, endRow: 1, startColumn: 0, endColumn: 7 },
      { startRow: 8, endRow: 14, startColumn: 4, endColumn: 7 },
    ],
  };
}

/** Лист с защищённым диапазоном — для правила write.protected-range. */
export function protectedSheet(): SheetSnapshot {
  return {
    title: 'Защита',
    sheetId: 4,
    rows: [row('Проект', 'Владелец'), row('G connect', 'Антон'), row('lash-try-on', 'Антон')],
    protectedRanges: [{ startRow: 2, endRow: 100, startColumn: 1, endColumn: 1 }],
  };
}

/** Лист на `rows` строк с одинаковым значением ключа — для правила write.max-changes. */
/**
 * Лист, где под одно условие подходят НЕПОДРЯД идущие строки: между двумя «в работе»
 * стоит «готово». Нужен ровно для того, чтобы оракул на непрерывность блока проверял
 * разрыв, а не «ноль подошедших» (находка читателя без прогона 2026-09-04).
 */
export function gappedSheet(): SheetSnapshot {
  return {
    title: 'Разрыв',
    sheetId: 9,
    rows: [
      row('Проект', 'Статус', 'Часы'),
      row('первый', 'в работе', 1),
      row('второй', 'готово', 2),
      row('третий', 'в работе', 3),
    ],
  };
}

export function wideSheet(rows: number): SheetSnapshot {
  const data: Cell[][] = [row('Группа', 'Значение')];
  for (let i = 0; i < rows; i += 1) data.push(row('все', i));
  return { title: 'Много', sheetId: 5, rows: data };
}

export function snapshot(sheets: SheetSnapshot[] = [reportSheet()]): SpreadsheetSnapshot {
  return {
    id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    title: 'Рабочий журнал',
    revisionId: 'rev-1',
    sheets,
  };
}

export interface RecordedWrite {
  readonly range: string;
  readonly values: readonly (readonly CellValue[])[];
}

/** Фейковый клиент: запоминает записи, чтобы проверять, что dryRun действительно не пишет. */
/**
 * Применить правку вида к снимку. Один помощник на оба фейка: две копии этого цикла
 * поймал гейт копипаста, и он прав — разъехались бы они молча.
 */
function withFormat(data: SpreadsheetSnapshot, request: FormatRequest): SpreadsheetSnapshot {
  const sheet = data.sheets.find((s) => s.sheetId === request.sheetId);
  if (sheet === undefined) return data;
  const rows = sheet.rows.map((r) => [...r]);
  const row = rows[request.row - 1];
  if (row === undefined) return data;
  const cell = row[request.column] ?? { value: null };
  row[request.column] = { ...cell, format: { ...cell.format, ...request.format } };
  return {
    ...data,
    sheets: data.sheets.map((s) => (s.sheetId === request.sheetId ? { ...s, rows } : s)),
  };
}

/**
 * Применить ЛЮБОЙ доменный запрос к снимку: вид или геометрию. Фейки обязаны
 * соответствовать шву целиком — иначе оракул на откат структурной правки проверял бы
 * «метод вызвали», а не «строка вернулась» (урок L3).
 */
function applyRequest(data: SpreadsheetSnapshot, request: SheetRequest): SpreadsheetSnapshot {
  if (request.kind === 'format') return withFormat(data, request);
  if (request.kind === 'addSheet') {
    const sheetId = Math.max(0, ...data.sheets.map((s) => s.sheetId)) + 1;
    const created = {
      title: request.title,
      sheetId,
      rows: [],
      ...(request.properties === undefined ? {} : { properties: request.properties }),
    };
    return { ...data, sheets: [...data.sheets, created] };
  }
  if (request.kind === 'deleteSheet') {
    return { ...data, sheets: data.sheets.filter((s) => s.sheetId !== request.sheetId) };
  }
  if (request.kind === 'renameSheet') {
    return {
      ...data,
      sheets: data.sheets.map((s) =>
        s.sheetId === request.sheetId ? { ...s, title: request.title } : s,
      ),
    };
  }
  if (request.kind === 'insertDimension' || request.kind === 'deleteDimension') {
    return withDimension(data, request);
  }
  if (request.kind === 'duplicateSheet') {
    const source = data.sheets.find((s) => s.sheetId === request.sheetId);
    if (source === undefined) return data;
    const sheetId = Math.max(0, ...data.sheets.map((s) => s.sheetId)) + 1;
    return {
      ...data,
      sheets: [...data.sheets, { ...source, title: request.title, sheetId }],
    };
  }
  if (request.kind === 'moveDimension') return withMove(data, request);
  if (request.kind === 'sortRange') return withSort(data, request);
  // copyPaste / cutPaste / autoFill: фейк копирует ячейки сам, чтобы оракул проверял
  // «значения переехали», а не «метод вызвали» (урок L3).
  return withPaste(data, request);
}

/**
 * Перемещение строк ровно так, как это делает Google: `destinationIndex` считается по
 * координатам ДО удаления блока. Фейк повторяет эту семантику, а не удобную — иначе
 * оракул на откат перемещения был бы зелёным при неверной формуле.
 */
function withMove(data: SpreadsheetSnapshot, request: MoveDimensionRequest): SpreadsheetSnapshot {
  return {
    ...data,
    sheets: data.sheets.map((sheet) => {
      if (sheet.sheetId !== request.sheetId) return sheet;
      const rows = sheet.rows.map((r) => [...r]);
      const start = request.at - 1;
      const block = rows.splice(start, request.count);
      const target =
        request.destinationIndex -
        Math.min(Math.max(request.destinationIndex - start, 0), request.count);
      rows.splice(target, 0, ...block);
      return { ...sheet, rows };
    }),
  };
}

/** Сортировка диапазона по колонке: строки внутри диапазона, остальные не двигаются. */
function withSort(data: SpreadsheetSnapshot, request: SortRangeRequest): SpreadsheetSnapshot {
  return {
    ...data,
    sheets: data.sheets.map((sheet) => {
      if (sheet.sheetId !== request.sheetId) return sheet;
      const rows = sheet.rows.map((r) => [...r]);
      const from = request.range.row - 1;
      const block = rows.splice(from, request.range.rowCount);
      block.sort((a, b) => {
        const left = String(a[request.column]?.value ?? '');
        const right = String(b[request.column]?.value ?? '');
        return request.descending === true ? right.localeCompare(left) : left.localeCompare(right);
      });
      rows.splice(from, 0, ...block);
      return { ...sheet, rows };
    }),
  };
}

/** Перенос прямоугольника: копирование, вырезание и автозаполнение по образцу. */
function withPaste(
  data: SpreadsheetSnapshot,
  request: CopyPasteRequest | CutPasteRequest | AutoFillRequest,
): SpreadsheetSnapshot {
  return {
    ...data,
    sheets: data.sheets.map((sheet) => {
      if (sheet.sheetId !== request.sheetId) return sheet;
      const rows = sheet.rows.map((r) => [...r]);
      const { source, destination } = request;
      for (let dr = 0; dr < destination.rowCount; dr += 1) {
        for (let dc = 0; dc < destination.columnCount; dc += 1) {
          const from = rows[source.row - 1 + (dr % Math.max(1, source.rowCount))]?.[
            source.column + (dc % Math.max(1, source.columnCount))
          ] ?? { value: null };
          const targetRow = destination.row - 1 + dr;
          while (rows.length <= targetRow) rows.push([]);
          const row = rows[targetRow] as Cell[];
          while (row.length <= destination.column + dc) row.push({ value: null });
          row[destination.column + dc] = { ...from };
        }
      }
      if (request.kind === 'cutPaste') {
        for (let sr = 0; sr < source.rowCount; sr += 1) {
          const row = rows[source.row - 1 + sr];
          if (row === undefined) continue;
          for (let sc = 0; sc < source.columnCount; sc += 1) {
            row[source.column + sc] = { value: null };
          }
        }
      }
      return { ...sheet, rows };
    }),
  };
}

/** Вставка и удаление измерения: строки или колонки, 1-based «перед этим номером». */
function withDimension(
  data: SpreadsheetSnapshot,
  request: InsertDimensionRequest | DeleteDimensionRequest,
): SpreadsheetSnapshot {
  const insert = request.kind === 'insertDimension';
  return {
    ...data,
    sheets: data.sheets.map((sheet) => {
      if (sheet.sheetId !== request.sheetId) return sheet;
      const rows = sheet.rows.map((r) => [...r]);
      const start = request.at - 1;
      if (request.dimension === 'rows') {
        if (insert) rows.splice(start, 0, ...Array.from({ length: request.count }, () => []));
        else rows.splice(start, request.count);
        return { ...sheet, rows };
      }
      const next = rows.map((row) => {
        const copy = [...row];
        if (insert)
          copy.splice(start, 0, ...Array.from({ length: request.count }, () => ({ value: null })));
        else copy.splice(start, request.count);
        return copy;
      });
      return { ...sheet, rows: next };
    }),
  };
}

export class FakeSheetsClient implements SheetsClient {
  readonly writes: RecordedWrite[] = [];
  readonly appends: RecordedWrite[] = [];
  readonly formatWrites: SheetRequest[] = [];
  private data: SpreadsheetSnapshot;

  constructor(data: SpreadsheetSnapshot = snapshot()) {
    this.data = data;
  }

  async getSpreadsheet(): Promise<SpreadsheetSnapshot> {
    return this.data;
  }

  async sheetTitles(): Promise<readonly string[]> {
    return this.data.sheets.map((sheet) => sheet.title);
  }

  async updateValues(
    _id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
  ): Promise<void> {
    this.writes.push({ range, values });
  }

  async appendValues(
    _id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
  ): Promise<void> {
    this.appends.push({ range, values });
  }

  /**
   * Правки вида фейк ЗАПОМИНАЕТ и применяет к своему снимку: иначе оракул на откат вида
   * проверял бы только «вызвали метод», а не «вид вернулся» — то есть ничего.
   */
  async batchUpdate(_id: string, requests: readonly SheetRequest[]): Promise<void> {
    this.formatWrites.push(...requests);
    for (const request of requests) {
      this.data = applyRequest(this.data, request);
    }
  }
}

/**
 * Клиент, который ДЕЙСТВИТЕЛЬНО применяет записи к снимку. Нужен для инварианта
 * идемпотентности: без применения второй upsert «не находит изменений» по ошибке.
 */
export class MutableSheetsClient implements SheetsClient {
  private data: SpreadsheetSnapshot;

  constructor(data: SpreadsheetSnapshot = snapshot()) {
    this.data = data;
  }

  async getSpreadsheet(): Promise<SpreadsheetSnapshot> {
    return this.data;
  }

  async sheetTitles(): Promise<readonly string[]> {
    return this.data.sheets.map((sheet) => sheet.title);
  }

  async updateValues(
    _id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
  ): Promise<void> {
    const parsed = /^(.+)!([A-Z]+)(\d+)$/.exec(range);
    if (parsed === null) throw new Error(`фикстура не умеет диапазон ${range}`);
    const [, sheetTitle, letter, rowText] = parsed;
    // Семантика Google values.update, а не «как удобно тесту»: `null` ПРОПУСКАЕТ ячейку
    // (ничего не меняет), пустая строка ОЧИЩАЕТ (читается потом как пусто). Фейк писал
    // null как очистку — и все оракулы отката были зелёными, пока живой откат сортировки
    // смешивал две строки (LR-2, живой прогон 2026-09-06). Шов один — фейк обязан ему.
    const incoming = values[0]?.[0] ?? null;
    if (incoming === null) return;
    const written: Cell = { value: incoming === '' ? null : incoming };
    const columnIndex =
      [...(letter ?? '')].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    const rowIndex = Number(rowText) - 1;
    const next = this.data.sheets.map((sheet) => {
      if (sheet.title !== sheetTitle) return sheet;
      const rows = sheet.rows.map((r) => [...r]);
      while (rows.length <= rowIndex) rows.push([]);
      const row = rows[rowIndex] as Cell[];
      while (row.length <= columnIndex) row.push({ value: null });
      row[columnIndex] = written;
      return { ...sheet, rows };
    });
    this.data = { ...this.data, sheets: next };
  }

  async appendValues(): Promise<void> {
    throw new Error('не используется');
  }

  /** Тот же метод, что у настоящего клиента: шов один, и фейки обязаны ему соответствовать. */
  async batchUpdate(_id: string, requests: readonly SheetRequest[]): Promise<void> {
    for (const request of requests) {
      this.data = applyRequest(this.data, request);
    }
  }
}

/**
 * Превью → код плана → запись: так работает человек (D-16), так же обязаны и тесты.
 *
 * Запись без кода плана теперь не проходит, и оракул, обходящий подтверждение, охранял бы
 * контур, которого нет. Помощник берёт код из превью, построенного на том же снимке.
 */
export async function confirmedWrite(
  run: (options: RowOptions) => Promise<ApplyOutcome>,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const preview = await run({ ...options, dryRun: true });
  return run({
    ...options,
    dryRun: false,
    ...(preview.planId === null ? {} : { confirm: preview.planId }),
  });
}

/** Те же три операции, но через подтверждение кодом плана: подпись человека имитируется. */
export const upsertConfirmed = (
  client: SheetsClient,
  data: Parameters<typeof upsertRow>[1],
  key: Parameters<typeof upsertRow>[2],
  values: Parameters<typeof upsertRow>[3],
  options: RowOptions = {},
): Promise<ApplyOutcome> => confirmedWrite((o) => upsertRow(client, data, key, values, o), options);

export const appendConfirmed = (
  client: SheetsClient,
  data: Parameters<typeof appendRow>[1],
  values: Parameters<typeof appendRow>[2],
  options: RowOptions = {},
): Promise<ApplyOutcome> => confirmedWrite((o) => appendRow(client, data, values, o), options);

export const setCellsConfirmed = (
  client: SheetsClient,
  data: Parameters<typeof setCells>[1],
  where: Parameters<typeof setCells>[2],
  values: Parameters<typeof setCells>[3],
  options: RowOptions = {},
): Promise<ApplyOutcome> =>
  confirmedWrite((o) => setCells(client, data, where, values, o), options);
