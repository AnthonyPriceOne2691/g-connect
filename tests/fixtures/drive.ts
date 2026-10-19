import { gcError } from '../../src/core/errors.js';
import type { CreateKind, DriveClient, DriveFile } from '../../src/core/google/drive.js';

/**
 * Фейк Drive: помнит созданное и отправленное в корзину — этим и проверяем откат.
 *
 * Родитель созданного записывается ВСЕГДА (D-26, Q22): прежде фейк опускал его, когда шов
 * получал `undefined`, и «создано без папки» — то есть в корне — выглядело в тестах так же,
 * как отсутствие поля. Вид по ID (`fileKind`) знает только переданные файлы; остальное —
 * `not_found`, как отвечает Drive на чужой или несуществующий ID.
 */
export class FakeDriveClient implements DriveClient {
  readonly created: { id: string; name: string; kind: string; parentId: string }[] = [];
  readonly trashed: string[] = [];
  /** О каких ID спросили вид: ядро обязано спрашивать только о голом ID (Q20, Q22). */
  readonly asked: string[] = [];

  constructor(private readonly files: Readonly<Record<string, Omit<DriveFile, 'id'>>> = {}) {}

  search(): Promise<{ files: never[]; incompleteBecause: never[] }> {
    return Promise.resolve({ files: [], incompleteBecause: [] });
  }

  fileKind(id: string): Promise<DriveFile> {
    this.asked.push(id);
    const file = this.files[id];
    if (file === undefined) {
      return Promise.reject(gcError('not_found', { cause: `HTTP 404: File not found: ${id}.` }));
    }
    return Promise.resolve({ id, ...file });
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
    this.trashed.push(fileId);
    return Promise.resolve();
  }
}
