/**
 * Вид дат у колонки без своих дат — по листу, иначе по локали книги (D-26, Q15).
 *
 * В «Реестре инфраструктуры» все даты — 19.10.2026, а во вкладке «Проекты» «Дата старта» и
 * «Дата запуска» встали как 2026-09-10: колонка была пустой, своего вида дат у неё не было, и
 * первая дата ушла как её прислал агент. После Q9 колонка с одной датой — текстовая, и следующая
 * дата в неё тоже уходила как есть.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import { localeDateStyle } from '../src/core/sheets/date-style.js';
import { buildSheetData, buildSheetMap } from '../src/core/sheets/map.js';
import { appendRow } from '../src/core/sheets/rows.js';
import type { Cell, ColumnProfile, SpreadsheetSnapshot } from '../src/core/sheets/types.js';
import { normalizeValue } from '../src/core/values.js';
import { FakeSheetsClient } from './fixtures/sheet.js';

/** Лист «Проекты»: шапка и строки; `locale` — локаль книги, как её отдаёт Google. */
function book(rows: readonly (readonly string[])[], locale?: string): SpreadsheetSnapshot {
  return {
    id: 'S',
    title: 'Реестр',
    ...(locale === undefined ? {} : { locale }),
    sheets: [
      {
        title: 'Проекты',
        sheetId: 0,
        rows: rows.map((row): Cell[] => row.map((value) => ({ value }))),
      },
    ],
  };
}

/** Колонка карты по имени — так её видит запись. */
function column(snapshot: SpreadsheetSnapshot, name: string): ColumnProfile {
  const found = buildSheetMap(snapshot).columns.find((c) => c.name === name);
  if (found === undefined) throw new TypeError(`нет колонки «${name}» в фикстуре`);
  return found;
}

const NOW = new Date(2026, 9, 19);
const write = (snapshot: SpreadsheetSnapshot, name: string, value: string) =>
  normalizeValue(value, column(snapshot, name), { now: NOW });

/** Две строки проектов: «Дата старта» пустая, «Сдано» — с датами в виде `dotted`. */
const DOTTED_SHEET = [
  ['Проект', 'Сдано', 'Дата старта'],
  ['Реестр', '01.10.2026', ''],
  ['Сайт', '15.10.2026', ''],
];

