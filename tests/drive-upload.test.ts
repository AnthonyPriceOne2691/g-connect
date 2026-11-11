/**
 * Шов Drive для загрузки (D-27, Q45–Q48): судится на форме запросов Google, без сети (урок L28).
 *
 * Файл до порога — один multipart-запрос googleapis (`files.create` / `files.update` с `media`):
 * его судят параметры внедрённого API и байты, которые API прочёл из потока. Больше порога —
 * resumable-протокол поверх внедрённого транспорта. Фейк сессии ведёт себя по документации Drive
 * («Perform a resumable upload»): принимает кусок только с принятого байта и кратный 256 КиБ
 * (кроме последнего), на непоследний отвечает 308 с `Range`, вправе принять меньше отправленного,
 * на вопрос «сколько принято» отвечает тем же 308 — или файлом, если принято всё.
 *
 * Транспорт по умолчанию судится на настоящих google-auth-library и gaxios: подменён только
 * `fetch` под ними — заголовок доступа, тело куска и 308 проходят тот же путь, что живьём.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, type ReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { drive_v3 } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  authorizedTransport,
  type UploadRequest,
  type UploadResponse,
  type UploadTransport,
} from '../src/core/google/drive-upload.js';
import {
  GoogleDriveClient,
  listParams,
  type GoogleDriveClientOptions,
  type UploadBody,
} from '../src/core/google/drive.js';
import { authorizedClient } from '../src/core/google/support.js';

const KIB_256 = 256 * 1024;
const FIELDS =
  'id,name,mimeType,size,sha256Checksum,modifiedTime,headRevisionId,webViewLink,parents';
const FOLDER = 'FOLDER1';
const FILE = 'FILE1';
const SESSION =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION1';

let dir: string;
/** Свой каталог для скачанных ревизий: после отката он обязан быть пуст. */
let scratch: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gconnect-drive-upload-'));
  scratch = join(dir, 'scratch');
  await mkdir(scratch);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Файл на диске, как после `vetLocalFile`: путь, размер, тип. */
async function localFile(size: number, name = 'ролик.mp4', mimeType = 'video/mp4') {
  const bytes = randomBytes(size);
  const path = join(dir, name);
  await writeFile(path, bytes);
  const body: UploadBody = { path, size, mimeType };
  return { body, bytes };
}

/** Большой файл без записи мегабайтов: разреженный, из нулей. */
async function sparseFile(name: string, size: number): Promise<UploadBody> {
  const path = join(dir, name);
  await writeFile(path, '');
  await truncate(path, size);
  return { path, size, mimeType: 'application/octet-stream' };
}

/** Файл в ответе Google по принятому содержимому: размер — строкой (int64 в JSON), sha256 — его. */
function googleFile(
  id: string,
  bytes: Buffer,
  meta: drive_v3.Schema$File = {},
): drive_v3.Schema$File {
  return {
    id,
    name: 'ролик.mp4',
    mimeType: 'video/mp4',
    parents: [FOLDER],
    ...meta,
    size: String(bytes.length),
    sha256Checksum: sha256(bytes),
    modifiedTime: '2026-11-09T12:00:00.000Z',
    headRevisionId: `REV-${bytes.length}`,
    webViewLink: `https://drive.google.com/file/d/${id}/view?usp=drivesdk`,
  };
}

/** Ровно поля маски, как у Drive: без поля в `fields` его нет и в ответе. */
function only(file: drive_v3.Schema$File, fields: string | null | undefined): drive_v3.Schema$File {
  const wanted = new Set((fields ?? 'id,name,mimeType').split(','));
  return Object.fromEntries(Object.entries(file).filter(([key]) => wanted.has(key)));
}

