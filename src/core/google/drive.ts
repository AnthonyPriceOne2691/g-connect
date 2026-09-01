/**
 * Поиск по Drive (DESIGN.md §7, §9.2).
 *
 * Здесь живёт капкан, из-за которого «файлов нет» — самый частый ложный вывод:
 * без `supportsAllDrives`, `includeItemsFromAllDrives` и `corpora=allDrives` API молча
 * отдаёт НЕПОЛНЫЙ список, а не ошибку. Поэтому параметры стоят всегда, а не по флагу.
 */

import { google, type drive_v3 } from 'googleapis';

import { fromGoogleError } from '../errors.js';
import { limitOf } from '../policy.js';
import { withRetry } from '../retry.js';

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
  readonly url: string;
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
    pageSize: Math.min(limit, 1000),
    fields: 'files(id,name,mimeType,modifiedTime,owners(emailAddress))',
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
    url: urlFor(type, id),
  };
}

export interface DriveClient {
  search(query: SearchQuery): Promise<readonly FoundFile[]>;
}

export class GoogleDriveClient implements DriveClient {
  private readonly drive: drive_v3.Drive;

  constructor(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.drive = google.drive({ version: 'v3', auth });
  }

  async search(query: SearchQuery): Promise<readonly FoundFile[]> {
    const limit = clampLimit(query.limit);
    try {
      const response = await withRetry(() => this.drive.files.list(listParams(query, limit)));

      return (response.data.files ?? []).slice(0, limit).map(toFoundFile);
    } catch (error) {
      throw fromGoogleError(error, 'Поиск по Drive не удался.');
    }
  }
}
