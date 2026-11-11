/**
 * Новые строки — со списком строки-образца (D-26, Q43, Q44).
 *
 * Весть сессии parsing-and-outri-83: во вставленной строке задачи статус «Готово» — просто текст, а в
 * прошлых строках колонки «Статус задачи» — выпадающий список. `insertRows` наследует вид соседней
 * строки (строки дня — у неё списка нет), а `PASTE_FORMAT` проверку данных не переносит (документация
 * Google: «Paste the format only, excluding data validation»). Теперь `insertRows` с `likeRow: N`
 * копирует вид и список строки N тем же `batchUpdate`, что вставка, а дозапись берёт у строки над
 * собой и список.
 */

import { describe, expect, it } from 'vitest';

import { toRequest } from '../src/core/google/requests.js';
import { parseOperation } from '../src/core/ops.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { appendRow } from '../src/core/sheets/rows.js';
import { insertRows } from '../src/core/sheets/structure-op.js';
import type { Cell, CellFormat, SheetSnapshot } from '../src/core/sheets/types.js';
import { ID, book } from './fixtures/daily-report.js';
import { FakeSheetsClient } from './fixtures/sheet.js';

const STATUSES = ['Готово', 'Готова частично', 'В работе', 'На доработке'];
const DAY: CellFormat = { bold: true, background: '#d9ead3' };
const TASK: CellFormat = { fontFamily: 'Carlito', fontSize: 10 };
const CONFIRMED = { dryRun: false, authorize: () => ({ authorized: true }) as const };

const line = (values: readonly (string | null)[], format?: CellFormat): Cell[] =>
  values.map((value) => ({ value, ...(format === undefined ? {} : { format }) }));

/** Лист отчёта: A1 пуста, строка 2 — день, 3–4 — задачи со списком в E («Статус задачи»). */
function reportSheet(): SheetSnapshot {
  return {
    title: 'Отчёт',
    sheetId: 7,
    rows: [
      line([null, 'Суть задачи', 'Время', 'Ссылка', 'Статус задачи', 'Проверка']),
      line(['19.10.2026', null, null, null, null, null], DAY),
      line(['задача 1', 'суть 1', '1:00', 'ссылка', 'Готово', 'да'], TASK),
      line(['задача 2', 'суть 2', '0:30', 'ссылка', 'В работе', 'нет'], TASK),
    ],
    validations: [
      { range: { startRow: 3, endRow: 4, startColumn: 4, endColumn: 4 }, values: STATUSES },
    ],
  };
}

const client = () => new FakeSheetsClient(book(reportSheet()));
const data = () => buildSheetData(book(reportSheet()), { headerRow: 1 });
const row = (at: number, rowCount = 1) => ({ row: at, column: 0, rowCount, columnCount: 6 });

/** Список колонки «Статус задачи» (E) в строке листа — как его держит фейк, или `null`. */
async function listAt(fake: FakeSheetsClient, at: number): Promise<readonly string[] | null> {
  const rules = (await fake.getSpreadsheet(ID)).sheets[0]?.validations ?? [];
  const rule = rules.find(
    ({ range }) =>
      at >= range.startRow && at <= range.endRow && range.startColumn <= 4 && range.endColumn >= 4,
  );
  return rule?.values ?? null;
}