/** Ошибка, как её отдаёт googleapis: статус и текст Google. */
const googleError = (status: number, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

/** Обрыв сети, как его отдаёт node-fetch через gaxios: текст с кодом причины. */
const networkDrop = () =>
  Object.assign(
    new Error('request to https://www.googleapis.com/upload failed, reason: read ECONNRESET'),
    {
      code: 'ECONNRESET',
    },
  );

interface ApiCall {
  readonly method: string;
  readonly params: object;
  readonly options?: object;
}

interface DriveSetup {
  readonly files?: Readonly<Record<string, drive_v3.Schema$File>>;
  readonly list?: drive_v3.Schema$FileList;
  readonly revisions?: Readonly<Record<string, { mimeType: string; bytes: Buffer }>>;
  /** Отказ Google по методу (`files.create` → HTTP-статус). */
  readonly fail?: Readonly<Record<string, number>>;
  /** Скачивание ревизии рвётся на середине. */
  readonly brokenDownload?: boolean;
}

/** Drive, отвечающий как Google; вызовы — по порядку, тело media читается из потока, как HTTP. */
function fakeDrive(setup: DriveSetup = {}) {
  const calls: ApiCall[] = [];
  /** Чем было тело media: путь потока и прочитанные байты (у отказа — без чтения). */
  const media: { path: string; bytes?: Buffer }[] = [];
  const call = (method: string, params: object, options?: object): void => {
    calls.push(options === undefined ? { method, params } : { method, params, options });
    const status = setup.fail?.[method];
    if (status !== undefined) throw googleError(status);
  };
  const consume = async (method: string, params: { media?: { body?: unknown } }) => {
    const stream = params.media?.body as ReadStream;
    const seen: { path: string; bytes?: Buffer } = { path: String(stream.path) };
    media.push(seen);
    call(method, params);
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part as Buffer);
    seen.bytes = Buffer.concat(parts);
    return seen.bytes;
  };
  const revision = (id: string | undefined) => {
    const found = setup.revisions?.[id ?? ''];
    if (found === undefined) throw googleError(404, `Revision not found: ${id}.`);
    return found;
  };
  const download = (bytes: Buffer): Readable =>
    setup.brokenDownload === true
      ? new Readable({
          read() {
            this.push(bytes.subarray(0, 100));
            this.destroy(googleError(403, 'The download was interrupted.'));
          },
        })
      : Readable.from([bytes]);
  const api = {
    files: {
      get: async (params: drive_v3.Params$Resource$Files$Get) => {
        call('files.get', params);
        const file = setup.files?.[params.fileId ?? ''];
        if (file === undefined) throw googleError(404, `File not found: ${params.fileId}.`);
        return { data: only(file, params.fields) };
      },
      list: async (params: drive_v3.Params$Resource$Files$List) => {
        call('files.list', params);
        const inner = /files\(([^)]*)\)/.exec(params.fields ?? '')?.[1];
        const { files, incompleteSearch } = setup.list ?? {};
        return {
          data: {
            ...(incompleteSearch === undefined ? {} : { incompleteSearch }),
            ...(files === undefined ? {} : { files: files.map((file) => only(file, inner)) }),
          },
        };
      },
      create: async (params: drive_v3.Params$Resource$Files$Create) => {
        const bytes = await consume('files.create', params);
        return { data: only(googleFile('NEW1', bytes, params.requestBody), params.fields) };
      },
      update: async (params: drive_v3.Params$Resource$Files$Update) => {
        const bytes = await consume('files.update', params);
        const before = setup.files?.[params.fileId ?? ''] ?? {};
        const after = googleFile(params.fileId ?? '', bytes, { ...before, ...params.requestBody });
        return { data: only(after, params.fields) };
      },
    },
    revisions: {
      get: async (params: drive_v3.Params$Resource$Revisions$Get, options?: object) => {
        call('revisions.get', params, options);
        const { mimeType, bytes } = revision(params.revisionId);
        if (params.alt === 'media') return { data: download(bytes) };
        return { data: only({ id: params.revisionId ?? '', mimeType }, params.fields) };
      },
      update: async (params: drive_v3.Params$Resource$Revisions$Update) => {
        call('revisions.update', params);
        return { data: { id: params.revisionId, keepForever: params.requestBody?.keepForever } };
      },
    },
  } as unknown as drive_v3.Drive;
  return { api, calls, media };
}

/** Вмешательство в PUT сессии с этим номером (с нуля — куски и вопросы вперемешку). */
interface Fault {
  /** Обрыв сети: до приёма куска или после — Drive принял, а ответ потерялся. */
  readonly drop?: 'before' | 'after';
  /** Ответить этим статусом, ничего не приняв. */
  readonly status?: number;
  /** Принять из куска только столько байт: Drive вправе принять меньше отправленного. */
  readonly accept?: number;
  /** Принять всё, а ответить 308 с полным `Range`: файл Drive отдаст на вопрос. */
  readonly hold?: boolean;
}

const reply = (
  status: number,
  headers: Record<string, string> = {},
  body = '',
): UploadResponse => ({
  status,
  headers,
  body,
});

const refusal = (status: number, message: string): UploadResponse =>
  reply(status, {}, JSON.stringify({ error: { code: status, message } }));

