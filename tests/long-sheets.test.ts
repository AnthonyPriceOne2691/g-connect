/**
 * Длинные листы (D-26): запись считается по всему листу, чтение не теряет строки молча.
 *
 * Шов судится на живой форме ответа Google (урок L28): заглушка отвечает как Google —
 * сетка только в запрошенном диапазоне, размер листа — в `gridProperties`, хвост пустых
 * строк не отдаётся. Через неё идут настоящий `GoogleSheetsClient` и настоящий `gc_apply`:
 * фейк клиента целиком потолка в 500 строк не видел, и запись по обрезанному листу жила
 * незамеченной (L23).
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import type { WriteRecord } from '../src/core/journal.js';
import { gcApply, gcRead, type ToolDeps } from '../src/mcp/tools.js';
import { callMcp } from './fixtures/protocol.js';

const ID = '1LONGsheetCCCCCCCCCCCCCCCCCCCCCCCCC';
const TITLE = 'Агентства';

/** Шапка и `count` строк данных; `gaps` — номера строк листа, оставленных пустыми. */
function sheetRows(count: number, gaps: readonly number[] = []): string[][] {
  const rows = [['Компания', 'Статус', 'Заметка']];
  for (let n = 1; n <= count; n += 1) {
    rows.push(gaps.includes(n + 1) ? ['', '', ''] : [`Компания ${n}`, 'новая', `заметка ${n}`]);
  }
  return rows;
}

/** Номера строк диапазона A1-нотации: «'Лист'» — весь лист, «'Лист'!A5:ZZ9» — с 5 по 9. */
function rowsOf(range: string, total: number): [number, number] {
  const match = /!A(\d+):[A-Z]+(\d+)$/.exec(range);
  return match === null ? [1, total] : [Number(match[1]), Number(match[2])];
}

/** Google, отвечающий как настоящий; записи — в журнал вызовов. */
function google(rows: string[][], gridRows: number, failBatch = false) {
  const writes: string[] = [];
  const reads: string[] = [];
  const batches: number[] = [];
  const properties = {
    sheetId: 7,
    title: TITLE,
    gridProperties: { rowCount: gridRows, columnCount: 26 },
  };
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean; ranges?: string[] }) => {
        const range = params.ranges?.[0];
        reads.push(range ?? '(без диапазона)');
        if (params.includeGridData !== true) {
          return Promise.resolve({
            data: { properties: { title: 'Продажи' }, sheets: [{ properties }] },
          });
        }
        const [from, to] = range === undefined ? [1, rows.length] : rowsOf(range, rows.length);
        const slice = rows.slice(from - 1, Math.min(to, rows.length));
        while (slice.length > 0 && slice[slice.length - 1]?.every((v) => v === '')) slice.pop();
        const rowData = slice.map((row) => ({
          values: row.map((v) =>
            v === '' ? {} : { effectiveValue: { stringValue: v }, formattedValue: v },
          ),
        }));
        return Promise.resolve({
          data: {
            properties: { title: 'Продажи' },
            sheets: [{ properties, data: [{ startRow: from - 1, rowData }] }],
          },
        });
      },
      values: {
        update: (params: { range: string }) => {
          writes.push(params.range);
          return Promise.resolve({ data: {} });
        },
        // Строка правки — одним запросом (Q10): каждый запрос — запись в `batches`.
        batchUpdate: (params: { requestBody: { data: { range: string }[] } }) => {
          batches.push(params.requestBody.data.length);
          // Отказ Google не повторяемым кодом: запрос не записан целиком — ни одной ячейки.
          if (failBatch) {
            return Promise.reject(
              Object.assign(new Error('The caller does not have permission'), { code: 403 }),
            );
          }
          for (const d of params.requestBody.data) writes.push(d.range);
          return Promise.resolve({ data: {} });
        },
      },
      batchUpdate: () => Promise.resolve({ data: {} }),
    },
  } as unknown as sheets_v4.Sheets;
  const drive = {
    files: { get: () => Promise.resolve({ data: { version: '1' } }) },
  } as unknown as drive_v3.Drive;
  return { api: { sheets, drive }, writes, reads, batches };
}

