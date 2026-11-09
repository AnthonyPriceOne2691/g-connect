/**
 * Проверки загрузки (D-27, Q45–Q48): что можно заменить загрузкой и совпало ли загруженное с
 * локальным. Отдельным модулем от контура записи: здесь «пускать ли», там «как писать».
 */

import { gcError, type GcError } from '../errors.js';
import type { DriveFileInfo } from '../google/drive.js';
import type { LocalFile } from './local-file.js';
import { shortSha, sizeText } from './upload-plan.js';

/** «Мир изменился после плана» — у предусловия, у ушедшей ревизии и у сверки (Q46). */
export const stale = (detail: string, cause: string): GcError =>
  gcError('stale_value', { detail, cause });

/** Вид файла Google человеку; у загруженного файла — `null`. */
function googleKind(mimeType: string): string | null {
  const known: Readonly<Record<string, string>> = {
    'application/vnd.google-apps.folder': 'папка',
    'application/vnd.google-apps.spreadsheet': 'таблица Google',
    'application/vnd.google-apps.document': 'документ Google',
  };
  const named = known[mimeType];
  if (named !== undefined) return named;
  return mimeType.startsWith('application/vnd.google-apps.') ? `файл Google (${mimeType})` : null;
}

/**
 * Заменить загрузкой можно только загруженный файл: содержимое таблицы и документа Google — не
 * файл, его правят операциями, а у папки содержимого нет вовсе. Отказ — до плана и до записи.
 * `via` — как найден файл: одноимённый в папке или названный по ID.
 */
export function assertReplaceable(file: DriveFileInfo, via: 'id' | 'folder'): DriveFileInfo {
  const kind = googleKind(file.mimeType);
  if (kind === null) return file;
  const folder = kind === 'папка';
  const why = folder
    ? 'у папки содержимого нет'
    : 'содержимое файла Google заменяется правками, а не загрузкой';
  const what =
    via === 'folder'
      ? `В папке уже есть «${file.name}» — ${kind}, а не загруженный файл: ${why}. Назови файл ` +
        'иначе (name) — он ляжет рядом новым.'
      : `Цель «${file.name}» — ${kind}: ${why}.` +
        (folder
          ? ' В папку загружают без replace: одноимённый файл в ней получит свежую версию.'
          : '');
  throw gcError('bad_request', {
    detail: `${what} Ничего не загружено.`,
    cause: 'upload_not_a_file',
  });
}

/** Чем откатить загруженное, если оно не совпало с локальным, — и что сказать в обоих исходах. */
export interface MismatchUndo {
  readonly undo: () => Promise<unknown>;
  /** Откат удался: что стало на Диске. */
  readonly undone: string;
  /** Откат не удался: что осталось на Диске и что сделать руками. */
  readonly stuck: string;
}

/**
 * Сверка загруженного с локальным: sha256, а без него — размер. Расхождение откатывается сразу:
 * строки журнала у такой записи не будет, и `gc_undo` её бы не нашёл. Ответ — чем сверено.
 */
export async function checkedUpload(
  remote: DriveFileInfo,
  local: LocalFile,
  revert: MismatchUndo,
): Promise<string> {
  const verdict = verdictOf(remote, local);
  if (verdict !== null) return verdict;
  const differs =
    remote.sha256 === undefined
      ? `размер на Диске ${sizeText(remote.size)}, у локального «${local.name}» — ${sizeText(local.size)}`
      : `sha256 на Диске ${shortSha(remote.sha256)}, у локального «${local.name}» — ` +
        shortSha(local.sha256);
  const detail =
    `Drive получил не то, что лежит на диске: ${differs}. Обычно так бывает, когда файл ещё ` +
    'дописывается.';
  const reverted = await revert.undo().then(
    () => true,
    () => false,
  );
  if (reverted) {
    throw stale(
      `${detail} ${revert.undone}, строки журнала нет. Дождись, пока файл допишется, и покажи ` +
        'план заново.',
      'upload_checksum_mismatch',
    );
  }
  throw gcError('write_outcome_unknown', {
    detail: `${detail} ${revert.stuck}.`,
    cause: 'upload_checksum_mismatch',
  });
}

/** Чем сверено загруженное — или `null`, если оно расходится с локальным. */
function verdictOf(remote: DriveFileInfo, local: LocalFile): string | null {
  if (remote.sha256 !== undefined) {
    return remote.sha256.toLowerCase() === local.sha256.toLowerCase()
      ? `Сверено: sha256 на Диске совпал с локальным (${shortSha(local.sha256)}).`
      : null;
  }
  if (remote.size !== undefined) {
    return remote.size === local.size
      ? `Drive не назвал sha256 загруженного — сверено по размеру (${sizeText(local.size)}).`
      : null;
  }
  return (
    'Drive не назвал ни sha256, ни размер загруженного — сверить содержимое нечем: открой файл ' +
    'по ссылке и проверь.'
  );
}
