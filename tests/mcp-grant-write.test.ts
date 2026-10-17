/**
 * Право записи по разрешению проекта (D-23, слайс 3): X2, X5, X6, X8–X10 и создание в
 * «Моём диске» — через настоящий протокол (урок L26).
 *
 * Разрешение здесь подставлено готовым состоянием: подпись и её проверку судит
 * `tests/grant.test.ts` на настоящем ssh-keygen. Этот файл судит другое — что с
 * состоянием делает право записи: порядок «реестр → разрешение», конверт под ним,
 * разрушающее по фразе, отметку проекта в журнале и откат только своего.
 */

import { describe, expect, it } from 'vitest';

import { newGrant } from '../src/core/grant/document.js';
import type { GrantState } from '../src/core/grant/grants.js';
import type { WriteRecord } from '../src/core/journal.js';
import type { Registry } from '../src/core/targets.js';
import { gcApply, gcUndo, type ToolDeps } from '../src/mcp/tools.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp } from './fixtures/protocol.js';
import { FakeSheetsClient, MutableSheetsClient, snapshot } from './fixtures/sheet.js';

const PROJECT = '/Users/someone/Documents/Ahrefs cases';
const OTHER = '/Users/someone/Documents/portfolio-site';
const UNLISTED = 'https://docs.google.com/spreadsheets/d/1UNLISTEDsheetAAAAAAAAAAAAAAAA/edit';
const LOG_ID = '1LOGsheetBBBBBBBBBBBBBBBBBBBBBBB';

const registry: Registry = {
  targets: [
    { alias: 'log', id: LOG_ID, type: 'sheet', allow: 'write', sheet: 'Лист1', key: ['Проект'] },
    { alias: 'reference', id: '1REFsheetCCCCCCCCCCCCCCCCCCCCCCC', type: 'sheet', allow: 'read' },
    {
      alias: 'tight',
      id: LOG_ID,
      type: 'sheet',
      allow: 'write',
      sheet: 'Лист1',
      key: ['Проект'],
      auto: { ops: ['upsertRow'], maxCells: 1 },
    },
  ],
};

const granted = (project = PROJECT): GrantState => ({
  state: 'granted',
  grant: newGrant(project, 'default', new Date()),
});

const refused = (
  reason: 'no_grant' | 'other_project' | 'expired',
  expiredAt?: string,
): GrantState =>
  expiredAt === undefined
    ? { state: 'none', reason, detail: `проверка: ${reason}` }
    : { state: 'none', reason, detail: `разрешение истекло ${expiredAt}`, expiredAt };

interface Harness {
  readonly deps: ToolDeps;
  readonly client: FakeSheetsClient;
  readonly drive: FakeDriveClient;
  readonly journalled: WriteRecord[];
  readonly grantCalls: () => number;
}

