/**
 * Поиск по Drive (DESIGN.md §7, §9.2).
 *
 * Здесь живёт капкан, из-за которого «файлов нет» — самый частый ложный вывод:
 * без `supportsAllDrives`, `includeItemsFromAllDrives` и `corpora=allDrives` API молча
 * отдаёт НЕПОЛНЫЙ список, а не ошибку. Поэтому параметры стоят всегда, а не по флагу.
 */

import { google, type drive_v3 } from 'googleapis';

import { fromGoogleError, gcError } from '../errors.js';
import { limitOf } from '../policy.js';
import { withRetry } from '../retry.js';
import type { RetryReporter } from './support.js';

export type SearchScope = 'myDrive' | 'sharedWithMe' | 'sharedDrives' | 'folder';

/**
 * `| undefined` у полей — не небрежность: при `exactOptionalPropertyTypes` результат
 * разбора zod (`optional()` даёт `string | undefined`) иначе не присвоить, и пришлось бы
 * растаскивать объект условными спредами на каждом вызове.
 */
export interface SearchQuery {
  readonly scope?: SearchScope | undefined;
  readonly folderId?: string | undefined;
  readonly nameContains?: string | undefined;
  /** Полнотекстовый поиск по содержимому: дёшево для документов и PDF (§9.5). */
  readonly fullText?: string | undefined;
  readonly type?: 'sheet' | 'doc' | 'folder' | 'any' | undefined;
  readonly modifiedAfter?: string | undefined;
  readonly limit?: number | undefined;
}

export interface FoundFile {
  readonly id: string;
  readonly name: string;
  readonly type: 'sheet' | 'doc' | 'folder' | 'other';
  readonly modifiedTime: string | null;
  readonly owner: string | null;
  /** `true` — файл на общем диске; для «моих» и «расшаренных мне» пусто. */
  readonly sharedDrive: boolean;
  readonly url: string;
}

export interface SearchResult {
  readonly files: readonly FoundFile[];
  /**
   * Чего этот поиск НЕ увидит. Не оговорка ради вежливости: файл, расшаренный ссылкой и
   * ни разу не открытый в Drive, отсутствует в выдаче `files.list` при том, что читается
   * по ID. Замерено на цели из реестра: `gc_read` её открывает, поиск — не находит.
   */
  readonly incompleteBecause: readonly string[];
}

const MIME: Readonly<Record<string, 'sheet' | 'doc' | 'folder'>> = {
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.folder': 'folder',
};

const MIME_BY_TYPE: Readonly<Record<string, string>> = {
  sheet: 'application/vnd.google-apps.spreadsheet',
  doc: 'application/vnd.google-apps.document',
  folder: 'application/vnd.google-apps.folder',
};

