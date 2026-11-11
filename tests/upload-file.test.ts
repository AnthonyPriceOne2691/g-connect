/**
 * Загрузка файла с компьютера на Диск (D-27, Q45–Q48): новый файл в папку, свежая версия
 * одноимённого, замена по ID, сверка sha256 и откат.
 *
 * Весть сессии отчётов (профиль work): две сессии выкладывают на общий диск инструкции команды
 * (.md) и ролики (.mp4), и ссылки у команды меняться не должны. Решение владельца 2026-11-09 —
 * «свежая версия по имени»: одноимённый файл папки получает новую ревизию под разрешением проекта,
 * несколько одноимённых — вопрос человеку, замена по ID файлом другого имени — фразой и кодом.
 *
 * Запись — через настоящий протокол (урок L26), Drive — фейк с ревизиями (`fixtures/drive.ts`),
 * локальный файл проверяет двойник `vetLocalFile` из зависимостей: настоящую проверку судит свой
 * сьют. Журнал, как настоящий, отдаёт записи ПО ЦЕЛИ.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { gcError } from '../src/core/errors.js';
import type { DriveFileInfo } from '../src/core/google/drive.js';
import { newGrant } from '../src/core/grant/document.js';
import type { GrantState } from '../src/core/grant/grants.js';
import type { WriteRecord } from '../src/core/journal.js';
import type { Registry } from '../src/core/targets.js';
import type { LocalFile } from '../src/core/upload/local-file.js';
import type { UploadedFile } from '../src/core/upload/upload-plan.js';
import { gcApply, gcUndo, type ToolDeps } from '../src/mcp/tools.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp } from './fixtures/protocol.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

/** Папка команды на общем диске — голым ID, как её называют сессии. */
const FOLDER_ID = '1TEAMfolderAAAAAAAAAAAAAAAAAAAAAAA';
const SHEET_ID = '1BUDGETsheetBBBBBBBBBBBBBBBBBBBBBB';
const REGISTRY_FOLDER_ID = '1REPORTSfolderCCCCCCCCCCCCCCCCCCC';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** Инструкция — 20,5 КБ; ролик на Диске — 1,4 МБ, свежий — 1,5 МБ, черновик — 1,2 МБ. */
const GUIDE = Buffer.alloc(20_992, 'a');
const SALES_V1 = Buffer.alloc(1_468_006, 1);
const SALES_V2 = Buffer.alloc(1_572_864, 2);
const DRAFT = Buffer.alloc(1_258_291, 3);

/** Имена с «ё» и «й» — в двух формах Unicode: NFC (составной знак) и NFD (буква + знак). */
const REPORT_NFC = 'Отчёт.mp4';
const STEPS_NFD = 'Пошаговый.mp4'.normalize('NFD');

const PROJECT_FILES: Readonly<Record<string, Buffer>> = {
  'docs/guide.md': GUIDE,
  'video/sales.mp4': SALES_V2,
  'video/draft.mp4': DRAFT,
  [`video/${REPORT_NFC}`]: SALES_V2,
  [`video/${STEPS_NFD}`]: SALES_V2,
};

const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex');
const short = (content: Buffer): string => `${sha(content).slice(0, 8)}…${sha(content).slice(-8)}`;
const viewLink = (id: string): string => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;

const KNOWN = {
  [FOLDER_ID]: { name: 'Команда', type: 'folder', mimeType: FOLDER_MIME },
  [SHEET_ID]: { name: 'Бюджет', type: 'sheet', mimeType: SHEET_MIME },
} as const;

interface Outcome {
  readonly status: string;
  readonly planId: string | null;
  readonly assumptions: readonly string[];
  readonly notes: readonly string[];
  readonly questions: readonly {
    readonly field: string;
    readonly reason: string;
    readonly detail: string;
    readonly candidates: readonly string[];
  }[];
  readonly structural?: { readonly anchor?: string; readonly confirmPhrase?: string };
  readonly correlationId?: string;
  readonly file?: UploadedFile;
  readonly hint?: string;
}

interface UndoData {
  readonly status: string;
  readonly structureUndone?: string;
  readonly notRestored?: readonly string[];
  readonly hint?: string;
}