/** Resumable-сессия Drive по документации; `faults` — по номеру PUT-запроса. */
function resumableDrive(faults: Readonly<Record<number, Fault>> = {}) {
  const requests: UploadRequest[] = [];
  let received = Buffer.alloc(0);
  let total = -1;
  let fields: string | null = null;
  let meta: drive_v3.Schema$File = {};
  let id = 'NEW1';
  let puts = 0;
  const progress = (): UploadResponse => {
    if (received.length === total) {
      return reply(200, {}, JSON.stringify(only(googleFile(id, received, meta), fields)));
    }
    return reply(308, received.length === 0 ? {} : { range: `bytes=0-${received.length - 1}` });
  };
  const open = (request: UploadRequest): UploadResponse => {
    const url = new URL(request.url);
    fields = url.searchParams.get('fields');
    id = /^\/upload\/drive\/v3\/files\/(.+)$/.exec(url.pathname)?.[1] ?? 'NEW1';
    meta = JSON.parse(String(request.body)) as drive_v3.Schema$File;
    total = Number(request.headers['x-upload-content-length']);
    return reply(200, { location: SESSION });
  };
  const chunk = (request: UploadRequest, fault: Fault): UploadResponse => {
    const range = request.headers['content-range'] ?? '';
    // Вопрос «сколько принято»: `bytes */<всего>` без тела.
    if (range === `bytes */${total}` && request.body === undefined) return progress();
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (match === null) return refusal(400, `Invalid Content-Range ${range}`);
    const [from, to, all] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const body = request.body as Buffer;
    const sane =
      all === total && from === received.length && to >= from && body.length === to - from + 1;
    if (!sane) return refusal(400, `Invalid Content-Range ${range}`);
    if (to + 1 !== total && body.length % KIB_256 !== 0) {
      return refusal(400, 'Chunk size must be a multiple of 256 KiB');
    }
    received = Buffer.concat([received, body.subarray(0, fault.accept ?? body.length)]);
    if (fault.hold === true) return reply(308, { range: `bytes=0-${received.length - 1}` });
    return progress();
  };
  const transport: UploadTransport = async (request) => {
    requests.push(request);
    if (request.method !== 'PUT') return open(request);
    if (request.url !== SESSION) return refusal(404, 'Upload session not found');
    const fault = faults[puts] ?? {};
    puts += 1;
    if (fault.drop === 'before') throw networkDrop();
    if (fault.status !== undefined) return refusal(fault.status, `Fault ${fault.status}`);
    const response = chunk(request, fault);
    if (fault.drop === 'after') throw networkDrop();
    return response;
  };
  return { transport, requests, received: () => received };
}

/** PUT-запросы сессии: Content-Range и длина тела (у вопроса тела нет). */
const putsOf = (requests: readonly UploadRequest[]) =>
  requests
    .filter((request) => request.method === 'PUT')
    .map((request) => [request.headers['content-range'], request.body?.length ?? null]);

/** Транспорт, которого тест не ждёт: файл до порога не должен его касаться. */
const noTransport: UploadTransport = () => Promise.reject(new Error('транспорт не ждали'));

/** Клиент на фейках: порог и кусок — 256 КиБ, чтобы resumable шёл на файле в полмегабайта. */
function client(
  drive: { api: drive_v3.Drive },
  session?: { transport: UploadTransport },
  extra: Partial<GoogleDriveClientOptions> = {},
): GoogleDriveClient {
  return new GoogleDriveClient({
    accessToken: 'нет',
    api: drive.api,
    uploadTransport: session?.transport ?? noTransport,
    resumableAboveBytes: KIB_256,
    chunkBytes: KIB_256,
    scratchDir: scratch,
    ...extra,
  });
}

describe('Q45 — файл до порога: один multipart-запрос googleapis', () => {
  it('files.create: общие диски, поля загрузки, папка, имя, тип; тело — поток файла байт в байт', async () => {
    const { body, bytes } = await localFile(1000, 'обложка.png', 'image/png');
    const drive = fakeDrive();
    const info = await client(drive).upload(FOLDER, 'обложка.png', body);
    expect(drive.calls).toEqual([
      {
        method: 'files.create',
        params: {
          supportsAllDrives: true,
          fields: FIELDS,
          requestBody: { name: 'обложка.png', parents: [FOLDER], mimeType: 'image/png' },
          media: { mimeType: 'image/png', body: expect.any(Readable) },
        },
      },
    ]);
    expect(drive.media[0]?.bytes?.equals(bytes)).toBe(true);
    expect(info).toStrictEqual({
      id: 'NEW1',
      name: 'обложка.png',
      mimeType: 'image/png',
      size: 1000,
      sha256: sha256(bytes),
      modifiedTime: '2026-11-09T12:00:00.000Z',
      headRevisionId: 'REV-1000',
      webViewLink: 'https://drive.google.com/file/d/NEW1/view?usp=drivesdk',
      parents: [FOLDER],
    });
  });

  it('отказ Google — с именем файла и папкой, без повтора: создание не идемпотентно', async () => {
    const { body } = await localFile(1000);
    const drive = fakeDrive({ fail: { 'files.create': 503 } });
    await expect(client(drive).upload(FOLDER, 'ролик.mp4', body)).rejects.toMatchObject({
      payload: {
        code: 'google_unavailable',
        detail: `Не удалось загрузить «ролик.mp4» в папку ${FOLDER}.`,
      },
    });
    expect(drive.calls).toHaveLength(1);
  });
});

