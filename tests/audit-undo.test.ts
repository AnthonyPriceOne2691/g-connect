/** Примеры B9, B10, B11 спеки фазы 2: журнал и откат. */

import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRecord,
  auditDir,
  auditFile,
  fileJournalSource,
  recentRecords,
} from '../src/core/audit.js';
import { lastUndoable, noopJournal, type WriteRecord } from '../src/core/journal.js';
import { buildSheetData, buildSheetMap } from '../src/core/sheets/map.js';
import { upsertRow } from '../src/core/sheets/rows.js';
import { undoLast } from '../src/core/undo.js';
import { FakeSheetsClient, MutableSheetsClient, snapshot } from './fixtures/sheet.js';

const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  process.env['GCONNECT_HOME'] = await mkdtemp(join(tmpdir(), 'gconnect-audit-'));
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

const record = (over: Partial<WriteRecord> = {}): WriteRecord => ({
  at: '2026-09-01T10:00:00.000Z',
  account: 'default',
  targetId: 'SHEET1',
  alias: 'log',
  sheet: 'Лист1',
  op: 'upsertRow',
  changes: [{ a1: 'Лист1!D3', column: 'Часы', before: 2, after: 3 }],
  revisionBefore: 'rev-1',
  revisionAfter: 'rev-2',
  correlationId: 'gc-aaa',
  ...over,
});

describe('B11 — аудит-лог', () => {
  it('строка дописывается в файл месяца с правами 600 в каталоге 700', async () => {
    await appendRecord(record());
    const path = auditFile(new Date('2026-09-01T10:00:00.000Z'));
    expect(path.endsWith('2026-09.jsonl')).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(auditDir())).mode & 0o777).toBe(0o700);

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as WriteRecord;
    expect(parsed).toMatchObject({ targetId: 'SHEET1', op: 'upsertRow', account: 'default' });
  });

  it('журнал не принимает секреты — попытка падает, а не «пишется на всякий случай»', async () => {
    await expect(
      appendRecord(
        record({
          changes: [{ a1: 'Лист1!A1', column: 'refresh_token', before: null, after: 'секрет' }],
        }),
      ),
    ).rejects.toMatchObject({ payload: { cause: 'secret_in_audit' } });
  });

  it('запись через upsertRow с dryRun:false попадает в журнал целиком', async () => {
    const written: WriteRecord[] = [];
    const client = new FakeSheetsClient();
    await upsertRow(
      client,
      buildSheetData(snapshot()),
      { Проект: 'G connect' },
      { Часы: 7 },
      {
        dryRun: false,
        journal: async (r) => {
          written.push(r);
        },
        account: 'default',
        alias: 'log',
        readRevision: () => Promise.resolve('rev-2'),
      },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      op: 'upsertRow',
      sheet: 'Лист1',
      revisionBefore: 'rev-1',
      revisionAfter: 'rev-2',
    });
    expect(written[0]?.changes[0]).toMatchObject({ column: 'Часы', before: 2, after: 7 });
    expect(written[0]?.correlationId).toMatch(/^gc-/);
  });

  it('превью в журнал не попадает: записи не было — записи и нет', async () => {
    const written: WriteRecord[] = [];
    await upsertRow(
      new FakeSheetsClient(),
      buildSheetData(snapshot()),
      { Проект: 'G connect' },
      { Часы: 7 },
      {
        journal: async (r) => {
          written.push(r);
        },
      },
    );
    expect(written).toHaveLength(0);
  });

  it('пустой план не журналируется: «изменений нет» не событие', async () => {
    const written: WriteRecord[] = [];
    await upsertRow(
      new FakeSheetsClient(),
      buildSheetData(snapshot()),
      { Проект: 'G connect' },
      { Часы: 2 },
      {
        dryRun: false,
        journal: async (r) => {
          written.push(r);
        },
      },
    );
    expect(written).toHaveLength(0);
  });

  it('история читается по цели и в порядке старые → новые', async () => {
    await appendRecord(record({ correlationId: 'gc-1', at: '2026-09-01T10:00:00.000Z' }));
    await appendRecord(record({ correlationId: 'gc-2', at: '2026-09-01T11:00:00.000Z' }));
    await appendRecord(record({ correlationId: 'gc-3', targetId: 'OTHER' }));
    const history = await recentRecords('SHEET1', 10, new Date('2026-09-15T00:00:00.000Z'));
    expect(history.map((r) => r.correlationId)).toEqual(['gc-1', 'gc-2']);
  });

  it('битая строка не роняет чтение журнала', async () => {
    await appendRecord(record({ correlationId: 'gc-1' }));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(auditFile(new Date('2026-09-01T10:00:00.000Z')), 'не json\n');
    await appendRecord(record({ correlationId: 'gc-2' }));
    const history = await recentRecords('SHEET1', 10, new Date('2026-09-15T00:00:00.000Z'));
    expect(history.map((r) => r.correlationId)).toEqual(['gc-1', 'gc-2']);
  });
});

