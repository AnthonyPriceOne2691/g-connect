/**
 * Файл с компьютера для загрузки на Drive (D-26, Q45–Q47) — или отказ.
 *
 * Решение владельца 2026-11-09 («Из папки проекта сессии»): агент берёт файлы только внутри
 * каталога проекта своей сессии (`CLAUDE_PROJECT_DIR`), и никогда — скрытые пути и секреты
 * (`.ssh`, `.gconnect`, `.env`, ключи). Без этого агент мог бы выложить на Диск любой файл
 * компьютера, в том числе ключи и токены. Путь сверяется после `realpath`: ссылка из проекта
 * наружу — тоже отказ.
 */

import { gcError } from '../errors.js';

/** Проверенный файл: всё, что нужно превью и шву загрузки. */
export interface LocalFile {
  /** Абсолютный путь после `realpath` — внутри каталога проекта. */
  readonly path: string;
  /** Имя файла — последний сегмент пути. */
  readonly name: string;
  /** Байты. */
  readonly size: number;
  /** sha256 содержимого, hex в нижнем регистре. */
  readonly sha256: string;
  /** Тип по расширению; незнакомое — `application/octet-stream`. */
  readonly mimeType: string;
}

/**
 * Файл `localPath` (абсолютный или от каталога проекта) — если он внутри `projectDir`, не скрытый,
 * не секрет, обычный файл и не больше предела `upload.max-bytes`. Иначе — отказ `bad_request` или
 * `policy_denied` с причиной. Контракт PR #22: тело — у агента проверки (U2).
 */
export function vetLocalFile(projectDir: string, localPath: string): Promise<LocalFile> {
  return Promise.reject(
    gcError('internal', {
      detail: `Проверка файла ещё не готова: ${localPath} в ${projectDir}.`,
    }),
  );
}