const projects: string[] = [];
afterAll(async () => {
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gc-upload-'));
  projects.push(dir);
  for (const [path, content] of Object.entries(PROJECT_FILES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

let shared: Promise<string> | undefined;

/** Проект — один на сьют; тест, который дописывает файл на диске, берёт свой (`ownProject`). */
function projectFor(own: boolean): Promise<string> {
  if (own) return makeProject();
  shared ??= makeProject();
  return shared;
}

/** Двойник `vetLocalFile`: путь — внутри проекта, sha256 и размер — по содержимому на диске. */
function vetDouble(vetted: string[]) {
  const mime: Readonly<Record<string, string>> = { '.md': 'text/markdown', '.mp4': 'video/mp4' };
  return async (projectDir: string, localPath: string): Promise<LocalFile> => {
    vetted.push(localPath);
    const path = isAbsolute(localPath) ? localPath : join(projectDir, localPath);
    if (!path.startsWith(`${projectDir}${sep}`)) {
      throw gcError('bad_request', {
        detail: `«${localPath}» — вне каталога проекта.`,
        cause: 'upload_outside_project',
      });
    }
    const content = await readFile(path);
    return {
      path,
      name: basename(path),
      size: content.length,
      sha256: sha(content),
      mimeType: mime[extname(path)] ?? 'application/octet-stream',
    };
  };
}

const granted = (project: string): GrantState => ({
  state: 'granted',
  grant: newGrant(project, 'work', new Date()),
});

const noGrant: GrantState = { state: 'none', reason: 'no_grant', detail: 'проверка: no_grant' };

interface Harness {
  readonly deps: ToolDeps;
  readonly drive: FakeDriveClient;
  readonly journalled: WriteRecord[];
  /** Какие пути проверил двойник: sha256 ролика не считается ради отказа. */
  readonly vetted: string[];
  readonly project: string;
  /** Сколько раз спросили ревизию таблицы: у загрузки её нет. */
  readonly revisions: () => number;
}

interface Setup {
  readonly grant?: 'granted' | GrantState;
  /** `false` — клиент не назвал каталог проекта. */
  readonly withProject?: boolean;
  /** `false` — проверку локального файла зависимости не принесли. */
  readonly withVet?: boolean;
  /** Свой каталог проекта: тест дописывает файл, и соседям он нужен прежним. */
  readonly ownProject?: boolean;
  readonly registry?: Registry;
}

async function harness(setup: Setup = {}): Promise<Harness> {
  const project = await projectFor(setup.ownProject === true);
  const drive = new FakeDriveClient(KNOWN);
  const journalled: WriteRecord[] = [];
  const vetted: string[] = [];
  const grant =
    setup.grant === undefined || setup.grant === 'granted' ? granted(project) : setup.grant;
  let revisions = 0;
  const deps: ToolDeps = {
    account: 'work',
    ...(setup.withProject === false ? {} : { project }),
    grant: () => Promise.resolve(grant),
    sheets: () => Promise.resolve(new FakeSheetsClient(snapshot())),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve(setup.registry ?? { targets: [] }),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: {
      recent: (targetId, limit) =>
        Promise.resolve(journalled.filter((r) => r.targetId === targetId).slice(-limit)),
    },
    revision: () => {
      revisions += 1;
      return Promise.reject(new TypeError('ревизии таблицы у файла нет'));
    },
    ...(setup.withVet === false ? {} : { vetLocalFile: vetDouble(vetted) }),
  };
  return { deps, drive, journalled, vetted, project, revisions: () => revisions };
}

const upload = (fields: Record<string, unknown>) => ({
  op: 'uploadFile',
  target: FOLDER_ID,
  localPath: 'video/sales.mp4',
  ...fields,
});

async function apply(h: Harness, fields: Record<string, unknown>): Promise<Outcome> {
  const result = await callMcp(gcApply, upload(fields), h.deps);
  expect(result.error).toBeUndefined();
  return result.data as Outcome;
}

/** Ролик на Диске в папке команды — прежняя версия, ревизия r1. */
const putSales = (h: Harness, content: Buffer = SALES_V1, name = 'sales.mp4'): string =>
  h.drive.put({ name, parentId: FOLDER_ID, mimeType: 'video/mp4', content });

describe('Q45 — новый файл в папку', () => {
  it('превью: файл, размер, sha256, вид и папка по ответу Drive; на Диск ничего не пишется', async () => {
    const h = await harness();
    const data = await apply(h, { localPath: 'docs/guide.md' });
    expect(data.status).toBe('preview');
    expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(data.structural?.anchor).toBe(
      `новый файл «guide.md» (20,5 КБ, sha256 ${short(GUIDE)}, text/markdown) в папке «Команда»`,
    );
    expect(data.assumptions).toEqual([
      `Цель ${FOLDER_ID} — папка «Команда»: вид и имя — по ответу Drive.`,
    ]);
    // Превью ничего не обещает: ссылка и id — только по факту записи.
    expect(data.file).toBeUndefined();
    expect(data.notes).toEqual([]);
    expect(h.drive.calls).toEqual(['findByName']);
    expect(h.journalled).toEqual([]);
  });

  it('под разрешением — с первой фразы: ответ с id, ссылкой, размером, modifiedTime и sha256', async () => {
    const h = await harness();
    const data = await apply(h, { localPath: 'docs/guide.md', dryRun: false });
    expect(data.status).toBe('ok');
    const id = data.file?.id ?? '';
    expect(data.file).toEqual({
      id,
      name: 'guide.md',
      link: viewLink(id),
      size: GUIDE.length,
      modifiedTime: h.drive.revisionsOf(id)[0]?.modifiedTime,
      sha256: sha(GUIDE),
      revision: 'r1',
    });
    // План, предусловие «одноимённого так и нет», загрузка — по порядку.
    expect(h.drive.calls).toEqual(['findByName', 'findByName', 'upload']);
    expect(data.notes).toEqual([
      `Загружено: «guide.md» (20,5 КБ), ссылка: ${viewLink(id)}. Id: ${id}.`,
      `Сверено: sha256 на Диске совпал с локальным (${short(GUIDE)}).`,
      'Откат отправит файл в корзину Drive; достать оттуда — руками, в интерфейсе Drive.',
    ]);
    expect(data.hint).toContain(`gc_undo по этой цели (запись ${data.correlationId ?? ''})`);
    expect(h.revisions()).toBe(0);
  });

  it('журнал: запись uploadFile под ID папки — профиль, проект, файл, режим, ревизия, размер, sha256', async () => {
    const h = await harness();
    const data = await apply(h, { localPath: 'docs/guide.md', dryRun: false });
    const id = data.file?.id ?? '';
    expect(h.journalled).toHaveLength(1);
    expect(h.journalled[0]).toMatchObject({
      op: 'uploadFile',
      targetId: FOLDER_ID,
      account: 'work',
      project: h.project,
      sheet: 'guide.md',
      correlationId: data.correlationId,
      planId: data.planId,
      revisionBefore: null,
      revisionAfter: 'r1',
      structure: {
        kind: 'uploadFile',
        fileId: id,
        upload: {
          mode: 'new',
          name: 'guide.md',
          size: GUIDE.length,
          sha256: sha(GUIDE),
          revision: 'r1',
        },
      },
    });
  });

  it('name — имя на Диске вместо имени локального файла', async () => {
    const h = await harness();
    const data = await apply(h, {
      localPath: 'docs/guide.md',
      name: 'Инструкция.md',
      dryRun: false,
    });
    expect(data.file?.name).toBe('Инструкция.md');
    expect(await h.drive.findByName(FOLDER_ID, 'Инструкция.md')).toHaveLength(1);
  });

  it.each([
    ['таблицу', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, 'таблица'],
    ['документ', `https://docs.google.com/document/d/${SHEET_ID}/edit`, 'документ'],
  ])('ссылка на %s — отказ «не папка» до Drive и до чтения файла', async (_, target, kind) => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ target, dryRun: false }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
    expect(result.error?.detail).toContain(`Цель ${SHEET_ID} — ${kind}, а не папка (по ссылке)`);
    expect(h.vetted).toEqual([]);
    expect(h.drive.asked).toEqual([]);
    expect(h.drive.calls).toEqual([]);
  });

  it('голый ID таблицы — отказ по ответу Drive: ничего не загружено', async () => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ target: SHEET_ID, dryRun: false }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
    expect(result.error?.detail).toContain(`Цель ${SHEET_ID} — таблица «Бюджет», а не папка`);
    expect(h.drive.calls).toEqual([]);
    expect(h.journalled).toEqual([]);
  });

  it('одноимённый появился между планом и записью — stale_value, копии нет', async () => {
    const h = await harness();
    const findByName = h.drive.findByName.bind(h.drive);
    let lookups = 0;
    h.drive.findByName = async (parentId, name) => {
      lookups += 1;
      if (lookups === 2) putSales(h, SALES_V1, name);
      return findByName(parentId, name);
    };
    const result = await callMcp(
      gcApply,
      upload({ localPath: 'docs/guide.md', dryRun: false }),
      h.deps,
    );
    expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_name_taken' });
    expect(result.error?.detail).toContain('появился файл «guide.md»');
    expect(h.drive.calls).not.toContain('upload');
    expect(h.journalled).toEqual([]);
  });

  it('папка реестра без конверта — по коду плана; с конвертом создания — с первой фразы', async () => {
    const h = await harness({
      grant: noGrant,
      registry: {
        targets: [
          // Папка реестра без конверта: запись в неё — по коду плана.
          { alias: 'reports', id: REGISTRY_FOLDER_ID, type: 'folder', allow: 'write' },
          {
            alias: 'reports-auto',
            id: '1AUTOfolderDDDDDDDDDDDDDDDDDDDDDDD',
            type: 'folder',
            allow: 'write',
            auto: { ops: ['createDoc'] },
          },
        ],
      },
    });
    const asked = await apply(h, { target: 'reports', dryRun: false });
    expect(asked.status).toBe('confirm_required');
    expect(h.drive.calls).not.toContain('upload');
    const confirmed = await apply(h, { target: 'reports', dryRun: false, confirm: asked.planId });
    expect(confirmed.status).toBe('ok');
    const auto = await apply(h, { target: 'reports-auto', dryRun: false });
    expect(auto.status).toBe('ok');
    expect(h.journalled.map((r) => r.targetId)).toEqual([
      REGISTRY_FOLDER_ID,
      '1AUTOfolderDDDDDDDDDDDDDDDDDDDDDDD',
    ]);
  });
});