function depsOf(api: { sheets: sheets_v4.Sheets; drive: drive_v3.Drive }): {
  deps: ToolDeps;
  journalled: WriteRecord[];
} {
  const journalled: WriteRecord[] = [];
  const client = new GoogleSheetsClient({ accessToken: 'нет', api });
  return {
    journalled,
    deps: {
      account: 'default',
      sheets: () => Promise.resolve(client),
      docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
      drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
      registry: () =>
        Promise.resolve({
          targets: [
            {
              alias: 'big',
              id: ID,
              type: 'sheet',
              allow: 'write',
              sheet: TITLE,
              headerRow: 1,
              key: ['Компания'],
              auto: { ops: ['appendRow', 'upsertRow'], maxCells: 4 },
            },
          ],
        }),
      journal: (record: WriteRecord) => {
        journalled.push(record);
        return Promise.resolve();
      },
      journalSource: { recent: () => Promise.resolve([]) },
      revision: () => Promise.resolve('1'),
    },
  };
}

describe('длинные листы: запись считается по всему листу (D-26)', () => {
  it('Q4: appendRow на листе в 600 строк дописывает после последней строки, а не в 501-ю', async () => {
    const g = google(sheetRows(600), 1000);
    const { deps } = depsOf(g.api);
    const result = await callMcp(
      gcApply,
      {
        op: 'appendRow',
        target: 'big',
        values: { Компания: 'Новая', Статус: 'новая', Заметка: 'новая заметка' },
        dryRun: false,
      },
      deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.writes.length).toBeGreaterThan(0);
    for (const range of g.writes) expect(range).toMatch(/602$/);
  });

  it('Q4: пропуск в середине листа — граница данных, а не число непустых строк (L16)', async () => {
    const g = google(sheetRows(40, [10, 11, 12]), 1000);
    const { deps } = depsOf(g.api);
    const result = await callMcp(
      gcApply,
      {
        op: 'appendRow',
        target: 'big',
        values: { Компания: 'Новая', Статус: 'новая', Заметка: 'новая заметка' },
        dryRun: false,
      },
      deps,
    );
    // Запись обязана СЛУЧИТЬСЯ: проверка «каждая запись — в 42-ю» верна и при нуле записей (L7).
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.writes.length).toBeGreaterThan(0);
    for (const range of g.writes) expect(range).toMatch(/42$/);
  });

  it('Q5: upsertRow с ключом в 550-й строке правит её — ни дубля, ни затирания', async () => {
    const g = google(sheetRows(600), 1000);
    const { deps } = depsOf(g.api);
    const result = await callMcp(
      gcApply,
      {
        op: 'upsertRow',
        target: 'big',
        key: { Компания: 'Компания 549' },
        values: { Заметка: 'письмо отправлено' },
        dryRun: false,
      },
      deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.writes).toEqual([expect.stringMatching(/C550$/)]);
  });
});

/** Строки ответа `values`: содержимое — данные с пометкой источника (`content.is-data`). */
const rowsOfAnswer = (data: unknown): Record<string, unknown>[] =>
  (data as { rows: { value: Record<string, unknown>[] } }).rows.value;

