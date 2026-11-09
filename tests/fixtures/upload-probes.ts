/**
 * Пробы правил загрузки файлов с компьютера (D-27) — отдельным модулем, как `sheet-probes.ts`:
 * реестр проб в policy.test.ts у предела длины. Структурный оракул «у КАЖДОГО правила есть
 * проба — и наоборот» судит реестр целиком.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect } from 'vitest';

import { newGrant } from '../../src/core/grant/document.js';
import type { GrantState } from '../../src/core/grant/grants.js';
import { limitOf } from '../../src/core/policy.js';
import { locateLocalFile, vetLocalFile } from '../../src/core/upload/local-file.js';
import { gcApply, type ToolDeps } from '../../src/mcp/tools.js';
import { FakeDriveClient } from './drive.js';
import { callMcp } from './protocol.js';
import { FakeSheetsClient, snapshot } from './sheet.js';

/** Папка команды на Диске пробы — голым ID, как её называют сессии. */
const FOLDER = '1PROBEfolderAAAAAAAAAAAAAAAAAAAAA';
const FOLDER_KNOWN = {
  [FOLDER]: { name: 'Команда', type: 'folder', mimeType: 'application/vnd.google-apps.folder' },
} as const;

/** Проект пробы во временном каталоге — с файлами; `done` убирает его. */
async function probeProject(
  files: Readonly<Record<string, string>>,
): Promise<{ project: string; done: () => Promise<void> }> {
  const project = await mkdtemp(join(tmpdir(), 'gconnect-probe-upload-op-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  return { project, done: () => rm(project, { recursive: true, force: true }) };
}

/**
 * `gc_apply uploadFile` через протокол — как её зовёт сессия: разрешение проекта (без проекта —
 * без него), настоящая проверка файла, Диск — фейк с ревизиями.
 */
function probeUpload(
  project: string | undefined,
  drive: FakeDriveClient,
  fields: Readonly<Record<string, unknown>>,
) {
  const grant: GrantState =
    project === undefined
      ? { state: 'none', reason: 'no_grant', detail: 'проба: проекта нет' }
      : { state: 'granted', grant: newGrant(project, 'work', new Date()) };
  const deps: ToolDeps = {
    account: 'work',
    ...(project === undefined ? {} : { project }),
    grant: () => Promise.resolve(grant),
    sheets: () => Promise.resolve(new FakeSheetsClient(snapshot())),
    docs: () => Promise.reject(new TypeError('документов в пробе нет')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve({ targets: [] }),
    journal: () => Promise.resolve(),
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => Promise.reject(new TypeError('ревизии таблицы у файла нет')),
    vetLocalFile,
  };
  return callMcp(gcApply, { op: 'uploadFile', target: FOLDER, ...fields }, deps);
}

/** Разреженный файл: `truncate` ставит размер без записи байтов — 100 МиБ на диске не стоят ничего. */
export async function sparseFile(path: string, size: number): Promise<void> {
  await writeFile(path, '');
  await truncate(path, size);
}

export const uploadProbes: Record<string, () => Promise<void>> = {
  // Решение владельца 2026-11-09 «Из папки проекта сессии»: снаружи, ссылкой наружу, скрытое и
  // секрет — отказ с причиной, а файл проекта проходит. На настоящих файлах и ссылках.
  'upload.project-files-only': async () => {
    const base = await mkdtemp(join(tmpdir(), 'gconnect-probe-project-'));
    const project = join(base, 'project');
    try {
      await mkdir(join(project, '.ssh'), { recursive: true });
      await writeFile(join(base, 'outside.md'), 'снаружи');
      await writeFile(join(project, 'guide.md'), 'гайд');
      await writeFile(join(project, 'prod.env'), 'KEY=1');
      await writeFile(join(project, '.ssh', 'config'), 'Host x');
      await symlink(join(base, 'outside.md'), join(project, 'out.md'));
      const refused = [
        ['../outside.md', 'upload_outside_project'],
        ['out.md', 'upload_outside_project'],
        ['.ssh/config', 'upload_hidden_path'],
        ['prod.env', 'upload_secret_like'],
      ] as const;
      for (const [path, cause] of refused) {
        await expect(vetLocalFile(project, path), path).rejects.toMatchObject({
          payload: { code: 'bad_request', cause },
        });
      }
      await expect(vetLocalFile(project, 'guide.md')).resolves.toMatchObject({ name: 'guide.md' });
      // Клиент не назвал каталог проекта — отказ правилом раньше права, файла и Диска.
      const drive = new FakeDriveClient(FOLDER_KNOWN);
      const orphan = await probeUpload(undefined, drive, { localPath: 'guide.md', dryRun: false });
      expect(orphan.error).toMatchObject({
        code: 'policy_denied',
        cause: 'upload.project-files-only',
      });
      expect(drive.calls).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
  // Решение владельца 2026-11-09 «не плодим копии»: свежая версия — ревизия того же файла.
  'upload.same-name-new-version': async () => {
    const { project, done } = await probeProject({ 'video/sales.mp4': 'версия 2' });
    try {
      const drive = new FakeDriveClient(FOLDER_KNOWN);
      const put = (content: string): string =>
        drive.put({ name: 'sales.mp4', parentId: FOLDER, mimeType: 'video/mp4', content });
      const id = put('версия 1');
      const fresh = await probeUpload(project, drive, {
        localPath: 'video/sales.mp4',
        dryRun: false,
      });
      expect(fresh.data).toMatchObject({ status: 'ok', file: { id, name: 'sales.mp4' } });
      expect(drive.revisionsOf(id)).toHaveLength(2);
      put('копия');
      const twins = await probeUpload(project, drive, {
        localPath: 'video/sales.mp4',
        dryRun: false,
      });
      expect(twins.data).toMatchObject({ status: 'needs_clarification' });
      expect(drive.revisionsOf(id)).toHaveLength(2);
    } finally {
      await done();
    }
  },
  // Файл другого имени на место файла — разрушающая правка: фраза человека с кодом плана (D-20).
  'upload.replace-other-name-named': async () => {
    const { project, done } = await probeProject({ 'video/sales.mp4': 'новое' });
    try {
      const drive = new FakeDriveClient(FOLDER_KNOWN);
      const id = drive.put({
        name: 'old.mp4',
        parentId: FOLDER,
        mimeType: 'video/mp4',
        content: 'старое',
      });
      const result = await probeUpload(project, drive, {
        target: id,
        replace: true,
        localPath: 'video/sales.mp4',
        dryRun: false,
      });
      expect(result.data).toMatchObject({
        status: 'confirm_required',
        structural: { confirmPhrase: 'заменяю файл old.mp4' },
      });
      expect(drive.revisionsOf(id)).toHaveLength(1);
    } finally {
      await done();
    }
  },
  // Диск получил не то, что лежит на диске (файл дописали после проверки) — не «готово».
  'upload.verified-by-checksum': async () => {
    const { project, done } = await probeProject({ 'docs/guide.md': 'гайд' });
    try {
      const drive = new FakeDriveClient(FOLDER_KNOWN);
      const upload = drive.upload.bind(drive);
      drive.upload = async (parentId, name, body) => {
        await writeFile(body.path, 'дописалось после проверки');
        return upload(parentId, name, body);
      };
      const result = await probeUpload(project, drive, {
        localPath: 'docs/guide.md',
        dryRun: false,
      });
      expect(result.error).toMatchObject({
        code: 'stale_value',
        cause: 'upload_checksum_mismatch',
      });
      expect(await drive.findByName(FOLDER, 'guide.md')).toEqual([]);
    } finally {
      await done();
    }
  },
  // Предел судится на настоящем файле, а не на числе в коде: на байт больше — отказ правилом с
  // размером. Файл без права чтения доказывает, что содержимое до отказа не читалось: иначе
  // ответом был бы EACCES (под root права не держат, и проба судит только размер).
  'upload.max-bytes': async () => {
    const max = limitOf('upload.max-bytes', -1);
    const project = await mkdtemp(join(tmpdir(), 'gconnect-probe-upload-'));
    try {
      await sparseFile(join(project, 'big.bin'), max + 1);
      await chmod(join(project, 'big.bin'), 0o000);
      await sparseFile(join(project, 'exact.bin'), max);
      await expect(vetLocalFile(project, 'big.bin')).rejects.toMatchObject({
        payload: {
          code: 'policy_denied',
          cause: 'upload.max-bytes',
          detail: expect.stringContaining(`${max + 1} байт`) as unknown,
        },
      });
      await expect(locateLocalFile(project, 'exact.bin')).resolves.toMatchObject({ size: max });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
};
