/**
 * Пробы правил чтения и записи длинных листов (D-26) — отдельным модулем, как
 * `token-probes.ts`: реестр проб в policy.test.ts у предела длины. Структурный оракул «у
 * КАЖДОГО правила есть проба — и наоборот» судит реестр целиком.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { expect } from 'vitest';

import { GoogleSheetsClient, WRITE_MAX_SHEET_ROWS } from '../../src/core/google/sheets.js';
import { limitOf } from '../../src/core/policy.js';
import { buildSheetData } from '../../src/core/sheets/map.js';
import type { Cell } from '../../src/core/sheets/types.js';
import { readValues } from '../../src/mcp/read-values.js';
import { FakeSheetsClient } from './sheet.js';

const cell = (value: string): Cell => ({ value });

/** Лист: шапка и `count` строк данных — снимком, как его отдал бы Google целиком. */
const longSnapshot = (count: number) => ({
  id: 'SHEET',
  title: 'Т',
  sheets: [
    {
      title: 'Лист',
      sheetId: 1,
      rows: [[cell('Имя')], ...Array.from({ length: count }, (_, i) => [cell(`строка ${i + 1}`)])],
    },
  ],
});

export const sheetProbes: Record<string, () => Promise<void>> = {
  // Обещание правила — ПОМЕТКА усечения, а не число в коде (урок L22: прежняя проба
  // сверяла число, и правило «усечение помечается» не исполнял никто).
  'read.max-rows': async () => {
    const cap = limitOf('read.max-rows', -1);
    const snapshot = longSnapshot(cap + 3);
    const client = new FakeSheetsClient(snapshot);
    const data = buildSheetData(
      await client.getSpreadsheet('SHEET', { sheet: 'Лист', maxRows: 500 }),
    );
    const answer = (await readValues(client, 'SHEET', data, {})) as unknown as {
      rows: { value: unknown[] };
      truncated: boolean;
      nextFromRow: number;
    };
    expect(answer.rows.value).toHaveLength(cap);
    expect(answer.truncated).toBe(true);
    expect(answer.nextFromRow).toBe(cap + 2);
  },

  // Запись по листу больше предела — отказ правилом ДО чтения сетки (урок L11).
  'write.full-sheet': async () => {
    const calls: string[] = [];
    const sheets = {
      spreadsheets: {
        get: (params: { includeGridData?: boolean }) => {
          calls.push(params.includeGridData === true ? 'сетка' : 'размер');
          return Promise.resolve({
            data: {
              sheets: [
                {
                  properties: {
                    title: 'Лист',
                    gridProperties: { rowCount: WRITE_MAX_SHEET_ROWS + 1 },
                  },
                },
              ],
            },
          });
        },
      },
    } as unknown as sheets_v4.Sheets;
    const client = new GoogleSheetsClient({
      accessToken: 'нет',
      api: { sheets, drive: {} as drive_v3.Drive },
    });
    await expect(client.getSpreadsheet('SHEET', { sheet: 'Лист' })).rejects.toMatchObject({
      payload: { code: 'policy_denied', cause: 'write.full-sheet' },
    });
    expect(calls).toEqual(['размер']);
  },

  'write.max-sheet-rows': async () => {
    // Предел шва берётся из правила, а не из числа в коде.
    expect(WRITE_MAX_SHEET_ROWS).toBe(limitOf('write.max-sheet-rows', -1));
    expect(WRITE_MAX_SHEET_ROWS).toBeGreaterThan(0);
  },
};