describe('Q45 — файл больше порога: resumable-сессия и куски', () => {
  it('сессия: POST на /upload с uploadType=resumable, общими дисками и полями; метаданные — имя, папка, тип', async () => {
    const { body, bytes } = await localFile(600_000);
    const drive = fakeDrive();
    const session = resumableDrive();
    const info = await client(drive, session).upload(FOLDER, 'ролик.mp4', body);
    const open = session.requests[0]!;
    const url = new URL(open.url);
    expect(open.method).toBe('POST');
    expect(`${url.origin}${url.pathname}`).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      uploadType: 'resumable',
      supportsAllDrives: 'true',
      fields: FIELDS,
    });
    expect(open.headers).toEqual({
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': '600000',
    });
    expect(JSON.parse(String(open.body))).toEqual({
      name: 'ролик.mp4',
      parents: [FOLDER],
      mimeType: 'video/mp4',
    });
    // Большой файл одним запросом — обрыв и всё сначала: multipart googleapis не звался.
    expect(drive.calls).toEqual([]);
    expect(info).toMatchObject({ id: 'NEW1', size: 600_000, sha256: sha256(bytes) });
  });

  it('куски по 256 КиБ с верным Content-Range, последний — остаток; Drive получил файл байт в байт', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive();
    await client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests)).toEqual([
      ['bytes 0-262143/600000', 262_144],
      ['bytes 262144-524287/600000', 262_144],
      ['bytes 524288-599999/600000', 75_712],
    ]);
    expect(session.received().equals(bytes)).toBe(true);
  });

  it('308 — Drive принял меньше отправленного: следующий кусок с принятого байта, а не с конца отправленного', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive({ 0: { accept: KIB_256 } });
    await client(fakeDrive(), session, { chunkBytes: 2 * KIB_256 }).upload(
      FOLDER,
      'ролик.mp4',
      body,
    );
    expect(putsOf(session.requests)).toEqual([
      ['bytes 0-524287/600000', 524_288],
      ['bytes 262144-599999/600000', 337_856],
    ]);
    expect(session.received().equals(bytes)).toBe(true);
  });

  it('обрыв после приёма куска — вопрос «сколько принято» без тела и продолжение с ответа Drive', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive({ 1: { drop: 'after' } });
    await client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests)).toEqual([
      ['bytes 0-262143/600000', 262_144],
      ['bytes 262144-524287/600000', 262_144],
      ['bytes */600000', null],
      ['bytes 524288-599999/600000', 75_712],
    ]);
    expect(session.received().equals(bytes)).toBe(true);
  });

  it('обрыв до приёма — после вопроса тот же кусок заново', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive({ 1: { drop: 'before' } });
    await client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests)).toEqual([
      ['bytes 0-262143/600000', 262_144],
      ['bytes 262144-524287/600000', 262_144],
      ['bytes */600000', null],
      ['bytes 262144-524287/600000', 262_144],
      ['bytes 524288-599999/600000', 75_712],
    ]);
    expect(session.received().equals(bytes)).toBe(true);
  });

  it('5xx на куске — тот же путь: вопрос и продолжение, а не отказ всей загрузки', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive({ 0: { status: 503 } });
    await client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests).slice(0, 3)).toEqual([
      ['bytes 0-262143/600000', 262_144],
      ['bytes */600000', null],
      ['bytes 0-262143/600000', 262_144],
    ]);
    expect(session.received().equals(bytes)).toBe(true);
  });

  it('обрыв на последнем куске, а Drive принял всё — файл из ответа на вопрос, без повторной отправки', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive({ 2: { drop: 'after' } });
    const info = await client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests).slice(2)).toEqual([
      ['bytes 524288-599999/600000', 75_712],
      ['bytes */600000', null],
    ]);
    expect(info).toMatchObject({ id: 'NEW1', size: 600_000, sha256: sha256(bytes) });
  });

  it('Drive подтвердил все байты ответом 308 — вопрос, а не пустой кусок с перевёрнутым Content-Range', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive({ 2: { hold: true } });
    const info = await client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests).slice(2)).toEqual([
      ['bytes 524288-599999/600000', 75_712],
      ['bytes */600000', null],
    ]);
    expect(info).toMatchObject({ id: 'NEW1', size: 600_000, sha256: sha256(bytes) });
  });

  it('сессии больше нет (404) — отказ сразу: ни вопроса, ни повтора, и сказано, что начинать заново', async () => {
    const { body } = await localFile(600_000);
    const session = resumableDrive({ 1: { status: 404 } });
    const error = client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body);
    await expect(error).rejects.toMatchObject({
      payload: {
        code: 'google_unavailable',
        retryable: false,
        detail:
          `Не удалось загрузить «ролик.mp4» в папку ${FOLDER}. Сессия загрузки Drive закрылась: ` +
          'принятое не сохранилось, загрузку нужно начать заново.',
      },
    });
    expect(putsOf(session.requests)).toHaveLength(2);
  });

  it('кусок отвергнут без надежды на повтор (403) — отказ сразу, без вопроса', async () => {
    const { body } = await localFile(600_000);
    const session = resumableDrive({ 0: { status: 403 } });
    await expect(
      client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body),
    ).rejects.toMatchObject({ payload: { code: 'forbidden' } });
    expect(putsOf(session.requests)).toEqual([['bytes 0-262143/600000', 262_144]]);
  });

  it('Drive не продвигается — три простоя подряд и отказ, а не вечный цикл', async () => {
    const { body } = await localFile(600_000);
    const stuck = { accept: 0 };
    const session = resumableDrive({ 0: stuck, 1: stuck, 2: stuck });
    await expect(
      client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', body),
    ).rejects.toMatchObject({
      payload: { code: 'google_unavailable', detail: expect.stringContaining('Загрузка встала') },
    });
    expect(putsOf(session.requests)).toEqual([
      ['bytes 0-262143/600000', 262_144],
      ['bytes 0-262143/600000', 262_144],
      ['bytes 0-262143/600000', 262_144],
    ]);
  });

  it('файл стал короче после проверки — отказ до отправки куска, Content-Range не врёт', async () => {
    const { body } = await localFile(500_000);
    const session = resumableDrive();
    const stale = { ...body, size: 600_000 };
    await expect(
      client(fakeDrive(), session).upload(FOLDER, 'ролик.mp4', stale),
    ).rejects.toMatchObject({
      payload: {
        code: 'bad_request',
        detail: expect.stringContaining('стал короче после проверки'),
      },
    });
    expect(putsOf(session.requests)).toEqual([['bytes 0-262143/600000', 262_144]]);
  });

  it('сессию не открыли (404 папки) — not_found с именем и папкой; отказ не повторяется', async () => {
    const { body } = await localFile(600_000);
    const requests: UploadRequest[] = [];
    const transport: UploadTransport = async (request) => {
      requests.push(request);
      return refusal(404, `File not found: ${FOLDER}.`);
    };
    await expect(
      client(fakeDrive(), { transport }).upload(FOLDER, 'ролик.mp4', body),
    ).rejects.toMatchObject({
      payload: {
        code: 'not_found',
        cause: `HTTP 404: File not found: ${FOLDER}.`,
        detail: `Не удалось загрузить «ролик.mp4» в папку ${FOLDER}. Drive не открыл сессию загрузки.`,
      },
    });
    expect(requests).toHaveLength(1);
  });

  it('сессия без адреса (Location) — внутренняя ошибка, а не кусок в никуда', async () => {
    const { body } = await localFile(600_000);
    const transport: UploadTransport = async () => reply(200);
    await expect(
      client(fakeDrive(), { transport }).upload(FOLDER, 'ролик.mp4', body),
    ).rejects.toMatchObject({
      payload: { code: 'internal', detail: expect.stringContaining('Location') },
    });
  });

  it('по умолчанию порог 5 МиБ и кусок 8 МиБ: ровно 5 МиБ — одним запросом, 8 МиБ + 1 — двумя кусками', async () => {
    const drive = fakeDrive();
    const session = resumableDrive();
    const defaults = new GoogleDriveClient({
      accessToken: 'нет',
      api: drive.api,
      uploadTransport: session.transport,
    });
    await defaults.upload(FOLDER, 'пять.bin', await sparseFile('пять.bin', 5 * 1024 * 1024));
    expect(drive.calls.map((call) => call.method)).toEqual(['files.create']);
    expect(session.requests).toEqual([]);
    await defaults.upload(
      FOLDER,
      'восемь.bin',
      await sparseFile('восемь.bin', 8 * 1024 * 1024 + 1),
    );
    expect(putsOf(session.requests)).toEqual([
      ['bytes 0-8388607/8388609', 8_388_608],
      ['bytes 8388608-8388608/8388609', 1],
    ]);
  });

  it.each([100_000, 0, KIB_256 + 1])(
    'кусок %i байт не кратен 256 КиБ — отказ в конструкторе, а не на первом большом файле',
    (chunkBytes) => {
      expect(() => client(fakeDrive(), undefined, { chunkBytes })).toThrow(
        expect.objectContaining({
          payload: expect.objectContaining({
            detail: expect.stringContaining('не кратен 256 КиБ'),
          }),
        }),
      );
    },
  );
});

