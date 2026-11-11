/**
 * Куда создавать (D-26, Q20–Q22): голый ID папки — в ней, не папка — отказ, корень — только явно.
 *
 * Весть сессии portfolio-site-38 (19.10, профиль work, под разрешением проекта): `createFolder`
 * с голым ID папки общего диска ответил `ok`, а папка легла в корень «Моего диска»; тот же вызов
 * со ссылкой на папку создал где нужно, а откат находился только по `"root"`. Класс — «молчаливый
 * откат к корню»: вид голого ID неизвестен, и ядро звало Drive без родителя, а Drive кладёт такое
 * в корень.
 *
 * Шов `fileKind` судится на форме ответа Google через внедрённый API Drive (урок L28): файл
 * общего диска без `supportsAllDrives` для Drive не существует. Запись — через настоящий протокол
 * (урок L26). Откат по ID папки — на фейке Drive и журнале, который, как настоящий, отдаёт записи
 * ПО ЦЕЛИ: журнал «всё подряд» нашёл бы запись под `root` по любому ID, и оракул был бы кругом.
 */

import type { drive_v3 } from 'googleapis';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CreateInput } from '../src/core/create-op.js';
import { createParentOf } from '../src/core/create-parent.js';
import { gcError } from '../src/core/errors.js';
import { newGrant } from '../src/core/grant/document.js';
import type { GrantState } from '../src/core/grant/grants.js';
import { GoogleDriveClient, type DriveClient, type DriveFile } from '../src/core/google/drive.js';
import type { WriteRecord } from '../src/core/journal.js';
import { resolveTarget, type Registry } from '../src/core/targets.js';
import { gcApply, gcUndo, type ToolDeps } from '../src/mcp/tools.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp } from './fixtures/protocol.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

const PROJECT = '/Users/someone/Documents/portfolio-site';
/** Папка общего диска из вести — голым ID, без ссылки. */
const SHARED_ID = '1ldDcKU7sharedDriveFolderAAAAAAAA';
const OTHER_ID = '1OTHERfileBBBBBBBBBBBBBBBBBBBBBBBB';
const MISSING_ID = '1MISSINGfileCCCCCCCCCCCCCCCCCCCCC';
const LOCKED_ID = '1LOCKEDfileDDDDDDDDDDDDDDDDDDDDDDD';
const PROJECTS_ID = '1PROJECTSfolderGGGGGGGGGGGGGGGGGG';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const DOC_MIME = 'application/vnd.google-apps.document';

/** Что о папке из вести знает фейк Drive: вид и имя, как их назвал бы `files.get`. */
const KNOWN_FOLDER: Readonly<Record<string, Omit<DriveFile, 'id'>>> = {
  [SHARED_ID]: { name: 'Проекты 2026', type: 'folder', mimeType: FOLDER_MIME },
};

const registry: Registry = {
  targets: [
    { alias: 'log', id: '1LOGsheetEEEEEEEEEEEEEEEEEEEEEEEEE', type: 'sheet', allow: 'write' },
    { alias: 'mystery', id: '1MYSTERYfileFFFFFFFFFFFFFFFFFFFFF', type: 'unknown', allow: 'write' },
    // Папка реестра без конверта: создание в ней — по коду плана.
    { alias: 'projects', id: PROJECTS_ID, type: 'folder', allow: 'write' },
  ],
};

/** Папка «ТЗ» из вести; `dryRun: false` под разрешением проекта пишет с первой фразы. */
const folderIn = (target: string) => ({ op: 'createFolder', target, name: 'ТЗ', dryRun: false });

interface Outcome {
  readonly status: string;
  readonly planId: string | null;
  readonly assumptions: readonly string[];
  readonly notes: readonly string[];
  readonly structural?: { readonly anchor?: string };
  readonly correlationId?: string;
}

const granted = (): GrantState => ({
  state: 'granted',
  grant: newGrant(PROJECT, 'work', new Date()),
});

const noGrant: GrantState = { state: 'none', reason: 'no_grant', detail: 'проверка: no_grant' };

interface Harness {
  readonly deps: ToolDeps;
  readonly journalled: WriteRecord[];
  /** Сколько раз спросили ревизию таблицы: у папки её нет (живьём — 404). */
  readonly revisions: () => number;
  /** Сколько раз спросили разрешение проекта: за отказ «не папка» касание не просят. */
  readonly grants: () => number;
}