describe('Q48 — свежая версия по имени', () => {
  it('превью: одноимённый в папке — свежая версия на место прежней, было → станет', async () => {
    const h = await harness();
    const id = putSales(h);
    const before = h.drive.revisionsOf(id)[0];
    const data = await apply(h, {});
    expect(data.status).toBe('preview');
    expect(data.structural?.anchor).toBe(
      `свежая версия «sales.mp4» на место прежней: было 1,4 МБ, изменён ${before?.modifiedTime ?? ''}; ` +
        `станет 1,5 МБ, sha256 ${short(SALES_V2)}, video/mp4; ID и ссылка те же; прежняя ревизия ` +
        'сохранится для отката',
    );
    // Не разрушающая: ни фразы, ни подсказки «назови предмет».
    expect(data.structural?.confirmPhrase).toBeUndefined();
    expect(data.hint).toContain('Это план');
    expect(h.drive.calls).toEqual(['findByName', 'fileInfo']);
  });

  it('под разрешением — без фразы и кода: ID и ссылка те же, новая ревизия, прежняя удержана', async () => {
    const h = await harness();
    const id = putSales(h);
    const before = h.drive.revisionsOf(id)[0];
    const data = await apply(h, { dryRun: false });
    expect(data.status).toBe('ok');
    expect(data.file).toEqual({
      id,
      name: 'sales.mp4',
      link: viewLink(id),
      size: SALES_V2.length,
      modifiedTime: h.drive.revisionsOf(id)[1]?.modifiedTime,
      sha256: sha(SALES_V2),
      revision: 'r2',
      previous: { size: SALES_V1.length, modifiedTime: before?.modifiedTime, revision: 'r1' },
    });
    // Прежняя ревизия удерживается ДО замены: иначе откату нечего было бы вернуть.
    expect(h.drive.calls).toEqual([
      'findByName',
      'fileInfo',
      'fileInfo',
      'keepRevision',
      'replace',
    ]);
    expect(h.drive.revisionsOf(id).map((r) => [r.id, r.keepForever])).toEqual([
      ['r1', true],
      ['r2', false],
    ]);
    expect(await h.drive.findByName(FOLDER_ID, 'sales.mp4')).toHaveLength(1);
    expect(data.notes[0]).toBe(
      `Заменено содержимое «sales.mp4»: было 1,4 МБ (изменён ${before?.modifiedTime ?? ''}), стало ` +
        `1,5 МБ (изменён ${data.file?.modifiedTime ?? ''}). ID и ссылка те же: ${viewLink(id)}.`,
    );
    expect(h.journalled[0]).toMatchObject({
      op: 'uploadFile',
      targetId: FOLDER_ID,
      revisionBefore: 'r1',
      revisionAfter: 'r2',
      structure: {
        fileId: id,
        upload: {
          mode: 'replace',
          revision: 'r2',
          previousRevision: 'r1',
          previousSize: SALES_V1.length,
          previousModifiedTime: before?.modifiedTime,
          sha256: sha(SALES_V2),
        },
      },
    });
  });

  it.each([
    ['на Диске разложенная форма (NFD), у локального — составная', REPORT_NFC, 'NFD'],
    ['у локального разложенная форма (NFD), на Диске — составная', STEPS_NFD, 'NFC'],
  ] as const)(
    'имя в разных формах Unicode — %s: свежая версия, а не копия',
    async (_, local, form) => {
      const h = await harness();
      const id = putSales(h, SALES_V1, local.normalize(form));
      const data = await apply(h, { localPath: `video/${local}`, dryRun: false });
      expect(data.status).toBe('ok');
      expect(data.file).toMatchObject({ id, revision: 'r2', previous: { revision: 'r1' } });
      expect(h.drive.calls).not.toContain('upload');
    },
  );

  it('несколько одноимённых — вопрос со списком (id, ссылка, размер, время), записи нет', async () => {
    const h = await harness();
    const first = putSales(h);
    const second = putSales(h, DRAFT);
    const data = await apply(h, { dryRun: false });
    expect(data.status).toBe('needs_clarification');
    expect(data.planId).toBeNull();
    const [question] = data.questions;
    expect(question).toMatchObject({ field: 'target', reason: 'ambiguous' });
    expect(question?.candidates).toEqual([
      `${first} — ${viewLink(first)}, 1,4 МБ, изменён ${h.drive.revisionsOf(first)[0]?.modifiedTime ?? ''}`,
      `${second} — ${viewLink(second)}, 1,2 МБ, изменён ${h.drive.revisionsOf(second)[0]?.modifiedTime ?? ''}`,
    ]);
    expect(question?.detail).toContain('replace: true и его ID в target');
    expect(data.hint).toContain('Спроси человека');
    expect(h.drive.calls).toEqual(['findByName']);
    expect(h.journalled).toEqual([]);
  });

  it.each([
    ['таблица Google', SHEET_MIME],
    ['папка', FOLDER_MIME],
  ])('одноимённая %s — отказ с объяснением, ничего не загружено', async (kind, mimeType) => {
    const h = await harness();
    h.drive.put({ name: 'sales.mp4', parentId: FOLDER_ID, mimeType });
    const result = await callMcp(gcApply, upload({ dryRun: false }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
    expect(result.error?.detail).toContain(`В папке уже есть «sales.mp4» — ${kind}`);
    expect(result.error?.detail).toContain('Назови файл иначе (name)');
    expect(h.drive.calls).toEqual(['findByName', 'fileInfo']);
  });

  it('то же содержимое — no_change: записи и строки журнала нет', async () => {
    const h = await harness();
    putSales(h, SALES_V2);
    const data = await apply(h, { dryRun: false });
    expect(data.status).toBe('no_change');
    expect(data.planId).toBeNull();
    expect(data.notes).toEqual([
      `Содержимое «sales.mp4» на Диске уже такое: sha256 ${short(SALES_V2)} совпал с локальным ` +
        '«sales.mp4». Записи не было и строки журнала тоже — это не выполненная правка.',
    ]);
    expect(h.drive.calls).toEqual(['findByName', 'fileInfo']);
    expect(h.journalled).toEqual([]);
  });

  it('голова сменилась между планом и записью — stale_value, ничего не заменено', async () => {
    const h = await harness();
    const id = putSales(h);
    const fileInfo = h.drive.fileInfo.bind(h.drive);
    let reads = 0;
    h.drive.fileInfo = async (fileId) => {
      reads += 1;
      // Чужая сессия положила свою версию, пока строился план.
      if (reads === 2) h.drive.foreignRevision(fileId, 'чужая версия');
      return fileInfo(fileId);
    };
    const result = await callMcp(gcApply, upload({ dryRun: false }), h.deps);
    expect(result.error).toMatchObject({
      code: 'stale_value',
      cause: 'file_changed_after_preview',
    });
    expect(result.error?.detail).toContain('ревизия r1 → r2');
    expect(h.drive.calls).not.toContain('keepRevision');
    expect(h.drive.calls).not.toContain('replace');
    expect(h.drive.revisionsOf(id)).toHaveLength(2);
    expect(h.journalled).toEqual([]);
  });
});

describe('Q46 — замена по ID', () => {
  const byId = (id: string) => `https://drive.google.com/file/d/${id}/view`;

  it('имя то же — под разрешением без кода: ID тот же, журнал под ID файла', async () => {
    const h = await harness();
    const id = putSales(h);
    const data = await apply(h, { target: byId(id), replace: true, dryRun: false });
    expect(data.status).toBe('ok');
    expect(data.file).toMatchObject({ id, revision: 'r2', previous: { revision: 'r1' } });
    expect(h.drive.calls).toEqual(['fileInfo', 'fileInfo', 'keepRevision', 'replace']);
    expect(h.journalled[0]).toMatchObject({ targetId: id, structure: { fileId: id } });
  });

  it('имя другое — разрушающая: без подтверждения confirm_required, фраза с кодом плана — ok', async () => {
    const h = await harness();
    const id = putSales(h);
    const fields = { target: byId(id), localPath: 'video/draft.mp4', replace: true };
    const preview = await apply(h, fields);
    expect(preview.structural).toMatchObject({
      confirmPhrase: 'заменяю файл sales.mp4',
      anchor:
        `замена содержимого «sales.mp4» файлом «draft.mp4»: было 1,4 МБ, изменён ` +
        `${h.drive.revisionsOf(id)[0]?.modifiedTime ?? ''}; станет 1,2 МБ, sha256 ${short(DRAFT)}, ` +
        'video/mp4; ID, ссылка и имя «sales.mp4» на Диске те же; прежняя ревизия сохранится для отката',
    });
    expect(preview.hint).toContain('НАЗВАНИЕМ');
    // Разрешение проекта есть, но разрушающую замену оно не подписывает.
    const silent = await apply(h, { ...fields, dryRun: false });
    expect(silent.status).toBe('confirm_required');
    const bare = await apply(h, {
      ...fields,
      dryRun: false,
      confirm: 'да',
      planId: preview.planId,
    });
    expect(bare.status).toBe('confirm_required');
    expect(h.drive.calls).not.toContain('replace');
    const named = await apply(h, {
      ...fields,
      dryRun: false,
      confirm: 'да, заменяю файл sales.mp4',
      planId: preview.planId,
    });
    expect(named.status).toBe('ok');
    expect(named.file).toMatchObject({ id, name: 'sales.mp4', sha256: sha(DRAFT) });
    expect(h.journalled).toHaveLength(1);
  });

  it('name с replace называет, чью версию несёт файл: имя то же — свежая версия без кода', async () => {
    const h = await harness();
    const id = putSales(h);
    const data = await apply(h, {
      target: byId(id),
      localPath: 'video/draft.mp4',
      name: 'sales.mp4',
      replace: true,
      dryRun: false,
    });
    expect(data.status).toBe('ok');
    expect(data.structural?.confirmPhrase).toBeUndefined();
    expect(data.file).toMatchObject({ id, name: 'sales.mp4', sha256: sha(DRAFT) });
  });

  it('чужая версия между превью и фразой — plan_mismatch с новым планом, записи нет', async () => {
    const h = await harness();
    const id = putSales(h);
    const fields = { target: byId(id), localPath: 'video/draft.mp4', replace: true };
    const preview = await apply(h, fields);
    h.drive.foreignRevision(id, 'чужая версия');
    const named = await apply(h, {
      ...fields,
      dryRun: false,
      confirm: 'заменяю файл sales.mp4',
      planId: preview.planId,
    });
    expect(named.status).toBe('plan_mismatch');
    expect(named.planId).not.toBe(preview.planId);
    expect(h.drive.calls).not.toContain('replace');
  });

  it.each([
    ['папка', `https://drive.google.com/drive/folders/${FOLDER_ID}`, 'у папки содержимого нет'],
    [
      'таблица',
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      'содержимое файла Google заменяется правками, а не загрузкой',
    ],
  ])('цель — %s по ссылке: отказ до Drive и до чтения файла', async (kind, target, why) => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ target, replace: true, dryRun: false }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
    expect(result.error?.detail).toContain(`— ${kind}: ${why}`);
    expect(h.vetted).toEqual([]);
    expect(h.drive.calls).toEqual([]);
  });

  it('голый ID таблицы — отказ по ответу Drive: таблицу правят операциями', async () => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ target: SHEET_ID, replace: true }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
    expect(result.error?.detail).toContain(
      'Цель «Бюджет» — таблица Google: содержимое файла Google заменяется правками, а не загрузкой.',
    );
    expect(h.drive.calls).toEqual(['fileInfo']);
  });
});