describe('Q46 — замена содержимого: новая ревизия, ID и ссылка те же', () => {
  it('до порога — files.update по ID с media; тип — нового содержимого', async () => {
    const before = googleFile(FILE, Buffer.from('старое содержимое'));
    const drive = fakeDrive({ files: { [FILE]: before } });
    const { body, bytes } = await localFile(2000);
    const info = await client(drive).replace(FILE, body);
    expect(drive.calls).toEqual([
      {
        method: 'files.update',
        params: {
          fileId: FILE,
          supportsAllDrives: true,
          fields: FIELDS,
          requestBody: { mimeType: 'video/mp4' },
          media: { mimeType: 'video/mp4', body: expect.any(Readable) },
        },
      },
    ]);
    expect(drive.media[0]?.bytes?.equals(bytes)).toBe(true);
    expect(info).toMatchObject({
      id: FILE,
      webViewLink: before.webViewLink,
      size: 2000,
      sha256: sha256(bytes),
    });
  });

  it('больше порога — PATCH-сессия на /upload/drive/v3/files/<id>, те же куски', async () => {
    const { body, bytes } = await localFile(600_000);
    const drive = fakeDrive();
    const session = resumableDrive();
    const info = await client(drive, session).replace(FILE, body);
    const open = session.requests[0]!;
    const url = new URL(open.url);
    expect(open.method).toBe('PATCH');
    expect(url.pathname).toBe(`/upload/drive/v3/files/${FILE}`);
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('fields')).toBe(FIELDS);
    expect(JSON.parse(String(open.body))).toEqual({ mimeType: 'video/mp4' });
    expect(putsOf(session.requests)).toHaveLength(3);
    expect(drive.calls).toEqual([]);
    expect(info).toMatchObject({ id: FILE, size: 600_000, sha256: sha256(bytes) });
  });

  it('отказ — с ID файла, без повтора', async () => {
    const { body } = await localFile(2000);
    const drive = fakeDrive({ fail: { 'files.update': 500 } });
    await expect(client(drive).replace(FILE, body)).rejects.toMatchObject({
      payload: { code: 'google_unavailable', detail: `Не удалось заменить содержимое ${FILE}.` },
    });
    expect(drive.calls).toHaveLength(1);
  });
});

