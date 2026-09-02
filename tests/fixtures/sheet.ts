/**
 * Фикстура таблицы из spec.md и фейковый клиент. Форма фикстуры намеренно «живая»:
 * название отчёта в первой строке, шапка во второй.
 */

import { appendRow, setCells, upsertRow } from '../../src/core/sheets/rows.js';
import type { ApplyOutcome, RowOptions } from '../../src/core/sheets/rows.js';
import type {
  CellValue,
  Cell,
  SheetSnapshot,
  SpreadsheetSnapshot,
  SheetsClient,
} from '../../src/core/sheets/types.js';

const cell = (value: CellValue, formula?: string): Cell =>
  formula === undefined ? { value } : { value, formula };

const row = (...values: (CellValue | Cell)[]): Cell[] =>
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
export class FakeSheetsClient implements SheetsClient {
  readonly writes: RecordedWrite[] = [];
  readonly appends: RecordedWrite[] = [];
  private readonly data: SpreadsheetSnapshot;

  constructor(data: SpreadsheetSnapshot = snapshot()) {
    this.data = data;
  }

  async getSpreadsheet(): Promise<SpreadsheetSnapshot> {
    return this.data;
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

  async updateValues(
    _id: string,
    range: string,
    values: readonly (readonly CellValue[])[],
  ): Promise<void> {
    const parsed = /^(.+)!([A-Z]+)(\d+)$/.exec(range);
    if (parsed === null) throw new Error(`фикстура не умеет диапазон ${range}`);
    const [, sheetTitle, letter, rowText] = parsed;
    const columnIndex =
      [...(letter ?? '')].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    const rowIndex = Number(rowText) - 1;
    const next = this.data.sheets.map((sheet) => {
      if (sheet.title !== sheetTitle) return sheet;
      const rows = sheet.rows.map((r) => [...r]);
      while (rows.length <= rowIndex) rows.push([]);
      const row = rows[rowIndex] as Cell[];
      while (row.length <= columnIndex) row.push({ value: null });
      row[columnIndex] = { value: values[0]?.[0] ?? null };
      return { ...sheet, rows };
    });
    this.data = { ...this.data, sheets: next };
  }

  async appendValues(): Promise<void> {
    throw new Error('не используется');
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