describe('Q45 — сверка sha256: Drive получил не то, что на диске', () => {
  it('новый файл — загруженное в корзину, ошибка вместо «готово», журнала нет', async () => {
    const h = await harness({ ownProject: true });
    const original = h.drive.upload.bind(h.drive);
    h.drive.upload = async (parentId, name, body) => {
      // Файл ещё дописывается: на Диск уходит не то, что проверила загрузка.
      await writeFile(body.path, 'дописалось');
      return original(parentId, name, body);
    };
    const result = await callMcp(
      gcApply,
      upload({ localPath: 'docs/guide.md', dryRun: false }),
      h.deps,
    );
    expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_checksum_mismatch' });
    expect(result.error?.detail).toContain(`у локального «guide.md» — ${short(GUIDE)}`);
    expect(result.error?.detail).toContain('Загруженное отправлено в корзину — на Диске его нет');
    expect(h.drive.trashed).toHaveLength(1);
    expect(await h.drive.findByName(FOLDER_ID, 'guide.md')).toEqual([]);
    expect(h.journalled).toEqual([]);
  });

  it('замена — прежнее содержимое возвращено ревизией, ошибка, журнала нет', async () => {
    const h = await harness({ ownProject: true });
    const id = putSales(h);
    const original = h.drive.replace.bind(h.drive);
    h.drive.replace = async (fileId, body) => {
      await writeFile(body.path, 'дописалось');
      return original(fileId, body);
    };
    const result = await callMcp(gcApply, upload({ dryRun: false }), h.deps);
    expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_checksum_mismatch' });
    expect(result.error?.detail).toContain(
      'Прежнее содержимое «sales.mp4» возвращено новой ревизией',
    );
    expect(h.drive.calls.slice(-3)).toEqual(['keepRevision', 'replace', 'restoreRevision']);
    expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
    expect(h.journalled).toEqual([]);
  });
});

