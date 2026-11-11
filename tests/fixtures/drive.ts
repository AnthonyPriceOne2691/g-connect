import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { gcError } from '../../src/core/errors.js';
import type {
  CreateKind,
  DriveClient,
  DriveFile,
  DriveFileInfo,
  UploadBody,
} from '../../src/core/google/drive.js';

/** Ревизия содержимого — как у Drive у загруженных файлов (у файлов Google их нет). */
export interface FakeRevision {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly modifiedTime: string;
  /** `keepForever`: Drive не удалит её из истории — откат замены вернёт её содержимое. */
  keepForever: boolean;
}

/** Файл в папке: загруженный — с ревизиями, файл Google или папка — без них. */
interface StoredFile {
  readonly id: string;
  readonly name: string;
  mimeType: string;
  readonly parentId: string;
  readonly revisions: FakeRevision[];
  trashed: boolean;
}

/** Что положить в папку до теста: с `content` — загруженный файл (ревизия r1), без — файл Google. */
export interface PutFile {
  readonly id?: string;
  readonly name: string;
  readonly parentId: string;
  readonly mimeType?: string;
  readonly content?: string | Buffer;
}

const GOOGLE_TYPES: Readonly<Record<string, DriveFile['type']>> = {
  'application/vnd.google-apps.folder': 'folder',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.document': 'doc',
};

/**
 * Фейк Drive: помнит созданное и отправленное в корзину — этим и проверяем откат.
 *
 * Родитель созданного записывается ВСЕГДА (D-26, Q22): прежде фейк опускал его, когда шов
 * получал `undefined`, и «создано без папки» — то есть в корне — выглядело в тестах так же,
 * как отсутствие поля. Вид по ID (`fileKind`) знает только переданные файлы; остальное —
 * `not_found`, как отвечает Drive на чужой или несуществующий ID.
 *
 * Загрузка (Q45–Q48) — в памяти и с ревизиями, как у Drive: `upload` — файл с ревизией r1,
 * `replace` — следующая ревизия того же ID, `keepRevision` — пометка `keepForever`,
 * `restoreRevision` — новая ревизия с содержимым прежней. sha256 и размер считаются по файлу на
 * диске в момент вызова — так их считает и Drive: дописанный после проверки файл расходится.
 */
export class FakeDriveClient implements DriveClient {
  readonly created: { id: string; name: string; kind: string; parentId: string }[] = [];
  readonly trashed: string[] = [];
  /** О каких ID спросили вид: ядро обязано спрашивать только о голом ID (Q20, Q22). */
  readonly asked: string[] = [];
  /** Вызовы загрузки по порядку: «удержать прежнюю ревизию ДО замены» судится по ним. */
  readonly calls: string[] = [];
  private readonly stored = new Map<string, StoredFile>();
  private serial = 0;
  private clock = 0;

  constructor(private readonly files: Readonly<Record<string, Omit<DriveFile, 'id'>>> = {}) {}

  search(): Promise<{ files: never[]; incompleteBecause: never[] }> {
    return Promise.resolve({ files: [], incompleteBecause: [] });
  }

  fileKind(id: string): Promise<DriveFile> {
    this.asked.push(id);
    const file = this.files[id];
    if (file !== undefined) return Promise.resolve({ id, ...file });
    const stored = this.stored.get(id);
    if (stored === undefined) return Promise.reject(notFound(id));
    const type = GOOGLE_TYPES[stored.mimeType] ?? 'other';
    return Promise.resolve({ id, name: stored.name, type, mimeType: stored.mimeType });
  }

  create(
    kind: CreateKind,
    name: string,
    parentId: string,
  ): Promise<{ id: string; name: string; url: string }> {
    const id = `FILE${this.created.length + 1}`;
    this.created.push({ id, name, kind, parentId });
    return Promise.resolve({ id, name, url: `https://drive.google.com/open?id=${id}` });
  }

  trash(fileId: string): Promise<void> {
    this.calls.push('trash');
    this.trashed.push(fileId);
    const stored = this.stored.get(fileId);
    if (stored !== undefined) stored.trashed = true;
    return Promise.resolve();
  }