describe('длинные листы: чтение не теряет строки молча (D-26)', () => {
  it('Q1: лист на 1630 строк — все 1629 строк данных одним вызовом', async () => {
    const g = google(sheetRows(1629), 1630);
    const result = await callMcp(gcRead, { target: 'big', mode: 'values' }, depsOf(g.api).deps);
    const data = result.data as { truncated: boolean; sheetRows: number; fromRow: number };
    expect(rowsOfAnswer(data)).toHaveLength(1629);
    expect(rowsOfAnswer(data).at(-1)).toMatchObject({ Компания: 'Компания 1629' });
    expect(data).toMatchObject({ truncated: false, sheetRows: 1630, fromRow: 2 });
  });

  it('Q2: лист длиннее предела — 5000 строк, truncated, строк листа и строка продолжения', async () => {
    const g = google(sheetRows(6000), 6001);
    const result = await callMcp(gcRead, { target: 'big', mode: 'values' }, depsOf(g.api).deps);
    expect(rowsOfAnswer(result.data)).toHaveLength(5000);
    expect(result.data).toMatchObject({ truncated: true, sheetRows: 6001, nextFromRow: 5002 });
    const next = await callMcp(
      gcRead,
      { target: 'big', mode: 'values', fromRow: 5002 },
      depsOf(g.api).deps,
    );
    expect(rowsOfAnswer(next.data)).toHaveLength(1000);
    expect(next.data).toMatchObject({ truncated: false });
  });

  it('Q3: fromRow — строки с нужной строки листа; шапка и выше — с первой строки данных', async () => {
    const g = google(sheetRows(1629), 1630);
    const from = await callMcp(
      gcRead,
      { target: 'big', mode: 'values', fromRow: 1001 },
      depsOf(g.api).deps,
    );
    expect(from.data).toMatchObject({ fromRow: 1001 });
    expect(rowsOfAnswer(from.data)[0]).toMatchObject({ Компания: 'Компания 1000' });
    expect(rowsOfAnswer(from.data)).toHaveLength(630);
    const header = await callMcp(
      gcRead,
      { target: 'big', mode: 'values', fromRow: 1, limit: 3 },
      depsOf(g.api).deps,
    );
    expect(header.data).toMatchObject({ fromRow: 2, truncated: true, nextFromRow: 5 });
    expect((header.data as { warnings: string[] }).warnings.join(' ')).toContain('fromRow 1');
  });

  it('Q6: лист больше предела записи — отказ правилом ДО чтения сетки, ни одной записи', async () => {
    const g = google(sheetRows(10), 60_000);
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'big', values: { Компания: 'Новая' }, dryRun: false },
      depsOf(g.api).deps,
    );
    expect(result.error).toMatchObject({ code: 'policy_denied', cause: 'write.full-sheet' });
    expect(result.error?.detail).toContain('60000 строк сетки');
    expect(g.writes).toHaveLength(0);
    expect(g.reads).not.toContain(`'${TITLE}'`);
  });

  it('Q7: карта — лёгкая, но говорит, что построена по части листа', async () => {
    const g = google(sheetRows(1629), 1630);
    const result = await callMcp(gcRead, { target: 'big', mode: 'map' }, depsOf(g.api).deps);
    const map = result.data as { sheetRows: number; warnings: string[]; dataRowCount: number };
    expect(map.sheetRows).toBe(1630);
    expect(map.warnings.join(' ')).toContain('карта построена по первым 500 строкам листа из 1630');
    expect(g.reads).toContain(`'${TITLE}'!A1:ZZ500`);
    // Короткий лист — без лишнего предупреждения.
    const short = await callMcp(
      gcRead,
      { target: 'big', mode: 'map' },
      depsOf(google(sheetRows(40), 1000).api).deps,
    );
    expect((short.data as { warnings: string[] }).warnings.join(' ')).not.toContain(
      'построена по первым',
    );
  });

  it('шов: запись читает лист целиком — диапазон «лист» без строк, а не A1:ZZ500', async () => {
    const g = google(sheetRows(600), 1000);
    await callMcp(
      gcApply,
      {
        op: 'appendRow',
        target: 'big',
        values: { Компания: 'Новая', Статус: 'новая', Заметка: 'новая заметка' },
        dryRun: false,
      },
      depsOf(g.api).deps,
    );
    expect(g.reads).toContain(`'${TITLE}'`);
    expect(g.reads).not.toContain(`'${TITLE}'!A1:ZZ500`);
  });
});

describe('строка правки — одним запросом (D-26, Q10)', () => {
  const row = { Компания: 'Новая', Статус: 'новая', Заметка: 'новая заметка' };

  it('Q10: appendRow из трёх ячеек — один запрос batchUpdate, а не три', async () => {
    const g = google(sheetRows(20), 1000);
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'big', values: row, dryRun: false },
      depsOf(g.api).deps,
    );
    expect(result.data).toMatchObject({ status: 'ok' });
    expect(g.batches).toEqual([3]);
    expect(g.writes).toHaveLength(3);
  });

  it('Q10: запрос отказал — в листе ни одной ячейки строки, а не половина (M-1: A…J)', async () => {
    const g = google(sheetRows(20), 1000, true);
    const result = await callMcp(
      gcApply,
      { op: 'appendRow', target: 'big', values: row, dryRun: false },
      depsOf(g.api).deps,
    );
    expect(result.ok).toBe(false);
    expect(g.batches).toEqual([3]);
    expect(g.writes).toHaveLength(0);
  });
});