describe('Q47 — откат', () => {
  it('новый файл — в корзину, пока он наш', async () => {
    const h = await harness();
    const written = await apply(h, { localPath: 'docs/guide.md', dryRun: false });
    const undone = await callMcp(gcUndo, { target: FOLDER_ID }, h.deps);
    expect(undone.error).toBeUndefined();
    const data = undone.data as UndoData;
    expect(data.status).toBe('ok');
    expect(data.structureUndone).toBe(
      'Файл «guide.md» отправлен в корзину Drive. Достать его оттуда можно только руками, в ' +
        'интерфейсе Drive — насовсем он не удалён.',
    );
    expect(data.notRestored).toBeUndefined();
    expect(h.drive.trashed).toEqual([written.file?.id]);
    expect(h.journalled.at(-1)).toMatchObject({ op: 'undo', undoOf: written.correlationId });
  });

  it('замена — прежняя ревизия новой ревизией: ID тот же, содержимое прежнее', async () => {
    const h = await harness();
    const id = putSales(h);
    await apply(h, { dryRun: false });
    const undone = await callMcp(gcUndo, { target: FOLDER_ID }, h.deps);
    const data = undone.data as UndoData;
    expect(data.status).toBe('ok');
    expect(data.structureUndone).toBe(
      'Содержимое «sales.mp4» возвращено к прежнему (ревизия r1) новой ревизией r3: ID и ссылка ' +
        'те же. Заменённое содержимое (ревизия r2) осталось в истории версий файла.',
    );
    expect(h.drive.revisionsOf(id).map((r) => r.sha256)).toEqual([
      sha(SALES_V1),
      sha(SALES_V2),
      sha(SALES_V1),
    ]);
    expect(h.drive.trashed).toEqual([]);
  });

  it('своя цепочка: новый, затем свежая версия — два отката подряд, и папка как была', async () => {
    const h = await harness();
    const first = await apply(h, { dryRun: false });
    const id = first.file?.id ?? '';
    // Черновик ложится свежей версией того же имени: `name` называет, чью версию он несёт.
    const second = await apply(h, {
      localPath: 'video/draft.mp4',
      name: 'sales.mp4',
      dryRun: false,
    });
    expect(second.file).toMatchObject({ id, revision: 'r2', sha256: sha(DRAFT) });
    const back = await callMcp(gcUndo, { target: FOLDER_ID }, h.deps);
    expect((back.data as UndoData).status).toBe('ok');
    // Голова теперь r3 — не ревизия первой записи, но содержимое ровно её: откат идёт.
    const gone = await callMcp(gcUndo, { target: FOLDER_ID }, h.deps);
    expect(gone.error).toBeUndefined();
    expect((gone.data as UndoData).structureUndone).toContain('«sales.mp4» отправлен в корзину');
    expect(h.drive.trashed).toEqual([id]);
  });

  it('замена по ID — откат по ссылке на файл', async () => {
    const h = await harness();
    const id = putSales(h);
    const link = `https://drive.google.com/file/d/${id}/view`;
    await apply(h, { target: link, replace: true, dryRun: false });
    const undone = await callMcp(gcUndo, { target: link }, h.deps);
    expect((undone.data as UndoData).status).toBe('ok');
    expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
  });

  it.each([
    ['новый', 'docs/guide.md', 'guide.md', 'отправил бы в корзину файл вместе с ней'],
    ['замена', 'video/sales.mp4', 'sales.mp4', 'вернул бы прежнее содержимое поверх неё'],
  ])(
    '%s: после записи файл меняли — откат отказывает и ничего не трогает',
    async (_, localPath, name, lose) => {
      const h = await harness();
      if (name === 'sales.mp4') putSales(h);
      const written = await apply(h, { localPath, dryRun: false });
      const id = written.file?.id ?? '';
      h.drive.foreignRevision(id, 'правка человека');
      const before = h.drive.revisionsOf(id).length;
      const undone = await callMcp(gcUndo, { target: FOLDER_ID }, h.deps);
      expect(undone.error).toMatchObject({
        code: 'revision_conflict',
        cause: 'file_changed_after_write',
      });
      expect(undone.error?.detail).toContain(`Файл «${name}» после нашей записи меняли`);
      expect(undone.error?.detail).toContain(lose);
      expect(undone.error?.detail).toContain('Осознанно — откат с force');
      expect(h.drive.revisionsOf(id)).toHaveLength(before);
      expect(h.drive.trashed).toEqual([]);
    },
  );

  it('с force — откат идёт и называет, что унёс вместе с нашим', async () => {
    const h = await harness();
    putSales(h);
    const written = await apply(h, { dryRun: false });
    const id = written.file?.id ?? '';
    h.drive.foreignRevision(id, 'правка человека');
    const undone = await callMcp(gcUndo, { target: FOLDER_ID, force: true }, h.deps);
    const data = undone.data as UndoData;
    expect(data.status).toBe('ok');
    expect(data.notRestored).toEqual([
      'правки после нашей замены (ревизия r3) — содержимое стало прежним поверх них; они остались ' +
        'в истории версий файла',
    ]);
    expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
  });
});