const harness = (
  grant: GrantState,
  project: string | undefined = PROJECT,
  journalled: WriteRecord[] = [],
  live?: MutableSheetsClient,
): Harness => {
  const client = new FakeSheetsClient(snapshot());
  const drive = new FakeDriveClient();
  let calls = 0;
  const deps: ToolDeps = {
    account: 'default',
    // Откат сверяет ЖИВЫЕ ячейки: ему нужен клиент, применяющий записи (MutableSheetsClient).
    sheets: () => Promise.resolve(live ?? client),
    docs: () => Promise.reject(new Error('doc-целей в этом сьюте нет')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve(registry),
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('rev-1'),
    ...(project === undefined ? {} : { project }),
    grant: () => {
      calls += 1;
      return Promise.resolve(grant);
    },
  };
  return { deps, client, drive, journalled, grantCalls: () => calls };
};

const upsert = (target: string) => ({
  op: 'upsertRow',
  target,
  key: { Проект: 'G connect' },
  values: { Статус: 'готово' },
  dryRun: false,
});

describe('кто может писать: реестр или разрешение проекта', () => {
  it('X8: под разрешением цель вне реестра пишется с первой фразы, запись в журнале несёт проект', async () => {
    const { deps, client, journalled } = harness(granted());
    const result = await callMcp(gcApply, upsert(UNLISTED), deps);
    expect(result.ok).toBe(true);
    expect((result.data as { status: string }).status).toBe('ok');
    expect(client.writes.length).toBeGreaterThan(0);
    expect(journalled).toHaveLength(1);
    expect(journalled[0]?.project).toBe(PROJECT);
  });

  it('X2: без разрешения та же запись — needs_grant с действием для человека, ни одной записи', async () => {
    const { deps, client } = harness(refused('no_grant'));
    const result = await callMcp(gcApply, upsert(UNLISTED), deps);
    expect(result.error).toMatchObject({ code: 'needs_grant', cause: 'no_grant' });
    expect(result.error?.action?.kind).toBe('open_grant');
    expect(client.writes).toHaveLength(0);
  });

  it('X5, X6: причина отказа разрешения доходит до человека — чужой проект, истёкший срок с временем', async () => {
    const other = await callMcp(gcApply, upsert(UNLISTED), harness(refused('other_project')).deps);
    expect(other.error).toMatchObject({ code: 'needs_grant', cause: 'other_project' });
    const expired = await callMcp(
      gcApply,
      upsert(UNLISTED),
      harness(refused('expired', '2026-10-17T23:59:59+03:00')).deps,
    );
    expect(expired.error).toMatchObject({ code: 'needs_grant', cause: 'expired' });
    expect(expired.error?.detail).toContain('истекло 2026-10-17T23:59:59+03:00');
  });

  it('порядок: read-only цель реестра не пишется и под разрешением — write.allowlist', async () => {
    const { deps, client } = harness(granted());
    const result = await callMcp(gcApply, upsert('reference'), deps);
    expect(result.error).toMatchObject({ code: 'policy_denied', cause: 'write.allowlist' });
    expect(client.writes).toHaveLength(0);
  });

  it('цель реестра с allow: write не спрашивает разрешения вовсе — агент Secretive не нужен', async () => {
    const { deps, grantCalls } = harness(refused('no_grant'));
    const result = await callMcp(gcApply, upsert('log'), deps);
    expect(result.error?.code).not.toBe('needs_grant');
    expect(grantCalls()).toBe(0);
  });

  it('свой конверт цели сильнее конверта разрешения: maxCells=1 на двух ячейках — план и код', async () => {
    const { deps, client } = harness(granted());
    const result = await callMcp(
      gcApply,
      { ...upsert('tight'), values: { Статус: 'готово', Часы: 3 } },
      deps,
    );
    expect((result.data as { status: string }).status).toBe('confirm_required');
    expect(client.writes).toHaveLength(0);
  });

  it('X9: разрушающее под разрешением — план и просьба фразы; без неё записи нет', async () => {
    const { deps, client } = harness(granted());
    const result = await callMcp(
      gcApply,
      { op: 'deleteRows', target: UNLISTED, where: { Проект: 'G connect' }, dryRun: false },
      deps,
    );
    const data = result.data as { status: string; structural?: { confirmPhrase?: string } };
    expect(data.status).toBe('confirm_required');
    expect(data.structural?.confirmPhrase).toContain('удаляю');
    expect(client.writes).toHaveLength(0);
  });
});

describe('создание в «Моём диске» (T7)', () => {
  it('под разрешением таблица создаётся в корне Drive, и в неё сразу можно писать', async () => {
    const { deps, drive, journalled } = harness(granted());
    const created = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'Мой диск', name: 'Тест G connect', dryRun: false },
      deps,
    );
    expect(created.ok).toBe(true);
    expect(drive.created).toEqual([
      { id: 'FILE1', name: 'Тест G connect', kind: 'sheet', parentId: 'root' },
    ]);
    expect(journalled[0]?.project).toBe(PROJECT);
    const write = await callMcp(gcApply, upsert('https://drive.google.com/open?id=FILE1'), deps);
    expect((write.data as { status: string }).status).toBe('ok');
  });

  it('без разрешения «Мой диск» — только для чтения: needs_grant, файла нет', async () => {
    const { deps, drive } = harness(refused('no_grant'));
    const result = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'root', name: 'Тест', dryRun: false },
      deps,
    );
    expect(result.error?.code).toBe('needs_grant');
    expect(drive.created).toHaveLength(0);
  });
});