describe('Q47 — ревизии: удержать и вернуть', () => {
  it('keepRevision — revisions.update с keepForever: true', async () => {
    const drive = fakeDrive();
    await client(drive).keepRevision(FILE, 'REV1');
    expect(drive.calls).toEqual([
      {
        method: 'revisions.update',
        params: { fileId: FILE, revisionId: 'REV1', requestBody: { keepForever: true } },
      },
    ]);
  });

  it('keepRevision: нет ревизии — not_found с её ID и ID файла', async () => {
    const drive = fakeDrive({ fail: { 'revisions.update': 404 } });
    await expect(client(drive).keepRevision(FILE, 'REV1')).rejects.toMatchObject({
      payload: { code: 'not_found', detail: `Не удалось закрепить ревизию REV1 файла ${FILE}.` },
    });
  });

  it('restoreRevision — ревизия скачана во временный каталог и залита новой ревизией со своим типом; каталог пуст', async () => {
    const old = randomBytes(3000);
    const drive = fakeDrive({
      // Замена сменила тип: вернуть надо и содержимое, и тип ревизии.
      files: { [FILE]: googleFile(FILE, Buffer.from('новое'), { mimeType: 'video/quicktime' }) },
      revisions: { REV1: { mimeType: 'video/mp4', bytes: old } },
    });
    const info = await client(drive).restoreRevision(FILE, 'REV1');
    expect(drive.calls.slice(0, 2)).toEqual([
      {
        method: 'revisions.get',
        params: { fileId: FILE, revisionId: 'REV1', fields: 'id,mimeType' },
      },
      {
        method: 'revisions.get',
        params: { fileId: FILE, revisionId: 'REV1', alt: 'media' },
        options: { responseType: 'stream' },
      },
    ]);
    expect(drive.calls[2]).toMatchObject({
      method: 'files.update',
      params: {
        fileId: FILE,
        supportsAllDrives: true,
        fields: FIELDS,
        requestBody: { mimeType: 'video/mp4' },
        media: { mimeType: 'video/mp4' },
      },
    });
    expect(drive.media[0]?.path.startsWith(scratch)).toBe(true);
    expect(drive.media[0]?.bytes?.equals(old)).toBe(true);
    expect(info).toMatchObject({
      id: FILE,
      mimeType: 'video/mp4',
      size: 3000,
      sha256: sha256(old),
    });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('ревизия больше порога возвращается по частям — PATCH-сессия с её типом и размером', async () => {
    const old = randomBytes(600_000);
    const drive = fakeDrive({ revisions: { REV1: { mimeType: 'video/mp4', bytes: old } } });
    const session = resumableDrive();
    const info = await client(drive, session).restoreRevision(FILE, 'REV1');
    expect(session.requests[0]).toMatchObject({
      method: 'PATCH',
      headers: { 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': '600000' },
    });
    expect(session.received().equals(old)).toBe(true);
    expect(info).toMatchObject({ id: FILE, sha256: sha256(old) });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('заливка отвергнута — временный файл удалён, ошибка названа ревизией и файлом', async () => {
    const drive = fakeDrive({
      revisions: { REV1: { mimeType: 'video/mp4', bytes: randomBytes(3000) } },
      fail: { 'files.update': 403 },
    });
    await expect(client(drive).restoreRevision(FILE, 'REV1')).rejects.toMatchObject({
      payload: { code: 'forbidden', detail: `Не удалось вернуть ревизию REV1 файла ${FILE}.` },
    });
    expect(drive.media[0]?.path.startsWith(scratch)).toBe(true);
    expect(existsSync(drive.media[0]!.path)).toBe(false);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('скачивание оборвалось — заливки нет, временный файл удалён', async () => {
    const drive = fakeDrive({
      revisions: { REV1: { mimeType: 'video/mp4', bytes: randomBytes(3000) } },
      brokenDownload: true,
    });
    await expect(client(drive).restoreRevision(FILE, 'REV1')).rejects.toMatchObject({
      payload: { code: 'forbidden', detail: `Не удалось вернуть ревизию REV1 файла ${FILE}.` },
    });
    expect(drive.calls.map((call) => call.method)).toEqual(['revisions.get', 'revisions.get']);
    expect(await readdir(scratch)).toEqual([]);
  });
});

describe('fileInfo — сведения для загрузки и замены', () => {
  it('files.get по ID с общими дисками и полями загрузки; размер — числом', async () => {
    const file = googleFile(FILE, randomBytes(1234));
    const drive = fakeDrive({ files: { [FILE]: file } });
    const info = await client(drive).fileInfo(FILE);
    expect(drive.calls).toEqual([
      { method: 'files.get', params: { fileId: FILE, fields: FIELDS, supportsAllDrives: true } },
    ]);
    expect(info).toStrictEqual({
      id: FILE,
      name: 'ролик.mp4',
      mimeType: 'video/mp4',
      size: 1234,
      sha256: file.sha256Checksum,
      modifiedTime: file.modifiedTime,
      headRevisionId: file.headRevisionId,
      webViewLink: file.webViewLink,
      parents: [FOLDER],
    });
  });

  it('у таблицы Google нет размера, sha256 и ревизии — нет их и в ответе (не undefined, а нет)', async () => {
    const sheet: drive_v3.Schema$File = {
      id: 'SHEET1',
      name: 'Отчёт',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      webViewLink: 'https://docs.google.com/spreadsheets/d/SHEET1/edit',
      parents: [FOLDER],
    };
    const info = await client(fakeDrive({ files: { SHEET1: sheet } })).fileInfo('SHEET1');
    expect(info).toStrictEqual(sheet);
  });

  it('нет файла — not_found с ID в подробностях', async () => {
    await expect(client(fakeDrive()).fileInfo('NOPE')).rejects.toMatchObject({
      payload: { code: 'not_found', detail: 'Drive не отдал сведения о файле NOPE.' },
    });
  });
});

describe('Q48 — findByName: одноимённый файл в папке', () => {
  it('files.list: папка, точное имя, не в корзине; все диски; поля как у fileInfo; не больше 10', async () => {
    const file = googleFile('F1', randomBytes(10));
    const drive = fakeDrive({ list: { files: [file] } });
    const found = await client(drive).findByName(FOLDER, 'ролик.mp4');
    expect(drive.calls).toEqual([
      {
        method: 'files.list',
        params: {
          q: `'${FOLDER}' in parents and name = 'ролик.mp4' and trashed = false`,
          fields: `incompleteSearch,files(${FIELDS})`,
          pageSize: 10,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: 'allDrives',
        },
      },
    ]);
    expect(found).toStrictEqual([
      {
        id: 'F1',
        name: 'ролик.mp4',
        mimeType: 'video/mp4',
        size: 10,
        sha256: file.sha256Checksum,
        modifiedTime: file.modifiedTime,
        headRevisionId: file.headRevisionId,
        webViewLink: file.webViewLink,
        parents: [FOLDER],
      },
    ]);
  });

  it('апостроф и обратная косая в имени и ID — через обратную косую', async () => {
    const drive = fakeDrive({ list: { files: [] } });
    await client(drive).findByName("FOLDER'1", "O'Brien \\ итог.mp4");
    expect(drive.calls[0]?.params).toMatchObject({
      q: "'FOLDER\\'1' in parents and name = 'O\\'Brien \\\\ итог.mp4' and trashed = false",
    });
  });

  it('тот же экран — у поиска: обратная косая больше не ломает q', () => {
    expect(listParams({ nameContains: "a\\b'c" }, 10)['q']).toContain("name contains 'a\\\\b\\'c'");
  });

  it.each([
    ['пустой список', { files: [] }],
    ['ответ без files', {}],
  ])('ничего не нашлось (%s) — пустой список', async (_, list) => {
    expect(await client(fakeDrive({ list })).findByName(FOLDER, 'ролик.mp4')).toEqual([]);
  });

  it('Drive обыскал не все диски — отказ, а не «одноимённого нет»: иначе загрузка сделала бы копию', async () => {
    const drive = fakeDrive({ list: { files: [], incompleteSearch: true } });
    await expect(client(drive).findByName(FOLDER, 'ролик.mp4')).rejects.toMatchObject({
      payload: {
        code: 'google_unavailable',
        detail: expect.stringContaining('incompleteSearch'),
      },
    });
  });
});

describe('транспорт по умолчанию — request авторизованного клиента (подменён только fetch)', () => {
  /** Настоящий клиент из `authorizedClient`: под ним gaxios, под gaxios — этот fetch. */
  function wired(answer: () => Response) {
    const auth = authorizedClient('fake-access');
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    auth.transporter.defaults.fetchImplementation = async (url, init) => {
      seen.push({ url: url instanceof Request ? url.url : url.toString(), init });
      return answer();
    };
    return { transport: authorizedTransport(auth), seen };
  }

  it('доступ ставит клиент, кусок уходит как есть, 308 — ответ с Range, а не исключение', async () => {
    const { transport, seen } = wired(
      () => new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } }),
    );
    const chunk = randomBytes(KIB_256);
    const response = await transport({
      method: 'PUT',
      url: SESSION,
      headers: { 'content-range': 'bytes 0-262143/600000' },
      body: chunk,
    });
    expect(response).toEqual({ status: 308, headers: { range: 'bytes=0-262143' }, body: '' });
    const [request] = seen;
    const headers = new Headers(request?.init?.headers);
    expect(request?.url).toBe(SESSION);
    expect(request?.init?.method).toBe('PUT');
    expect(headers.get('authorization')).toBe('Bearer fake-access');
    expect(headers.get('content-range')).toBe('bytes 0-262143/600000');
    expect(request?.init?.body).toBe(chunk);
  });

  it('вопрос без тела уходит без тела; ответ-файл — текстом, как прислал Drive', async () => {
    const file = JSON.stringify({ id: 'NEW1', size: '600000' });
    const { transport, seen } = wired(
      () => new Response(file, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const response = await transport({
      method: 'PUT',
      url: SESSION,
      headers: { 'content-range': 'bytes */600000' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe(file);
    expect(seen[0]?.init?.body).toBeUndefined();
  });

  it('обрыв сети — исключение с причиной: протокол признаёт его поводом спросить, сколько принято', async () => {
    const { body, bytes } = await localFile(600_000);
    const session = resumableDrive();
    let first = true;
    const { transport } = wired(() => {
      throw networkDrop();
    });
    // Первый кусок рвётся в настоящем клиенте; дальше — сессия фейка.
    const flaky: UploadTransport = (request) => {
      if (request.method === 'PUT' && first) {
        first = false;
        return transport(request);
      }
      return session.transport(request);
    };
    await client(fakeDrive(), { transport: flaky }).upload(FOLDER, 'ролик.mp4', body);
    expect(putsOf(session.requests)[0]).toEqual(['bytes */600000', null]);
    expect(session.received().equals(bytes)).toBe(true);
  });
});