describe('Q43 — insertRows с likeRow: вид и список строки-образца (D-26)', () => {
  it('Q43: две строки над днём «как строка задачи 3» — вставка и две копии одним batchUpdate, образец сдвинут вставкой', async () => {
    const fake = client();
    const outcome = await insertRows(fake, data(), { '(A)': '19.10.2026' }, 2, {
      ...CONFIRMED,
      likeRow: 3,
    });
    expect(outcome.status).toBe('ok');
    // Образец 3 — ниже места вставки (2): после вставки двух строк он — 5-я.
    expect(fake.formatWrites).toEqual([
      { kind: 'insertDimension', sheetId: 7, dimension: 'rows', at: 2, count: 2 },
      { kind: 'copyPaste', sheetId: 7, source: row(5), destination: row(2, 2), paste: 'format' },
      {
        kind: 'copyPaste',
        sheetId: 7,
        source: row(5),
        destination: row(2, 2),
        paste: 'validation',
      },
    ]);
    const sheet = (await fake.getSpreadsheet(ID)).sheets[0];
    expect(sheet?.rows[1]?.[4]?.format).toEqual(TASK);
    expect(sheet?.rows[2]?.[0]?.format).toEqual(TASK);
    expect(await listAt(fake, 2)).toEqual(STATUSES);
    expect(await listAt(fake, 3)).toEqual(STATUSES);
  });

  it('Q43: образец выше места вставки — номер не сдвигается', async () => {
    const fake = client();
    await insertRows(fake, data(), { '(A)': 'задача 2' }, 1, {
      ...CONFIRMED,
      below: true,
      likeRow: 3,
    });
    expect(fake.formatWrites.slice(1)).toEqual([
      { kind: 'copyPaste', sheetId: 7, source: row(3), destination: row(5), paste: 'format' },
      { kind: 'copyPaste', sheetId: 7, source: row(3), destination: row(5), paste: 'validation' },
    ]);
    expect(await listAt(fake, 5)).toEqual(STATUSES);
  });

  it('Q43: превью называет копию вида и списка; записи нет', async () => {
    const fake = client();
    const preview = await insertRows(fake, data(), { '(A)': '19.10.2026' }, 1, { likeRow: 3 });
    expect(preview.status).toBe('preview');
    expect(preview.notes).toContain('оформление и проверка данных строки 2 — как у строки 3');
    expect(fake.formatWrites).toEqual([]);
  });

  it('Q43: без likeRow — только вставка, как раньше: вид — от соседней строки, списка нет', async () => {
    const fake = client();
    const outcome = await insertRows(fake, data(), { '(A)': '19.10.2026' }, 1, CONFIRMED);
    expect(outcome.notes).not.toContain('оформление и проверка данных строки 2 — как у строки 3');
    expect(fake.formatWrites).toEqual([
      { kind: 'insertDimension', sheetId: 7, dimension: 'rows', at: 2, count: 1 },
    ]);
    expect(await listAt(fake, 2)).toBeNull();
  });

  it.each([
    [1, 'шапка'],
    [9, 'вне строк данных'],
  ])(
    'Q43: likeRow %i (%s) — отказ like_row_outside_data, ничего не вставлено',
    async (likeRow, place) => {
      const fake = client();
      await expect(
        insertRows(fake, data(), { '(A)': '19.10.2026' }, 1, { ...CONFIRMED, likeRow }),
      ).rejects.toMatchObject({
        payload: { code: 'bad_request', cause: 'like_row_outside_data' },
      });
      await expect(
        insertRows(fake, data(), { '(A)': '19.10.2026' }, 1, { likeRow }),
      ).rejects.toMatchObject({ payload: { detail: expect.stringContaining(place) as unknown } });
      expect(fake.formatWrites).toEqual([]);
    },
  );

  it('Q43: граница — likeRow целое больше нуля; в операции он доходит до ядра', () => {
    const base = { op: 'insertRows', target: 'reg', where: { '(A)': '19.10.2026' } };
    for (const likeRow of [0, -1, 2.5, 'три']) {
      expect(() => parseOperation({ ...base, likeRow })).toThrow();
    }
    expect(parseOperation({ ...base, likeRow: 3 })).toMatchObject({ op: 'insertRows', likeRow: 3 });
  });

  it('Q43: шов — копия списка уходит в Google как PASTE_DATA_VALIDATION', () => {
    const request = toRequest({
      kind: 'copyPaste',
      sheetId: 7,
      source: row(5),
      destination: row(2, 2),
      paste: 'validation',
    });
    expect(request).toEqual({
      copyPaste: {
        source: {
          sheetId: 7,
          startRowIndex: 4,
          endRowIndex: 5,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        destination: {
          sheetId: 7,
          startRowIndex: 1,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        pasteType: 'PASTE_DATA_VALIDATION',
      },
    });
  });
});

describe('Q44 — дописанная строка берёт у строки над собой и список (D-26)', () => {
  it('Q44: appendRow под строкой задачи — вид и список «Статуса задачи» в новой строке', async () => {
    const fake = client();
    const outcome = await appendRow(
      fake,
      data(),
      { '(A)': 'задача 3', 'Статус задачи': 'В работе' },
      CONFIRMED,
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.notes).toContain('оформление строки 5 — как у строки 4, с проверкой данных');
    expect(fake.formatWrites.map((r) => (r.kind === 'copyPaste' ? r.paste : r.kind))).toEqual([
      'format',
      'validation',
    ]);
    expect(await listAt(fake, 5)).toEqual(STATUSES);
  });
});