describe('таблица со шапкой и строкой текстом (X7, T11)', () => {
  const X7 = {
    op: 'createSheet',
    target: 'Мой диск',
    name: 'Тест G connect',
    columns: ['domain', 'period_start'],
    rows: [['x.com', '2025-06-01']],
  };

  it('превью называет шапку и строку, код плана меняется вместе с содержимым', async () => {
    const { deps, drive } = harness(granted());
    const preview = (await callMcp(gcApply, X7, deps)).data as { notes: string[]; planId: string };
    expect(preview.notes).toEqual(
      expect.arrayContaining(['Шапка: domain | period_start', '  x.com | 2025-06-01']),
    );
    const other = (await callMcp(gcApply, { ...X7, rows: [['y.com', '2025-06-01']] }, deps))
      .data as { planId: string };
    expect(other.planId).not.toBe(preview.planId);
    expect(drive.created).toHaveLength(0);
  });

  it('под разрешением — с первой фразы: файл в «Моём диске», шапка и строка текстом (RAW)', async () => {
    const { deps, drive, client, journalled } = harness(granted());
    const result = await callMcp(gcApply, { ...X7, dryRun: false }, deps);
    expect((result.data as { status: string }).status).toBe('ok');
    expect(drive.created[0]).toMatchObject({ name: 'Тест G connect', parentId: 'root' });
    expect(client.writes).toEqual([
      {
        id: 'FILE1',
        range: 'A1',
        values: [
          ['domain', 'period_start'],
          ['x.com', '2025-06-01'],
        ],
        input: 'raw',
      },
    ]);
    const notes = (result.data as { notes: string[] }).notes.join('\n');
    expect(notes).toContain('https://drive.google.com/open?id=FILE1');
    expect(notes).toContain('пишется сразу');
    const undone = await callMcp(gcUndo, { target: 'Мой диск' }, deps);
    expect((undone.data as { status: string }).status).toBe('ok');
    expect(drive.trashed).toEqual(['FILE1']);
    expect(journalled.at(-1)).toMatchObject({ op: 'undo', project: PROJECT });
  });

  it('сбой записи шапки не оставляет сироту без журнала: файл уходит в корзину', async () => {
    const { deps, drive, journalled } = harness(granted());
    const failing = new FakeSheetsClient(snapshot());
    failing.updateValues = () => Promise.reject(new Error('квота'));
    const result = await callMcp(
      gcApply,
      { ...X7, dryRun: false },
      { ...deps, sheets: () => Promise.resolve(failing) },
    );
    expect(result.ok).toBe(false);
    expect(drive.trashed).toEqual(['FILE1']);
    expect(journalled).toHaveLength(0);
  });

  it('строка длиннее шапки — вопрос, а не догадка; файл не создаётся', async () => {
    const { deps, drive } = harness(granted());
    const result = await callMcp(
      gcApply,
      { ...X7, rows: [['x.com', '2025-06-01', 'лишнее']], dryRun: false },
      deps,
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_wider_than_header' });
    expect(drive.created).toHaveLength(0);
  });

  it('содержимое сверх конверта (50 ячеек) — план и код, а не запись с первой фразы', async () => {
    const { deps, drive } = harness(granted());
    const rows = Array.from({ length: 30 }, (_, i) => [`site${i}.com`, '2025-06-01']);
    const result = await callMcp(gcApply, { ...X7, rows, dryRun: false }, deps);
    expect((result.data as { status: string }).status).toBe('confirm_required');
    expect(drive.created).toHaveLength(0);
  });
});

describe('откат видит только записи своего проекта (X10)', () => {
  /** Запись проекта OTHER: журнал и таблица общие — откат судит ту же таблицу, что писали. */
  const journalWithOther = async (): Promise<{
    journalled: WriteRecord[];
    client: MutableSheetsClient;
  }> => {
    const journalled: WriteRecord[] = [];
    const client = new MutableSheetsClient(snapshot());
    const { deps } = harness(granted(OTHER), OTHER, journalled, client);
    await callMcp(gcApply, upsert(UNLISTED), deps);
    expect(journalled[0]?.project).toBe(OTHER);
    return { journalled, client };
  };

  it('запись чужого проекта по id — отказ undo.own-project, а не откат', async () => {
    const { journalled, client } = await journalWithOther();
    const { deps } = harness(granted(), PROJECT, journalled, client);
    const result = await callMcp(
      gcUndo,
      { target: UNLISTED, record: journalled[0]?.correlationId },
      deps,
    );
    expect(result.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-project' });
    expect(result.error?.detail).toContain(OTHER);
  });

  it('без id — «своих записей нет», а не «журнал пуст» и не откат чужой', async () => {
    const { journalled, client } = await journalWithOther();
    const { deps } = harness(granted(), PROJECT, journalled, client);
    const result = await callMcp(gcUndo, { target: UNLISTED }, deps);
    expect(result.data).toMatchObject({ status: 'nothing_to_undo', reason: 'only_other_projects' });
  });

  it('свой проект откатывает свою запись', async () => {
    const { journalled, client } = await journalWithOther();
    const { deps } = harness(granted(OTHER), OTHER, journalled, client);
    const result = await callMcp(gcUndo, { target: UNLISTED }, deps);
    expect(result.error).toBeUndefined();
    expect((result.data as { status: string }).status).toBe('ok');
    expect(journalled.at(-1)).toMatchObject({ op: 'undo', project: OTHER });
  });
});