  /** Положить файл в папку до теста; ответ — его ID. */
  put(file: PutFile): string {
    const id = file.id ?? this.newId();
    this.stored.set(id, {
      id,
      name: file.name,
      parentId: file.parentId,
      mimeType: file.mimeType ?? 'application/octet-stream',
      revisions: file.content === undefined ? [] : [this.revision(1, Buffer.from(file.content))],
      trashed: false,
    });
    return id;
  }

  /** Чужая правка содержимого — ревизия мимо ядра: так файл меняет человек или соседняя сессия. */
  foreignRevision(fileId: string, content: string): void {
    const file = this.blob(fileId);
    file.revisions.push(this.revision(file.revisions.length + 1, Buffer.from(content)));
  }

  /** Ревизии файла: удержана ли прежняя, что сейчас в голове. */
  revisionsOf(fileId: string): readonly FakeRevision[] {
    return this.blob(fileId).revisions;
  }

  async fileInfo(fileId: string): Promise<DriveFileInfo> {
    this.calls.push('fileInfo');
    const stored = this.stored.get(fileId);
    if (stored !== undefined) return this.infoOf(stored);
    const known = this.files[fileId];
    if (known === undefined) throw notFound(fileId);
    return { id: fileId, name: known.name, mimeType: known.mimeType };
  }

  async upload(parentId: string, name: string, body: UploadBody): Promise<DriveFileInfo> {
    this.calls.push('upload');
    const content = await readFile(body.path);
    const id = this.newId();
    const file: StoredFile = {
      id,
      name,
      parentId,
      mimeType: body.mimeType,
      revisions: [this.revision(1, content)],
      trashed: false,
    };
    this.stored.set(id, file);
    return this.infoOf(file);
  }

  async replace(fileId: string, body: UploadBody): Promise<DriveFileInfo> {
    this.calls.push('replace');
    const file = this.blob(fileId);
    const content = await readFile(body.path);
    file.mimeType = body.mimeType;
    file.revisions.push(this.revision(file.revisions.length + 1, content));
    return this.infoOf(file);
  }

  async keepRevision(fileId: string, revisionId: string): Promise<void> {
    this.calls.push('keepRevision');
    this.revisionOf(fileId, revisionId).keepForever = true;
  }

  async restoreRevision(fileId: string, revisionId: string): Promise<DriveFileInfo> {
    this.calls.push('restoreRevision');
    const file = this.blob(fileId);
    const old = this.revisionOf(fileId, revisionId);
    file.revisions.push({
      id: `r${file.revisions.length + 1}`,
      sha256: old.sha256,
      size: old.size,
      modifiedTime: this.tick(),
      keepForever: false,
    });
    return this.infoOf(file);
  }

  async findByName(parentId: string, name: string): Promise<DriveFileInfo[]> {
    this.calls.push('findByName');
    return [...this.stored.values()]
      .filter((file) => file.parentId === parentId && file.name === name && !file.trashed)
      .map((file) => this.infoOf(file));
  }

  private infoOf(file: StoredFile): DriveFileInfo {
    const head = file.revisions.at(-1);
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [file.parentId],
      webViewLink: `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`,
      ...(head === undefined
        ? {}
        : {
            size: head.size,
            sha256: head.sha256,
            modifiedTime: head.modifiedTime,
            headRevisionId: head.id,
          }),
    };
  }

  private blob(fileId: string): StoredFile {
    const file = this.stored.get(fileId);
    if (file === undefined) throw notFound(fileId);
    return file;
  }

  private revisionOf(fileId: string, revisionId: string): FakeRevision {
    const revision = this.blob(fileId).revisions.find((r) => r.id === revisionId);
    if (revision === undefined) throw notFound(`${fileId}@${revisionId}`);
    return revision;
  }

  private revision(number: number, content: Buffer): FakeRevision {
    return {
      id: `r${number}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      modifiedTime: this.tick(),
      keepForever: false,
    };
  }

  /** ID загруженного — длинный, как у Drive: голый ID короче 20 знаков ядро не узнаёт. */
  private newId(): string {
    this.serial += 1;
    return `1UP${String(this.serial).padStart(3, '0')}BLOBaaaaaaaaaaaaaaaa`;
  }

  /** Часы фейка: каждая ревизия — на секунду позже, чтобы `modifiedTime` различался. */
  private tick(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 10, 9, 9, 0, this.clock)).toISOString();
  }
}

function notFound(id: string) {
  return gcError('not_found', { cause: `HTTP 404: File not found: ${id}.` });
}