const escape = (value: string): string => value.replace(/'/g, "\\'");

export function buildQuery(query: SearchQuery): string {
  const parts = ['trashed = false'];
  // Область РЕАЛЬНО сужается, а не только объявляется. Нашла живая проба: без этих
  // условий `myDrive` и `sharedDrives` возвращали один и тот же список, включая чужие
  // файлы — то есть параметр был декорацией.
  if (query.scope === 'myDrive') parts.push("'me' in owners");
  if (query.scope === 'sharedWithMe') parts.push('sharedWithMe');
  if (query.folderId !== undefined) parts.push(`'${escape(query.folderId)}' in parents`);
  if (query.nameContains !== undefined) parts.push(`name contains '${escape(query.nameContains)}'`);
  if (query.fullText !== undefined) parts.push(`fullText contains '${escape(query.fullText)}'`);
  const mime =
    query.type === undefined || query.type === 'any' ? undefined : MIME_BY_TYPE[query.type];
  if (mime !== undefined) parts.push(`mimeType = '${mime}'`);
  if (query.modifiedAfter !== undefined)
    parts.push(`modifiedTime > '${escape(query.modifiedAfter)}'`);
  return parts.join(' and ');
}

/** Бюджет файлов за вызов: источник истины — правило `scan.max-files`. */
export function clampLimit(requested: number | undefined): number {
  const max = limitOf('scan.max-files', 500);
  const asked = requested ?? 50;
  return Math.max(1, Math.min(asked, max));
}

/**
 * Параметры `files.list`. Вынесено чистой функцией, чтобы инвариант «параметры общих
 * дисков стоят всегда» проверялся тестом, а не читался глазами: без них список неполон
 * МОЛЧА, и это самый дорогой сорт ошибки (§9.2).
 */
export function listParams(query: SearchQuery, limit: number): Record<string, unknown> {
  return {
    q: buildQuery(query),
    // Берём с запасом: у области `sharedDrives` часть выдачи отфильтруется по driveId.
    pageSize: Math.min(Math.max(limit * 2, limit), 1000),
    fields: 'files(id,name,mimeType,modifiedTime,driveId,owners(emailAddress))',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(query.scope === 'sharedDrives' ? { corpora: 'allDrives' } : {}),
  };
}

/** Ссылка на файл по типу. Вынесено: тройная вложенная тернарка копила сложность. */
function urlFor(type: FoundFile['type'], id: string): string {
  if (type === 'sheet') return `https://docs.google.com/spreadsheets/d/${id}/edit`;
  if (type === 'doc') return `https://docs.google.com/document/d/${id}/edit`;
  if (type === 'folder') return `https://drive.google.com/drive/folders/${id}`;
  return `https://drive.google.com/file/d/${id}/view`;
}

function toFoundFile(file: drive_v3.Schema$File): FoundFile {
  const id = file.id ?? '';
  const type = MIME[file.mimeType ?? ''] ?? 'other';
  return {
    id,
    name: file.name ?? 'без имени',
    type,
    modifiedTime: file.modifiedTime ?? null,
    owner: file.owners?.[0]?.emailAddress ?? null,
    sharedDrive: file.driveId !== undefined && file.driveId !== null,
    url: urlFor(type, id),
  };
}

/** Чем область поиска ограничена — говорится всегда, а не когда результат пуст. */
export function incompletenessNotes(scope: SearchScope | undefined): string[] {
  const notes = [
    'Файл, расшаренный ссылкой и ни разу не открытый в Drive, в выдачу не попадает, ' +
      'хотя читается по ID: проверь gc_targets — цели реестра могут не находиться поиском.',
  ];
  if (scope === 'myDrive') notes.push('Область «мои файлы»: чужие и расшаренные не входят.');
  if (scope === 'sharedWithMe') notes.push('Область «доступные мне»: свои файлы не входят.');
  if (scope === 'sharedDrives') {
    notes.push('Область «общие диски»: файлы с личного Диска отфильтрованы.');
  }
  return notes;
}

/** Что создаём: тип определяет mimeType, а он в Drive неизменяем после создания. */
export type CreateKind = 'sheet' | 'doc' | 'folder';

export interface CreatedFile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface DriveClient {
  search(query: SearchQuery): Promise<SearchResult>;
  /**
   * Создать пустой файл или папку. `parentId` не задан — файл ложится в корень «Мой
   * диск»: у Drive у файла ровно один родитель, и множественные не поддерживаются.
   */
  create(kind: CreateKind, name: string, parentId?: string): Promise<CreatedFile>;
  /**
   * В корзину, а не насовсем. `files.delete` уничтожает безвозвратно и вместе со всем
   * содержимым папки — такого инструмента у агента не будет.
   */
  trash(fileId: string): Promise<void>;
}

/** Тип → mimeType Google. Значения из документации Drive, менять нельзя. */
export const CREATE_MIME: Record<CreateKind, string> = {
  sheet: 'application/vnd.google-apps.spreadsheet',
  doc: 'application/vnd.google-apps.document',
  folder: 'application/vnd.google-apps.folder',
};

export class GoogleDriveClient implements DriveClient {
  private readonly drive: drive_v3.Drive;

  /** Повторы — только у поиска: создание и корзина не идемпотентны, их не повторяют. */
  constructor(
    accessToken: string,
    private readonly onRetry?: RetryReporter,
  ) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.drive = google.drive({ version: 'v3', auth });
  }

  async create(kind: CreateKind, name: string, parentId?: string): Promise<CreatedFile> {
    try {
      // `fields` обязателен: по умолчанию Drive отдаёт минимум, и ссылки в ответе не
      // будет — человек получил бы «создано» без возможности открыть.
      const response = await this.drive.files.create({
        supportsAllDrives: true,
        fields: 'id,name,mimeType,webViewLink',
        requestBody: {
          name,
          mimeType: CREATE_MIME[kind],
          ...(parentId === undefined ? {} : { parents: [parentId] }),
        },
      });
      const file = response.data;
      if (file.id === undefined || file.id === null) {
        throw gcError('internal', { detail: 'Drive не вернул id созданного файла.' });
      }
      return {
        id: file.id,
        name: file.name ?? name,
        url: file.webViewLink ?? `https://drive.google.com/open?id=${file.id}`,
      };
    } catch (error) {
      throw fromGoogleError(error, `Не удалось создать «${name}».`);
    }
  }

  async trash(fileId: string): Promise<void> {
    try {
      await this.drive.files.update({
        fileId,
        supportsAllDrives: true,
        requestBody: { trashed: true },
      });
    } catch (error) {
      throw fromGoogleError(error, `Не удалось отправить ${fileId} в корзину.`);
    }
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const limit = clampLimit(query.limit);
    try {
      const response = await withRetry(
        () => this.drive.files.list(listParams(query, limit)),
        this.onRetry === undefined ? {} : { onRetry: this.onRetry },
      );

      const all = (response.data.files ?? []).map(toFoundFile);
      // «Общие диски» означает именно их: файл без driveId живёт на личном Диске,
      // и оставлять его в этой области значит врать про область.
      const scoped = query.scope === 'sharedDrives' ? all.filter((f) => f.sharedDrive) : all;
      return {
        files: scoped.slice(0, limit),
        incompleteBecause: incompletenessNotes(query.scope),
      };
    } catch (error) {
      throw fromGoogleError(error, 'Поиск по Drive не удался.');
    }
  }
}