/**
 * Ответ Drive без sha256. Есть ли `sha256Checksum` прямо в ответе загрузки, видно только живьём
 * (T32), — без него сверка идёт по размеру, а откат узнаёт свой файл по ревизии.
 */
function withoutChecksum(info: DriveFileInfo): DriveFileInfo {
  const copy: { -readonly [K in keyof DriveFileInfo]: DriveFileInfo[K] } = { ...info };
  delete copy.sha256;
  return copy;
}

describe('Q45, Q47 — Drive не назвал sha256: сверка по размеру, свой файл — по ревизии', () => {
  it('новый файл — сверено по размеру, запись идёт', async () => {
    const h = await harness();
    const original = h.drive.upload.bind(h.drive);
    h.drive.upload = async (parentId, name, body) =>
      withoutChecksum(await original(parentId, name, body));
    const data = await apply(h, { localPath: 'docs/guide.md', dryRun: false });
    expect(data.status).toBe('ok');
    expect(data.notes).toContain(
      'Drive не назвал sha256 загруженного — сверено по размеру (20,5 КБ).',
    );
  });

  it('размер разошёлся — загруженное в корзину, ошибка называет оба размера', async () => {
    const h = await harness({ ownProject: true });
    const original = h.drive.upload.bind(h.drive);
    h.drive.upload = async (parentId, name, body) => {
      await writeFile(body.path, 'дописалось');
      return withoutChecksum(await original(parentId, name, body));
    };
    const result = await callMcp(
      gcApply,
      upload({ localPath: 'docs/guide.md', dryRun: false }),
      h.deps,
    );
    expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_checksum_mismatch' });
    expect(result.error?.detail).toContain('у локального «guide.md» — 20,5 КБ');
    expect(h.drive.trashed).toHaveLength(1);
    expect(h.journalled).toEqual([]);
  });

  it('ни sha256, ни размера — запись идёт, а ответ велит проверить файл по ссылке', async () => {
    const h = await harness();
    const original = h.drive.upload.bind(h.drive);
    h.drive.upload = async (parentId, name, body) => {
      const { id, mimeType } = await original(parentId, name, body);
      return { id, name, mimeType };
    };
    const data = await apply(h, { localPath: 'docs/guide.md', dryRun: false });
    expect(data.status).toBe('ok');
    expect(data.notes).toContain(
      'Drive не назвал ни sha256, ни размер загруженного — сверить содержимое нечем: открой файл ' +
        'по ссылке и проверь.',
    );
  });

  it('расхождение, а корзина не удалась — write_outcome_unknown: что удалить руками', async () => {
    const h = await harness({ ownProject: true });
    const original = h.drive.upload.bind(h.drive);
    h.drive.upload = async (parentId, name, body) => {
      await writeFile(body.path, 'дописалось');
      return original(parentId, name, body);
    };
    h.drive.trash = () => Promise.reject(new Error('корзина недоступна'));
    const result = await callMcp(
      gcApply,
      upload({ localPath: 'docs/guide.md', dryRun: false }),
      h.deps,
    );
    expect(result.error).toMatchObject({
      code: 'write_outcome_unknown',
      cause: 'upload_checksum_mismatch',
    });
    expect(result.error?.detail).toContain(
      'Загруженное в корзину не ушло: https://drive.google.com/file/d/',
    );
    expect(result.error?.detail).toContain('удали его руками');
    expect(h.journalled).toEqual([]);
  });

  it('откат замены без sha256: наш файл — по ревизии, чужая ревизия — отказ', async () => {
    const h = await harness();
    const id = putSales(h);
    await apply(h, { dryRun: false });
    const info = h.drive.fileInfo.bind(h.drive);
    h.drive.fileInfo = async (fileId) => withoutChecksum(await info(fileId));
    const undone = await callMcp(gcUndo, { target: FOLDER_ID }, h.deps);
    expect((undone.data as UndoData).status).toBe('ok');
    expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));

    const other = await harness();
    const otherId = putSales(other);
    await apply(other, { dryRun: false });
    other.drive.foreignRevision(otherId, 'правка человека');
    const otherInfo = other.drive.fileInfo.bind(other.drive);
    other.drive.fileInfo = async (fileId) => withoutChecksum(await otherInfo(fileId));
    const before = other.drive.revisionsOf(otherId).length;
    const refused = await callMcp(gcUndo, { target: FOLDER_ID }, other.deps);
    expect(refused.error).toMatchObject({
      code: 'revision_conflict',
      cause: 'file_changed_after_write',
    });
    expect(other.drive.revisionsOf(otherId)).toHaveLength(before);
  });

  it('файл Google другого вида с тем же именем и папка по голому ID — отказ с видом', async () => {
    const h = await harness();
    h.drive.put({
      name: 'sales.mp4',
      parentId: FOLDER_ID,
      mimeType: 'application/vnd.google-apps.presentation',
    });
    const slides = await callMcp(gcApply, upload({ dryRun: false }), h.deps);
    expect(slides.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
    expect(slides.error?.detail).toContain(
      '«sales.mp4» — файл Google (application/vnd.google-apps.presentation), а не загруженный файл',
    );
    const folderId = h.drive.put({ name: 'Архив', parentId: FOLDER_ID, mimeType: FOLDER_MIME });
    const folder = await callMcp(
      gcApply,
      upload({ target: folderId, replace: true, dryRun: false }),
      h.deps,
    );
    expect(folder.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
    expect(folder.error?.detail).toContain(
      'Цель «Архив» — папка: у папки содержимого нет. В папку загружают без replace',
    );
    expect(h.drive.calls).not.toContain('upload');
  });
});