function harness(drive: DriveClient, grant: GrantState = granted()): Harness {
  const journalled: WriteRecord[] = [];
  let revisions = 0;
  let grants = 0;
  const deps: ToolDeps = {
    account: 'work',
    project: PROJECT,
    grant: () => {
      grants += 1;
      return Promise.resolve(grant);
    },
    sheets: () => Promise.resolve(new FakeSheetsClient(snapshot())),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve(registry),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    // Как настоящий `fileJournalSource`: записи ПО ЦЕЛИ.
    journalSource: {
      recent: (targetId, limit) =>
        Promise.resolve(journalled.filter((r) => r.targetId === targetId).slice(-limit)),
    },
    revision: () => {
      revisions += 1;
      return Promise.resolve('rev-1');
    },
  };
  return { deps, journalled, revisions: () => revisions, grants: () => grants };
}

interface GoogleFile {
  readonly name: string;
  readonly mimeType: string;
  /** Файл общего диска: без `supportsAllDrives` Drive его не отдаёт — 404, как чужой. */
  readonly sharedDrive?: boolean;
  /** Файл виден, а доступа нет — 403. */
  readonly denied?: boolean;
}

interface DriveCall {
  readonly method: 'get' | 'create';
  readonly params: Record<string, unknown>;
}

const SHARED_FOLDER: Readonly<Record<string, GoogleFile>> = {
  [SHARED_ID]: { name: 'Проекты 2026', mimeType: FOLDER_MIME, sharedDrive: true },
};

/** Настоящий `GoogleDriveClient` на Drive, отвечающем как Google; вызовы — по порядку. */
function googleDrive(files: Readonly<Record<string, GoogleFile>>) {
  const calls: DriveCall[] = [];
  const failure = (code: number, message: string) =>
    Promise.reject(Object.assign(new Error(message), { code }));
  const api = {
    files: {
      get: (params: { fileId: string; fields?: string; supportsAllDrives?: boolean }) => {
        calls.push({ method: 'get', params });
        const file = files[params.fileId];
        if (
          file === undefined ||
          (file.sharedDrive === true && params.supportsAllDrives !== true)
        ) {
          return failure(404, `File not found: ${params.fileId}.`);
        }
        if (file.denied === true) {
          return failure(
            403,
            `The user does not have sufficient permissions for file ${params.fileId}.`,
          );
        }
        // Поля — только запрошенные, как у Drive: без `mimeType` в `fields` вида в ответе нет.
        const all: Record<string, string> = {
          id: params.fileId,
          name: file.name,
          mimeType: file.mimeType,
        };
        const wanted = (params.fields ?? 'id,name,mimeType').split(',');
        return Promise.resolve({
          data: Object.fromEntries(wanted.map((field) => [field, all[field]])),
        });
      },
      create: (params: { requestBody: { name: string } }) => {
        calls.push({ method: 'create', params });
        return Promise.resolve({
          data: {
            id: 'NEW1',
            name: params.requestBody.name,
            webViewLink: 'https://drive.google.com/drive/folders/NEW1',
          },
        });
      },
    },
  } as unknown as drive_v3.Drive;
  return { client: new GoogleDriveClient({ accessToken: 'нет', api }), calls };
}

/** Подсказка одна на все отказы создания (Q21): чем назвать папку — тремя способами. */
function expectFolderHint(detail: string | undefined): void {
  expect(detail).toContain('ссылкой на неё (https://drive.google.com/drive/folders/<id папки>)');
  expect(detail).toContain('папкой реестра с правом записи');
  expect(detail).toContain('"root" — «Мой диск» под разрешением проекта');
}

/** Запись создания до починки: голый ID ушёл в корень, журнал — под root (как в вести). */
const createdBeforeFix = (): WriteRecord => ({
  at: new Date().toISOString(),
  account: 'work',
  targetId: 'root',
  alias: null,
  sheet: 'ТЗ',
  op: 'createFile',
  changes: [],
  revisionBefore: null,
  revisionAfter: null,
  correlationId: 'gc-before-fix',
  project: PROJECT,
  structure: { kind: 'createFile', sheet: 'ТЗ', title: 'ТЗ', fileId: 'OLD1' },
});

