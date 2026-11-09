/**
 * Содержимое файла на Drive (D-27, Q45–Q47): одним запросом или по частям.
 *
 * googleapis-common 8.x загружает только multipart: `files.create({ media })` — один запрос, и
 * `uploadType` библиотека ставит сама, resumable-сессий в ней нет. Ролик в 40–65 МБ одним
 * запросом при обрыве на 60-м мегабайте начинается заново, поэтому файл больше порога идёт
 * resumable-протоколом Drive — здесь, через тот же авторизованный клиент (`request` у
 * OAuth2Client) и внедряемый транспорт: шов судится тестом на форме запросов Google, без сети.
 *
 * Протокол (документация Drive, «Perform a resumable upload»): POST (новый файл) или PATCH (новая
 * ревизия) на `/upload/drive/v3/files` с `uploadType=resumable` и метаданными — ответ 200 с адресом
 * сессии в `Location`. Куски — PUT на этот адрес с `Content-Range`, кратные 256 КиБ (кроме
 * последнего). На непоследний кусок Drive отвечает 308 и `Range: bytes=0-N`: принято N+1 байт — не
 * обязательно всё отправленное, следующий кусок идёт с N+1. На последний — 200/201 и файл. Обрыв —
 * вопрос «сколько принято» (PUT без тела) и продолжение оттуда; 404/410 — сессии больше нет.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { drive_v3 } from 'googleapis';

import { fromGoogleError, gcError, type GcError } from '../errors.js';
import type { authorizedClient } from './support.js';

/** Тело загрузки — локальный файл, уже проверенный `vetLocalFile` (`src/core/upload/local-file.ts`). */
export interface UploadBody {
  /** Абсолютный путь. */
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
}

/** Запрос протокола загрузки — ровно то, что уйдёт по HTTP. */
export interface UploadRequest {
  readonly method: 'POST' | 'PATCH' | 'PUT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Метаданные JSON-строкой — при открытии сессии, кусок файла — при отправке; вопрос — без тела. */
  readonly body?: string | Buffer;
}

/** Ответ как есть: статус судит протокол, а не транспорт (308 — шаг загрузки, а не ошибка). */
export interface UploadResponse {
  readonly status: number;
  /** Имена — в нижнем регистре. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type UploadTransport = (request: UploadRequest) => Promise<UploadResponse>;

export interface UploadOptions {
  /** Транспорт загрузки по частям; по умолчанию — `request` авторизованного клиента. */
  readonly uploadTransport?: UploadTransport;
  /** Файл больше порога (байт) идёт по частям; по умолчанию 5 МиБ. */
  readonly resumableAboveBytes?: number;
  /** Кусок resumable-загрузки, кратный 256 КиБ; по умолчанию 8 МиБ. */
  readonly chunkBytes?: number;
  /** Куда скачивается ревизия при откате замены; по умолчанию — `os.tmpdir()`. */
  readonly scratchDir?: string;
}

/** Всё, что нужно загрузке. `retry` — только идемпотентному: открыть сессию, спросить, скачать. */
export interface Uploader {
  readonly drive: drive_v3.Drive;
  readonly transport: UploadTransport;
  readonly retry: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Поля файла в ответе Drive — те же, что у `fileInfo`. */
  readonly fields: string;
  readonly resumableAboveBytes: number;
  readonly chunkBytes: number;
  readonly scratchDir: string;
}

/** Новый файл в папке или новая ревизия существующего (ID и ссылка те же). */
export type UploadTarget =
  | { readonly kind: 'create'; readonly parentId: string; readonly name: string }
  | { readonly kind: 'update'; readonly fileId: string };

/** Ответ сессии на шаг: файл готов — или Drive принял столько-то байт. */
type Step = { readonly file: drive_v3.Schema$File } | { readonly accepted: number };

/** От авторизованного клиента транспорту нужен только запрос: заголовок доступа ставит клиент. */
type AuthorizedClient = Pick<ReturnType<typeof authorizedClient>, 'request'>;

/**
 * Загрузчик по опциям клиента. Кусок не кратен 256 КиБ — отказ сразу: такой непоследний кусок
 * Drive не примет, и ошибка всплыла бы на первом большом файле человека, а не здесь.
 */
export function makeUploader(
  base: Pick<Uploader, 'drive' | 'retry' | 'fields'>,
  options: UploadOptions,
  auth: AuthorizedClient,
): Uploader {
  const quantum = 256 * 1024;
  const chunkBytes = options.chunkBytes ?? 32 * quantum;
  if (!(chunkBytes > 0 && chunkBytes % quantum === 0)) {
    throw gcError('internal', { detail: `Кусок загрузки ${chunkBytes} байт не кратен 256 КиБ.` });
  }
  return {
    ...base,
    transport: options.uploadTransport ?? authorizedTransport(auth),
    resumableAboveBytes: options.resumableAboveBytes ?? 5 * 1024 * 1024,
    chunkBytes,
    scratchDir: options.scratchDir ?? tmpdir(),
  };
}

