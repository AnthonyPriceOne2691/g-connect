/**
 * Пробы правил чтения и записи длинных листов (D-26) — отдельным модулем, как
 * `token-probes.ts`: реестр проб в policy.test.ts у предела длины. Структурный оракул «у
 * КАЖДОГО правила есть проба — и наоборот» судит реестр целиком.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { expect } from 'vitest';

import { GoogleSheetsClient, WRITE_MAX_SHEET_ROWS } from '../../src/core/google/sheets.js';
import { parseOperation } from '../../src/core/ops.js';
import { limitOf } from '../../src/core/policy.js';
import { formatRows } from '../../src/core/sheets/format-op.js';
import { buildSheetData } from '../../src/core/sheets/map.js';
import { appendRow } from '../../src/core/sheets/rows.js';
import type { Cell, CellValue, SheetRequest } from '../../src/core/sheets/types.js';
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

  // Ни одного способа, два сразу и пустое условие — отказ ДО обращения к Google (урок L11):
  // «все строки» говорятся только явным `allRows: true` (Q13). Четвёртый способ — одна строка
  // шапки (Q17): с любым другим — тоже два сразу.
  'write.format-rows-explicit': async () => {
    const base = { op: 'formatCells', columns: ['Имя'], format: { bold: true } };
    const refused = [
      {},
      { where: { Имя: 'строка 1' }, allRows: true },
      { where: {} },
      { headerOnly: true, rows: { from: 2, to: 3 } },
    ];
    for (const fields of refused) {
      expect(thrownBy(() => parseOperation({ ...base, ...fields }))).toMatchObject({
        payload: { code: 'bad_request' },
      });
    }
    const snapshot = longSnapshot(3);
    // Ядро держит то же само, без границы: прямой вызов с пустым условием — отказ.
    await expect(
      formatRows(new FakeSheetsClient(snapshot), buildSheetData(snapshot), { where: {} }, ['Имя'], {
        bold: true,
      }),
    ).rejects.toMatchObject({ payload: { code: 'bad_request', cause: 'empty_condition' } });
    const preview = await formatRows(
      new FakeSheetsClient(snapshot),
      buildSheetData(snapshot),
      { allRows: true },
      ['Имя'],
      { bold: true },
    );
    expect(preview.changes.map((change) => change.a1)).toEqual(['Лист!A2', 'Лист!A3', 'Лист!A4']);
    const header = await formatRows(
      new FakeSheetsClient(snapshot),
      buildSheetData(snapshot),
      { headerOnly: true },
      ['Имя'],
      { bold: true },
    );
    expect(header.changes.map((change) => change.a1)).toEqual(['Лист!A1']);
  },

  // Вид дописанной строки — копией формата строки над ней, ДО значений, и превью это называет
  // (Q14): отказ копии не оставит в листе строку с данными шрифтом по умолчанию.
  'write.append-inherits-format': async () => {
    const snapshot = {
      id: 'SHEET',
      title: 'Т',
      sheets: [
        {
          title: 'Лист',
          sheetId: 1,
          rows: [[cell('Имя')], [{ value: 'строка 1', format: { fontFamily: 'Carlito' } }]],
        },
      ],
    };
    const preview = await appendRow(new Ordered(snapshot), buildSheetData(snapshot), {
      Имя: 'строка 2',
    });
    expect(preview.notes).toContain('оформление строки 3 — как у строки 2');
    const client = new Ordered(snapshot);
    await appendRow(
      client,
      buildSheetData(snapshot),
      { Имя: 'строка 2' },
      { dryRun: false, authorize: () => ({ authorized: true }) as const },
    );
    expect(client.order).toEqual(['copyPaste:format', 'values']);
  },
};

/** Ошибка вызова — или `null`, если вызов прошёл: отказ сверяется по полезной нагрузке. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return null;
}

/** Фейк, который помнит порядок запросов: вид и значения — разными вызовами Google. */
class Ordered extends FakeSheetsClient {
  readonly order: string[] = [];

  override async batchUpdate(id: string, requests: readonly SheetRequest[]): Promise<void> {
    this.order.push(
      ...requests.map((r) => (r.kind === 'copyPaste' ? `copyPaste:${r.paste}` : r.kind)),
    );
    await super.batchUpdate(id, requests);
  }

  override async batchUpdateValues(
    id: string,
    cells: readonly { readonly range: string; readonly value: CellValue }[],
  ): Promise<void> {
    this.order.push('values');
    await super.batchUpdateValues(id, cells);
  }
}