describe('Q20 — голый ID папки: создание в ней, журнал под её ID', () => {
  it.each([
    ['голый ID', SHARED_ID],
    ['ссылка open?id=', `https://drive.google.com/open?id=${SHARED_ID}`],
  ])(
    'Q20: %s папки общего диска — папка ложится в неё: вид — у Drive с supportsAllDrives, родитель — шву',
    async (_, target) => {
      const google = googleDrive(SHARED_FOLDER);
      const { deps } = harness(google.client);
      const result = await callMcp(gcApply, folderIn(target), deps);
      expect(result.error).toBeUndefined();
      expect((result.data as Outcome).status).toBe('ok');
      // Порядок закреплён (L11): вид — до создания; создание — с родителем.
      expect(google.calls.map((call) => call.method)).toEqual(['get', 'create']);
      expect(google.calls[0]?.params).toEqual({
        fileId: SHARED_ID,
        fields: 'id,name,mimeType',
        supportsAllDrives: true,
      });
      expect(google.calls[1]?.params).toMatchObject({
        supportsAllDrives: true,
        requestBody: { name: 'ТЗ', mimeType: FOLDER_MIME, parents: [SHARED_ID] },
      });
    },
  );

  it('Q20: ответ называет папку именем от Drive — в плане и в том, как ядро поняло цель', async () => {
    const google = googleDrive(SHARED_FOLDER);
    const { deps } = harness(google.client);
    const preview = (await callMcp(gcApply, { ...folderIn(SHARED_ID), dryRun: true }, deps))
      .data as Outcome;
    expect(preview.status).toBe('preview');
    expect(preview.structural?.anchor).toBe('папку «ТЗ» в папке «Проекты 2026»');
    expect(preview.assumptions).toEqual([
      `Цель ${SHARED_ID} — папка «Проекты 2026»: вид и имя — по ответу Drive.`,
    ]);
    // Превью ничего не обещает: «Создано» и ссылка — только по факту записи.
    expect(preview.notes).toEqual([]);
    const written = (await callMcp(gcApply, folderIn(SHARED_ID), deps)).data as Outcome;
    expect(written).toMatchObject({
      status: 'ok',
      structural: { anchor: preview.structural?.anchor },
      assumptions: preview.assumptions,
    });
    // Превью ничего не создаёт: `files.create` — один раз, от записи.
    expect(google.calls.filter((call) => call.method === 'create')).toHaveLength(1);
  });

  it('Q20: журнал — под ID папки: gc_undo по этому ID и id записи находит созданное', async () => {
    const drive = new FakeDriveClient(KNOWN_FOLDER);
    const { deps, journalled, revisions } = harness(drive);
    const created = (await callMcp(gcApply, folderIn(SHARED_ID), deps)).data as Outcome;
    expect(created.status).toBe('ok');
    expect(drive.created).toEqual([
      { id: 'FILE1', name: 'ТЗ', kind: 'folder', parentId: SHARED_ID },
    ]);
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toMatchObject({
      op: 'createFile',
      targetId: SHARED_ID,
      project: PROJECT,
      correlationId: created.correlationId,
    });
    // Вид назвал Drive — дальше это папка: ревизию таблицы у неё не спрашивают.
    expect(revisions()).toBe(0);
    const undone = await callMcp(
      gcUndo,
      { target: SHARED_ID, record: created.correlationId },
      deps,
    );
    expect(undone.data).toMatchObject({ status: 'ok', undoneCorrelationId: created.correlationId });
    expect(drive.trashed).toEqual(['FILE1']);
  });

  it('Q20: старые записи под root не тронуты — откатываются по "root", как прежде', async () => {
    const drive = new FakeDriveClient(KNOWN_FOLDER);
    const { deps, journalled } = harness(drive);
    journalled.push(createdBeforeFix());
    const byFolder = await callMcp(gcUndo, { target: SHARED_ID }, deps);
    expect(byFolder.data).toMatchObject({ status: 'nothing_to_undo', reason: 'journal_empty' });
    const byRoot = await callMcp(gcUndo, { target: 'root' }, deps);
    expect(byRoot.data).toMatchObject({ status: 'ok', undoneCorrelationId: 'gc-before-fix' });
    expect(drive.trashed).toEqual(['OLD1']);
  });
});