describe('порядок отказов: проект, право, файл — до Google', () => {
  it('нет каталога проекта — отказ до права, файла и Drive', async () => {
    const h = await harness({ withProject: false });
    const result = await callMcp(gcApply, upload({ dryRun: false }), h.deps);
    expect(result.error).toMatchObject({
      code: 'policy_denied',
      cause: 'upload.project-files-only',
    });
    expect(result.error?.detail).toContain('CLAUDE_PROJECT_DIR');
    expect(h.vetted).toEqual([]);
    expect(h.drive.calls).toEqual([]);
    expect(h.drive.asked).toEqual([]);
  });

  it('без разрешения — needs_grant до чтения файла и до Drive', async () => {
    const h = await harness({ grant: noGrant });
    const result = await callMcp(gcApply, upload({ dryRun: false }), h.deps);
    expect(result.error?.code).toBe('needs_grant');
    expect(h.vetted).toEqual([]);
    expect(h.drive.asked).toEqual([]);
    expect(h.drive.calls).toEqual([]);
  });

  it('файл вне проекта — отказ проверки как есть, Drive не спрашивают', async () => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ localPath: '/etc/hosts' }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_outside_project' });
    expect(h.drive.calls).toEqual([]);
  });

  it('без проверки файла в зависимостях — отказ, а не чтение файла в обход', async () => {
    const h = await harness({ withVet: false });
    const result = await callMcp(gcApply, upload({}), h.deps);
    expect(result.error?.code).toBe('internal');
    expect(result.error?.detail).toContain('Проверка локального файла не подключена');
    expect(h.drive.calls).toEqual([]);
  });
});

describe('протокол gc_apply: поля загрузки', () => {
  it('схема принимает localPath, name и replace флагом', async () => {
    const h = await harness();
    const data = await apply(h, {
      localPath: 'docs/guide.md',
      name: 'Инструкция.md',
      replace: false,
    });
    expect(data.status).toBe('preview');
    expect(data.structural?.anchor).toContain('новый файл «Инструкция.md»');
  });

  it('незнакомое поле — отказ с названием и подсказкой; ничего не сделано', async () => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ locallPath: 'docs/guide.md' }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'unknown_field' });
    expect(result.error?.detail).toContain('«locallPath» (возможно, «localPath»)');
    expect(h.vetted).toEqual([]);
    expect(h.drive.calls).toEqual([]);
  });

  it('replace строкой у загрузки — отказ формы ядра, а не замена', async () => {
    const h = await harness();
    const result = await callMcp(gcApply, upload({ replace: 'да' }), h.deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(h.drive.calls).toEqual([]);
  });
});