/** Транспорт поверх `request` авторизованного клиента — того же, через который ходит googleapis. */
export function authorizedTransport(auth: AuthorizedClient): UploadTransport {
  return async (request) => {
    const response = await auth.request<string>({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(request.body === undefined ? {} : { data: request.body }),
      responseType: 'text',
      // Для gaxios 308 — ошибка, для загрузки — «принято не всё, продолжай»: статус судит протокол.
      validateStatus: () => true,
      // Повтор куска вслепую не знает, сколько Drive уже принял: после сбоя протокол спрашивает.
      retry: false,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body = typeof response.data === 'string' ? response.data : '';
    return { status: response.status, headers, body };
  };
}

/** Содержимое `body` — новым файлом или новой ревизией; больше порога — по частям. */
export async function sendContent(
  uploader: Uploader,
  target: UploadTarget,
  body: UploadBody,
): Promise<drive_v3.Schema$File> {
  if (body.size <= uploader.resumableAboveBytes) return sendWhole(uploader, target, body);
  const session = await openSession(uploader, target, body);
  return sendChunks(uploader, session, body);
}

/**
 * Содержимое ревизии `revisionId` — новой ревизией того же файла (откат замены, Q47). Ревизия
 * скачивается в свой временный каталог (`mkdtemp`) и заливается тем же путём, что `replace`, с
 * ТИПОМ РЕВИЗИИ: откат замены, сменившей тип, иначе вернул бы старое содержимое под новым типом.
 * Каталог удаляется всегда — и после заливки, и при ошибке на любом шаге.
 */
export async function restoreContent(
  uploader: Uploader,
  fileId: string,
  revisionId: string,
): Promise<drive_v3.Schema$File> {
  const dir = await mkdtemp(join(uploader.scratchDir, 'gconnect-revision-'));
  try {
    const { data: revision } = await uploader.retry(() =>
      uploader.drive.revisions.get({ fileId, revisionId, fields: 'id,mimeType' }),
    );
    const path = join(dir, 'content');
    const size = await uploader.retry(() => download(uploader.drive, fileId, revisionId, path));
    const mimeType = revision.mimeType ?? 'application/octet-stream';
    return await sendContent(uploader, { kind: 'update', fileId }, { path, size, mimeType });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ревизия в файл `path`; повтор переписывает файл с начала. */
async function download(
  drive: drive_v3.Drive,
  fileId: string,
  revisionId: string,
  path: string,
): Promise<number> {
  const response = await drive.revisions.get(
    { fileId, revisionId, alt: 'media' },
    { responseType: 'stream' },
  );
  await pipeline(response.data, createWriteStream(path));
  return (await stat(path)).size;
}

/** Метаданные: новому файлу — имя, папка и тип; новой ревизии — тип содержимого. */
function metadataOf(target: UploadTarget, body: UploadBody): drive_v3.Schema$File {
  return target.kind === 'create'
    ? { name: target.name, parents: [target.parentId], mimeType: body.mimeType }
    : { mimeType: body.mimeType };
}

/** Маленький файл — одним multipart-запросом googleapis; поток закрывается и при ошибке. */
async function sendWhole(
  uploader: Uploader,
  target: UploadTarget,
  body: UploadBody,
): Promise<drive_v3.Schema$File> {
  const stream = createReadStream(body.path);
  try {
    const common = {
      supportsAllDrives: true,
      fields: uploader.fields,
      requestBody: metadataOf(target, body),
      media: { mimeType: body.mimeType, body: stream },
    };
    const { data } =
      target.kind === 'create'
        ? await uploader.drive.files.create(common)
        : await uploader.drive.files.update({ fileId: target.fileId, ...common });
    return data;
  } finally {
    stream.destroy();
  }
}

/** Адрес открытия сессии: `fields` здесь задают поля ответа на последний кусок. */
function sessionUrl(target: UploadTarget, fields: string): string {
  const file = target.kind === 'create' ? '' : `/${encodeURIComponent(target.fileId)}`;
  const url = new URL(`https://www.googleapis.com/upload/drive/v3/files${file}`);
  url.search = new URLSearchParams({
    uploadType: 'resumable',
    supportsAllDrives: 'true',
    fields,
  }).toString();
  return url.toString();
}

/**
 * Открыть сессию. Повтор безопасен: сессия ничего не создаёт до последнего байта, а брошенная
 * истекает сама — в отличие от `files.create`, который повторять нельзя.
 */
async function openSession(
  uploader: Uploader,
  target: UploadTarget,
  body: UploadBody,
): Promise<string> {
  const response = await uploader.retry(async () => {
    const answer = await uploader.transport({
      method: target.kind === 'create' ? 'POST' : 'PATCH',
      url: sessionUrl(target, uploader.fields),
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': body.mimeType,
        'x-upload-content-length': String(body.size),
      },
      body: JSON.stringify(metadataOf(target, body)),
    });
    if (answer.status < 200 || answer.status >= 300) {
      throw httpFailure(answer, 'Drive не открыл сессию загрузки.');
    }
    return answer;
  });
  const location = response.headers['location'];
  if (location === undefined || location === '') {
    throw gcError('internal', { detail: 'Drive открыл сессию загрузки без адреса (Location).' });
  }
  return location;
}

/**
 * Куски с принятого Drive байта до конца. Продвижение считает Drive, а не отправитель: шаг, после
 * которого принято не больше прежнего, — простой; три простоя подряд — отказ, а не вечный цикл.
 */
async function sendChunks(
  uploader: Uploader,
  session: string,
  body: UploadBody,
): Promise<drive_v3.Schema$File> {
  const file = await open(body.path, 'r');
  try {
    let accepted = 0;
    let stalls = 0;
    for (;;) {
      const step = await sendChunk(uploader, session, file, body, accepted);
      if ('file' in step) return step.file;
      stalls = step.accepted > accepted ? 0 : stalls + 1;
      if (stalls >= 3) {
        throw gcError('google_unavailable', {
          detail: `Загрузка встала: Drive трижды подряд не принял ни байта (принято ${step.accepted} из ${body.size}).`,
        });
      }
      accepted = step.accepted;
    }
  } finally {
    await file.close();
  }
}

/** Кусок с `from`; сбой, который лечится повтором, — вопрос «сколько принято», он идемпотентен. */
async function sendChunk(
  uploader: Uploader,
  session: string,
  file: FileHandle,
  body: UploadBody,
  from: number,
): Promise<Step> {
  // Drive принял всё, а ответа «готово» не было (обрыв): слать нечего — спросить.
  if (from >= body.size) return askProgress(uploader, session, body.size);
  const to = Math.min(from + uploader.chunkBytes, body.size);
  const chunk = await readChunk(file, from, to - from, body);
  try {
    const response = await uploader.transport({
      method: 'PUT',
      url: session,
      headers: { 'content-range': `bytes ${from}-${to - 1}/${body.size}` },
      body: chunk,
    });
    return stepOf(response);
  } catch (error) {
    const failure = fromGoogleError(error);
    if (!failure.payload.retryable) throw failure;
    return askProgress(uploader, session, body.size);
  }
}

// Вопрос «сколько принято»: PUT без тела с `Content-Range: bytes */<всего>` (документация Drive).
function askProgress(uploader: Uploader, session: string, total: number): Promise<Step> {
  return uploader.retry(async () =>
    stepOf(
      await uploader.transport({
        method: 'PUT',
        url: session,
        headers: { 'content-range': `bytes */${total}` },
      }),
    ),
  );
}

/** Ответ сессии → шаг. Ошибка несёт `retryable` разбора Google: по нему решают, спрашивать ли. */
function stepOf(response: UploadResponse): Step {
  if (response.status === 200 || response.status === 201) return { file: fileOf(response.body) };
  if (response.status === 308) return { accepted: acceptedOf(response.headers['range']) };
  if (response.status === 404 || response.status === 410) {
    // Сессии нет (истекла или закрыта): повтор вопроса тот же 404, поэтому не retryable.
    throw gcError('google_unavailable', {
      detail:
        'Сессия загрузки Drive закрылась: принятое не сохранилось, загрузку нужно начать заново.',
      cause: `HTTP ${response.status}: ${messageOf(response.body)}`,
      retryable: false,
    });
  }
  throw httpFailure(response, 'Drive не принял кусок загрузки.');
}

/** `Range: bytes=0-N` — принято N+1 байт; заголовка нет — не принято ничего. */
function acceptedOf(range: string | undefined): number {
  const last = /^bytes=0-(\d+)$/.exec(range ?? '')?.[1];
  return last === undefined ? 0 : Number(last) + 1;
}

/** Ровно `length` байт с `position`. Меньше — файл изменился после проверки, и Content-Range соврал бы. */
async function readChunk(
  file: FileHandle,
  position: number,
  length: number,
  body: UploadBody,
): Promise<Buffer> {
  const chunk = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(chunk, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw gcError('bad_request', {
        detail: `Файл ${body.path} стал короче после проверки: ждали ${body.size} байт, на месте ${position + filled}. Проверь файл и загрузи заново.`,
      });
    }
    filled += bytesRead;
  }
  return chunk;
}

/** Файл из ответа на последний кусок. */
function fileOf(body: string): drive_v3.Schema$File {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw gcError('internal', { detail: 'Drive закончил загрузку ответом без файла.' });
  }
  return parsed;
}

/** Ответ-отказ — тем же разбором, что ошибки googleapis: статус и текст `error.message`. */
function httpFailure(response: UploadResponse, detail: string): GcError {
  return fromGoogleError({ status: response.status, message: messageOf(response.body) }, detail);
}

/** Текст ошибки Google из `{"error":{"message":…}}`; не JSON — тело как есть. */
function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } } | null;
    const message = parsed?.error?.message;
    return typeof message === 'string' ? message : body;
  } catch {
    return body;
  }
}