describe('Q21 — не папка или нет доступа: отказ до создания, ничего не создано', () => {
  it.each([
    ['таблицы', SHEET_MIME, 'таблица'],
    ['документа', DOC_MIME, 'документ'],
    ['файла PDF', 'application/pdf', 'файл application/pdf'],
  ])(
    'Q21: голый ID %s — отказ create_needs_folder с видом от Drive; files.create не звали',
    async (_, mimeType, kind) => {
      const google = googleDrive({ [OTHER_ID]: { name: 'Бюджет', mimeType } });
      const { deps } = harness(google.client);
      const result = await callMcp(gcApply, folderIn(OTHER_ID), deps);
      expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
      expect(result.error?.detail).toContain(
        `Цель ${OTHER_ID} — ${kind} «Бюджет», а не папка (по ответу Drive)`,
      );
      expect(result.error?.detail).toContain('ничего не создано');
      expectFolderHint(result.error?.detail);
      expect(google.calls.map((call) => call.method)).toEqual(['get']);
    },
  );

  it.each([
    ['не нашёл', MISSING_ID, 404, 'not_found'],
    ['не даёт доступа к', LOCKED_ID, 403, 'forbidden'],
  ])(
    'Q21: Drive %s ID — отказ с той же подсказкой, а не корень; files.create не звали',
    async (_, id, status, code) => {
      const google = googleDrive({
        [LOCKED_ID]: { name: 'Чужое', mimeType: FOLDER_MIME, denied: true },
      });
      const { deps } = harness(google.client);
      const result = await callMcp(gcApply, folderIn(id), deps);
      expect(result.error).toMatchObject({
        code,
        cause: expect.stringContaining(`HTTP ${status}`),
      });
      expect(result.error?.detail).toContain(`Drive этого профиля не видит ${id}`);
      expect(result.error?.detail).toContain('Ничего не создано, и в корне «Мой диск» тоже.');
      expectFolderHint(result.error?.detail);
      expect(google.calls.map((call) => call.method)).toEqual(['get']);
    },
  );

  it('Q21: сбой Google при вопросе о виде — как есть: не «нет доступа» и не корень', async () => {
    const drive = new FakeDriveClient(KNOWN_FOLDER);
    drive.fileKind = () =>
      Promise.reject(gcError('google_unavailable', { cause: 'HTTP 503: Backend Error' }));
    const { deps } = harness(drive);
    const result = await callMcp(gcApply, folderIn(SHARED_ID), deps);
    expect(result.error).toMatchObject({
      code: 'google_unavailable',
      cause: 'HTTP 503: Backend Error',
      retryable: true,
    });
    expect(result.error?.detail).toBeUndefined();
    expect(drive.created).toEqual([]);
  });

  it('Q21: чужая ошибка шва — как есть: «не видит» говорится только об ответе Drive', async () => {
    const broken = new TypeError('сокет закрыт');
    const drive = new FakeDriveClient(KNOWN_FOLDER);
    drive.fileKind = () => Promise.reject(broken);
    await expect(
      createParentOf(resolveTarget(SHARED_ID), () => Promise.resolve(drive)),
    ).rejects.toBe(broken);
  });

  it('Q21: отказ «не папка» — уже в превью: ни плана, ни кода, ни файла', async () => {
    const google = googleDrive({ [OTHER_ID]: { name: 'Бюджет', mimeType: SHEET_MIME } });
    const { deps } = harness(google.client);
    const result = await callMcp(
      gcApply,
      { op: 'createSheet', target: OTHER_ID, name: 'Октябрь' },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBe('create_needs_folder');
    expect(google.calls.map((call) => call.method)).toEqual(['get']);
  });

  it('Q21: ссылка на таблицу без разрешения — отказ «не папка» сразу: касания за него не просят', async () => {
    const drive = new FakeDriveClient(KNOWN_FOLDER);
    const { deps, grants } = harness(drive, noGrant);
    const result = await callMcp(
      gcApply,
      folderIn(`https://docs.google.com/spreadsheets/d/${OTHER_ID}/edit`),
      deps,
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
    expect(grants()).toBe(0);
    expect(drive.asked).toEqual([]);
  });

  it('Q21: голый ID без разрешения — сначала право: needs_grant, Drive не спрашивают', async () => {
    const drive = new FakeDriveClient(KNOWN_FOLDER);
    const { deps } = harness(drive, noGrant);
    const result = await callMcp(gcApply, folderIn(SHARED_ID), deps);
    expect(result.error?.code).toBe('needs_grant');
    expect(drive.asked).toEqual([]);
    expect(drive.created).toEqual([]);
  });
});

describe('Q22 — корень только явно, родитель назван всегда', () => {
  it.each(['Мой диск', 'root'])(
    'Q22: корень — только явной целью: «%s» создаёт в корне, root назван шву явно',
    async (target) => {
      const google = googleDrive({});
      const { deps, journalled } = harness(google.client);
      const result = await callMcp(gcApply, folderIn(target), deps);
      // Вид назван самой целью — допущений нет, и ответ их не выдумывает.
      expect(result.data).toMatchObject({
        status: 'ok',
        assumptions: [],
        structural: { anchor: 'папку «ТЗ» в Мой диск' },
      });
      // Вид «Моего диска» известен без Drive: спрашивать не о чем.
      expect(google.calls.map((call) => call.method)).toEqual(['create']);
      expect(google.calls[0]?.params).toMatchObject({ requestBody: { parents: ['root'] } });
      expect(journalled[0]?.targetId).toBe('root');
    },
  );

  it.each([
    [
      'ссылка на папку',
      `https://drive.google.com/drive/folders/${SHARED_ID}`,
      SHARED_ID,
      SHARED_ID,
    ],
    ['папка реестра', 'projects', PROJECTS_ID, 'projects'],
  ])(
    'Q22: %s — как прежде: создание в ней, под её именем в плане; Drive не спрашивают',
    async (_, target, id, where) => {
      const drive = new FakeDriveClient();
      const { deps, journalled } = harness(drive);
      const preview = (await callMcp(gcApply, { ...folderIn(target), dryRun: true }, deps))
        .data as Outcome;
      expect(preview.structural?.anchor).toBe(`папку «ТЗ» в ${where}`);
      const confirmed = { ...folderIn(target), confirm: preview.planId };
      expect((await callMcp(gcApply, confirmed, deps)).data).toMatchObject({ status: 'ok' });
      expect(drive.asked).toEqual([]);
      expect(drive.created).toEqual([{ id: 'FILE1', name: 'ТЗ', kind: 'folder', parentId: id }]);
      expect(journalled[0]?.targetId).toBe(id);
    },
  );

  it.each([
    ['таблицу', `https://docs.google.com/spreadsheets/d/${OTHER_ID}/edit`, 'таблица'],
    ['документ', `https://docs.google.com/document/d/${OTHER_ID}/edit`, 'документ'],
    ['форму', `https://docs.google.com/forms/d/${OTHER_ID}/edit`, 'форма'],
  ])(
    'Q22: ссылка на %s вне реестра — отказ, а не корень; Drive не спрашивают',
    async (_, target, kind) => {
      const drive = new FakeDriveClient();
      const { deps } = harness(drive);
      const result = await callMcp(gcApply, folderIn(target), deps);
      expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
      expect(result.error?.detail).toContain(`Цель ${OTHER_ID} — ${kind}, а не папка (по ссылке)`);
      expectFolderHint(result.error?.detail);
      expect(drive.asked).toEqual([]);
      expect(drive.created).toEqual([]);
    },
  );

  it.each([
    ['log', 'таблица'],
    ['mystery', 'файл неизвестного вида'],
  ])(
    'Q22: цель реестра «%s» — не папка: отказ, как прежде; Drive не спрашивают',
    async (alias, kind) => {
      const drive = new FakeDriveClient();
      const { deps } = harness(drive);
      const result = await callMcp(gcApply, folderIn(alias), deps);
      expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
      expect(result.error?.detail).toContain(
        `Цель «${alias}» — ${kind}, а не папка (так в реестре)`,
      );
      expectFolderHint(result.error?.detail);
      expect(drive.asked).toEqual([]);
      expect(drive.created).toEqual([]);
    },
  );

  it('Q22: ядро и без фасада не берёт таблицу за папку — отказ до Drive', async () => {
    let drives = 0;
    const drive = () => {
      drives += 1;
      return Promise.resolve(new FakeDriveClient());
    };
    const sheet = resolveTarget(`https://docs.google.com/spreadsheets/d/${OTHER_ID}/edit`);
    await expect(createParentOf(sheet, drive)).rejects.toMatchObject({
      payload: { code: 'bad_request', cause: 'create_needs_folder' },
    });
    expect(drives).toBe(0);
  });

  it('Q22: без родителя создание не собирается — parentId обязателен по типу (судит tsc)', () => {
    expectTypeOf<Parameters<DriveClient['create']>[2]>().toEqualTypeOf<string>();
    expectTypeOf<CreateInput['parentId']>().toEqualTypeOf<string>();
  });
});
