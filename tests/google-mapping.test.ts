/**
 * Шов с `googleapis`: ответ библиотеки → доменный снимок. Форма ответа здесь собрана
 * руками по документации Sheets API — именно она меняется между версиями библиотеки,
 * и промах даёт «internal» вместо данных.
 */

import { describe, expect, it } from 'vitest';
import type { sheets_v4 } from 'googleapis';

import { toSpreadsheetSnapshot } from '../src/core/google/sheets.ts';
import { buildSheetMap } from '../src/core/sheets/map.ts';

const cell = (partial: sheets_v4.Schema$CellData): sheets_v4.Schema$CellData => partial;

const RESPONSE: sheets_v4.Schema$Spreadsheet = {
  properties: { title: 'Рабочий журнал' },
  sheets: [
    {
      properties: { title: 'Лист1', sheetId: 0, gridProperties: { frozenRowCount: 2 } },
      protectedRanges: [
        { range: { startRowIndex: 2, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: 1 } },
      ],
      data: [
        {
          rowData: [
            { values: [cell({ formattedValue: 'Отчёт за сентябрь' })] },
            {
              values: [
                cell({ formattedValue: 'Дата', effectiveValue: { stringValue: 'Дата' } }),
                cell({ formattedValue: 'Проект', effectiveValue: { stringValue: 'Проект' } }),
                cell({ formattedValue: 'Статус', effectiveValue: { stringValue: 'Статус' } }),
                cell({ formattedValue: 'Часы', effectiveValue: { stringValue: 'Часы' } }),
                cell({ formattedValue: 'Итого', effectiveValue: { stringValue: 'Итого' } }),
              ],
            },
            {
              values: [
                // Даты приходят как formattedValue + serial в effectiveValue:
                // человеку нужна первая форма, иначе в карте окажется 46266.
                // Так дата и приходит на самом деле: серийное число + формат DATE.
                cell({
                  formattedValue: '2026-09-01',
                  effectiveValue: { numberValue: 46266 },
                  effectiveFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } },
                }),
                cell({ formattedValue: 'G connect', effectiveValue: { stringValue: 'G connect' } }),
                cell({
                  formattedValue: 'в работе',
                  effectiveValue: { stringValue: 'в работе' },
                  dataValidation: {
                    condition: {
                      type: 'ONE_OF_LIST',
                      values: [
                        { userEnteredValue: 'в работе' },
                        { userEnteredValue: 'готово' },
                        { userEnteredValue: 'пауза' },
                      ],
                    },
                  },
                }),
                cell({ formattedValue: '2', effectiveValue: { numberValue: 2 } }),
                cell({
                  formattedValue: '2',
                  effectiveValue: { numberValue: 2 },
                  userEnteredValue: { formulaValue: '=D3*1' },
                }),
              ],
            },
          ],
        },
      ],
    },
    { properties: { title: 'Сроки', sheetId: 1 }, data: [{ rowData: [] }] },
  ],
};

describe('перевод ответа Google в снимок', () => {
  const snapshot = toSpreadsheetSnapshot(RESPONSE, 'SHEETID', '3743');

  it('название, ревизия и все листы на месте', () => {
    expect(snapshot.title).toBe('Рабочий журнал');
    expect(snapshot.revisionId).toBe('3743');
    expect(snapshot.sheets.map((s) => s.title)).toEqual(['Лист1', 'Сроки']);
    expect(snapshot.sheets[0]?.frozenRows).toBe(2);
  });

  it('дата берётся из formattedValue, а не из серийного числа', () => {
    expect(snapshot.sheets[0]?.rows[2]?.[0]?.value).toBe('2026-09-01');
  });

  it('число остаётся числом, формула сохраняется отдельно от значения', () => {
    const row = snapshot.sheets[0]?.rows[2] ?? [];
    expect(row[3]?.value).toBe(2);
    expect(row[3]?.formula).toBeUndefined();
    expect(row[4]?.formula).toBe('=D3*1');
  });

  it('список допустимых значений вытащен из ячейки первой строки данных', () => {
    const validation = snapshot.sheets[0]?.validations?.[0];
    expect(validation?.values).toEqual(['в работе', 'готово', 'пауза']);
    expect(validation?.range.startColumn).toBe(2);
  });

  it('защищённый диапазон переведён в 1-based строки, как ждёт карта', () => {
    expect(snapshot.sheets[0]?.protectedRanges?.[0]).toMatchObject({ startRow: 3, startColumn: 0 });
  });

  it('карта, построенная из настоящего ответа, видит то же, что из фикстуры', () => {
    const map = buildSheetMap(snapshot);
    expect(map.headerRow).toBe(2);
    const byName = Object.fromEntries(map.columns.map((c) => [c.name, c]));
    expect(byName['Дата']?.type).toBe('date');
    expect(byName['Статус']?.enumSource).toBe('validation');
    expect(byName['Итого']?.hasFormula).toBe(true);
    expect(byName['Дата']?.protected).toBe(true);
    expect(map.otherSheets.map((s) => s.title)).toEqual(['Сроки']);
  });

  it('пустой ответ без листов → not_found, а не пустая карта', () => {
    expect(() => toSpreadsheetSnapshot({ sheets: [] }, 'X')).toThrowError(/not_found/);
  });
});