describe('Q15: вид дат пустой колонки — по листу, иначе по локали книги', () => {
  it('Q15: пустая колонка на листе с датами 01.10.2026 — «2026-09-10» пишется «10.09.2026»', () => {
    expect(column(book(DOTTED_SHEET), 'Дата старта').dateFormat).toBe('dotted');
    expect(write(book(DOTTED_SHEET), 'Дата старта', '2026-09-10')).toEqual({
      status: 'ok',
      value: '10.09.2026',
      note: '«2026-09-10» записано как 10.09.2026 — вид дат таблицы',
    });
  });

  it('Q15: вид листа сильнее локали: на листе ISO — пустой колонке ISO и в книге ru_RU', () => {
    const iso = book(
      [
        ['Проект', 'Сдано', 'Дата старта'],
        ['Реестр', '2026-10-01', ''],
        ['Сайт', '2026-10-15', ''],
      ],
      'ru_RU',
    );
    expect(column(iso, 'Дата старта').dateFormat).toBe('iso');
    expect(write(iso, 'Дата старта', '10.09.2026')).toMatchObject({ value: '2026-09-10' });
  });

  it('Q15: дат на листе нет — по локали: ru_RU — «10.09.2026», en_US и без локали — как прислано', () => {
    const plain = [
      ['Проект', 'Дата старта'],
      ['Реестр', ''],
    ];
    expect(write(book(plain, 'ru_RU'), 'Дата старта', '2026-09-10')).toMatchObject({
      value: '10.09.2026',
    });
    expect(write(book(plain, 'en_US'), 'Дата старта', '2026-09-10')).toEqual({
      status: 'ok',
      value: '2026-09-10',
      note: null,
    });
    expect(column(book(plain), 'Дата старта').dateFormat).toBeNull();
    expect(write(book(plain), 'Дата старта', '2026-09-10')).toMatchObject({ value: '2026-09-10' });
  });

  it('Q15: ничья видов на листе — решает локаль', () => {
    const tie = book(
      [
        ['Проект', 'Сдано', 'Принято', 'Дата старта'],
        ['Реестр', '2026-10-01', '01.10.2026', ''],
        ['Сайт', '2026-10-15', '15.10.2026', ''],
      ],
      'en_US',
    );
    expect(column(tie, 'Дата старта').dateFormat).toBeNull();
  });

  it('Q15: локали «день.месяц.год» — по языку, с подчёркиванием и дефисом', () => {
    expect(localeDateStyle('ru_RU')).toBe('dotted');
    expect(localeDateStyle('de-DE')).toBe('dotted');
    expect(localeDateStyle('uk')).toBe('dotted');
    expect(localeDateStyle('en_US')).toBeNull();
    expect(localeDateStyle('en_GB')).toBeNull();
    expect(localeDateStyle(undefined)).toBeNull();
  });

  it('Q15: колонка с одной датой (текстовая после Q9) держит свой вид', () => {
    const one = (date: string) =>
      book([
        ['Проект', 'Дата запуска'],
        ['Реестр', date],
        ['Сайт', ''],
      ]);
    expect(column(one('2026-09-01'), 'Дата запуска').type).toBe('string');
    expect(write(one('2026-09-01'), 'Дата запуска', '10.09.2026')).toEqual({
      status: 'ok',
      value: '2026-09-10',
      note: '«10.09.2026» записано как 2026-09-10 — вид дат колонки',
    });
    expect(write(one('01.09.2026'), 'Дата запуска', '2026-09-10')).toMatchObject({
      value: '10.09.2026',
    });
  });

  it('Q15: колонка-дата (две даты и больше) — своим видом, как раньше', () => {
    expect(column(book(DOTTED_SHEET), 'Сдано').type).toBe('date');
    expect(write(book(DOTTED_SHEET), 'Сдано', '2026-09-10')).toMatchObject({
      value: '10.09.2026',
    });
  });

  it('Q15: слова, номера версий и несуществующий день в пустую колонку — как прислано', () => {
    const ru = book(
      [
        ['Проект', 'Дата старта'],
        ['Реестр', ''],
      ],
      'ru_RU',
    );
    for (const text of ['сегодня', 'Версия 1.2', '31.02.2026', 'с 10.09.2026']) {
      expect(write(ru, 'Дата старта', text)).toEqual({ status: 'ok', value: text, note: null });
    }
  });

  it('Q15: дозапись в книгу ru_RU пишет первую дату пустой колонки видом локали', async () => {
    const ru = book(
      [
        ['Проект', 'Дата старта'],
        ['Реестр', ''],
      ],
      'ru_RU',
    );
    const client = new FakeSheetsClient(ru);
    const result = await appendRow(
      client,
      buildSheetData(ru),
      { Проект: 'Сайт', 'Дата старта': '2026-09-10' },
      { dryRun: false, authorize: () => ({ authorized: true }) as const },
    );
    expect(result.status).toBe('ok');
    expect(client.writes).toContainEqual(
      expect.objectContaining({ range: 'Проекты!B3', values: [['10.09.2026']] }),
    );
  });
});

describe('Q15: шов — локаль книги из ответа Google', () => {
  /** Google, отвечающий как настоящий: метаданные листа и сетка с `properties.locale`. */
  function google(locale?: string) {
    const properties = { sheetId: 0, title: 'Проекты', gridProperties: { rowCount: 2 } };
    const book = { title: 'Реестр', ...(locale === undefined ? {} : { locale }) };
    const rowData = [
      { values: [{ formattedValue: 'Проект', effectiveValue: { stringValue: 'Проект' } }] },
      { values: [{ formattedValue: 'Реестр', effectiveValue: { stringValue: 'Реестр' } }] },
    ];
    const sheets = {
      spreadsheets: {
        get: (params: { includeGridData?: boolean }) =>
          Promise.resolve({
            data:
              params.includeGridData === true
                ? { properties: book, sheets: [{ properties, data: [{ rowData }] }] }
                : { properties: book, sheets: [{ properties }] },
          }),
      },
    } as unknown as sheets_v4.Sheets;
    const drive = {
      files: { get: () => Promise.resolve({ data: { version: '1' } }) },
    } as unknown as drive_v3.Drive;
    return new GoogleSheetsClient({ accessToken: 'x', api: { sheets, drive } });
  }

  it('Q15: `properties.locale` ответа — `locale` снимка; без неё ключа нет', async () => {
    const ru = await google('ru_RU').getSpreadsheet('S', { sheet: 'Проекты' });
    expect(ru.locale).toBe('ru_RU');
    const none = await google().getSpreadsheet('S', { sheet: 'Проекты' });
    expect(none).not.toHaveProperty('locale');
  });
});