describe('B9 — откат возвращает значения', () => {
  it('запись → undo → в таблице снова прежние значения', async () => {
    const client = new MutableSheetsClient(snapshot());
    const journalled: WriteRecord[] = [];
    const sink = async (r: WriteRecord): Promise<void> => {
      journalled.push(r);
    };

    const before = buildSheetMap(await client.getSpreadsheet()).sampleRows[0]?.['Часы'];
    await upsertRow(
      client,
      buildSheetData(await client.getSpreadsheet()),
      { Проект: 'G connect' },
      { Часы: 99 },
      { dryRun: false, journal: sink, readRevision: () => Promise.resolve('rev-1') },
    );
    expect(buildSheetMap(await client.getSpreadsheet()).sampleRows[0]?.['Часы']).toBe(99);

    const outcome = await undoLast(
      client,
      'SHEET_ID',
      {
        recent: () => Promise.resolve(journalled),
      },
      { currentRevision: 'rev-1', journal: sink },
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.restored[0]).toMatchObject({ column: 'Часы', value: before });
    expect(buildSheetMap(await client.getSpreadsheet()).sampleRows[0]?.['Часы']).toBe(before);
    // Обе записи в журнале: сама правка и её откат со ссылкой на неё.
    expect(journalled).toHaveLength(2);
    expect(journalled[1]).toMatchObject({ op: 'undo', undoOf: journalled[0]?.correlationId });
  });

  it('откатывать нечего → говорит об этом, а не делает вид, что откатил', async () => {
    const outcome = await undoLast(new FakeSheetsClient(), 'SHEET1', {
      recent: () => Promise.resolve([]),
    });
    expect(outcome.status).toBe('nothing_to_undo');
    expect(outcome.restored).toHaveLength(0);
  });

  it('дважды подряд один и тот же откат не проходит: второй вернул бы чужое состояние', async () => {
    const first = record({ correlationId: 'gc-1' });
    const undoEntry = record({ correlationId: 'gc-2', op: 'undo', undoOf: 'gc-1' });
    expect(lastUndoable([first, undoEntry])).toBeNull();
    expect(lastUndoable([first])?.correlationId).toBe('gc-1');
  });
});

describe('B10 — откат при чужих правках', () => {
  it('с явным force человек берёт ответственность — откат идёт', async () => {
    const client = new FakeSheetsClient();
    const outcome = await undoLast(
      client,
      'SHEET1',
      {
        recent: () => Promise.resolve([record()]),
      },
      { currentRevision: 'rev-99', force: true, journal: noopJournal },
    );
    expect(outcome.status).toBe('ok');
    expect(client.writes).toHaveLength(1);
  });

  it('источник по файлу подключается тем же контрактом', async () => {
    await appendRecord(record());
    const history = await fileJournalSource.recent('SHEET1', 10);
    expect(history).toHaveLength(1);
  });
});
