/**
 * Подпись плана и конверт разрешений (D-18): примеры R2, R7, K8.
 *
 * Отдельным файлом, потому что гейт длины тестов (1000 строк) отклонил их житьё в
 * `sheets.test.ts` — и по делу: это про то, КТО разрешил запись, а не про то, что
 * записывается.
 */

import { describe, expect, it } from 'vitest';

import { buildSheetData } from '../src/core/sheets/map.js';
import { upsertRow } from '../src/core/sheets/rows.js';
import type { WriteRecord } from '../src/core/journal.js';
import type { CellValue, SpreadsheetSnapshot } from '../src/core/sheets/types.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

const NOW = new Date(2026, 8, 1, 10, 0, 0);
const aliases = { Часы: ['затрачено', 'time'] };
const data = () => buildSheetData(snapshot());

type Thrown = { payload: { code: string; cause?: string } };
const thrown = async (run: Promise<unknown>): Promise<Thrown> =>
  run.then(
    () => {
      throw new Error('ожидался отказ, а вызов прошёл');
    },
    (error: unknown) => error as Thrown,
  );

/** Клиент, у которого к моменту записи в ячейке уже другое значение: чужая правка. */
class AlteredClient extends FakeSheetsClient {
  constructor(private readonly altered: () => SpreadsheetSnapshot) {
    super();
  }
  override getSpreadsheet(): Promise<SpreadsheetSnapshot> {
    return Promise.resolve(this.altered());
  }
}

const withRow = (index: number, cells: CellValue[]): SpreadsheetSnapshot => {
  const book = snapshot();
  const sheet = book.sheets[0]!;
  const rows = sheet.rows.map((row, i) => (i === index ? cells.map((value) => ({ value })) : row));
  return { ...book, sheets: [{ ...sheet, rows }] };
};

describe('R7 — два превью одной правки на разных ревизиях (D-18)', () => {
  const key = { Проект: 'G connect' };

  it('R7 — код плана один и тот же: ревизия документа в подпись не входит', async () => {
    const client = new FakeSheetsClient();
    const on = (revisionId: string) => buildSheetData({ ...snapshot(), revisionId });
    const first = await upsertRow(client, on('37'), key, { Часы: 7 }, { now: NOW, aliases });
    const second = await upsertRow(client, on('39'), key, { Часы: 7 }, { now: NOW, aliases });

    expect(first.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(second.planId).toBe(first.planId);
    // Ревизия при этом не исчезает из ответа — она контекст, а не подпись.
    expect(first.baseRevision).toBe('37');
    expect(second.baseRevision).toBe('39');
    expect(client.writes).toHaveLength(0);
  });

  it('R2 — содержание правки код по-прежнему различает', async () => {
    const client = new FakeSheetsClient();
    const data9 = buildSheetData({ ...snapshot(), revisionId: '37' });
    const other = await upsertRow(client, data9, key, { Часы: 8 }, { now: NOW, aliases });
    const seven = await upsertRow(client, data9, key, { Часы: 7 }, { now: NOW, aliases });
    expect(other.planId).not.toBe(seven.planId);
  });
});

describe('K8 — предусловие D-17 внутри конверта (D-18)', () => {
  const key = { Проект: 'G connect' };
  const allow = {
    authorize: () => ({ authorized: true }) as const,
  };

  it('без кода плана, но с разрешением: чужая правка между планом и записью не затирается', async () => {
    // Смысл слайса 3: связь с показанным планом даёт один вызов ПЛЮС предусловие. Убери
    // предусловие — и боевой режим начнёт затирать чужое молча, а код плана этого уже
    // не поймает, потому что кода нет.
    const client = new AlteredClient(() => withRow(2, ['2026-09-01', 'G connect', 'пауза', 2]));
    const failure = await thrown(
      upsertRow(
        client,
        data(),
        key,
        { Статус: 'готово' },
        { now: NOW, aliases, dryRun: false, ...allow },
      ),
    );
    expect(failure.payload.code).toBe('stale_value');
    expect(failure.payload.cause).toBe('value_changed_after_preview');
    expect(client.writes).toHaveLength(0);
  });

  it('с разрешением и без чужой правки запись идёт с первого вызова и попадает в журнал', async () => {
    const client = new FakeSheetsClient();
    const journalled: WriteRecord[] = [];
    const outcome = await upsertRow(
      client,
      data(),
      key,
      { Часы: 7 },
      {
        now: NOW,
        aliases,
        dryRun: false,
        ...allow,
        journal: async (r) => {
          journalled.push(r);
        },
      },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.correlationId).toBeDefined();
    expect(journalled[0]?.correlationId).toBe(outcome.correlationId);
    expect(journalled[0]?.planId).toBe(outcome.planId);
    expect(client.writes).toHaveLength(1);
  });
});
