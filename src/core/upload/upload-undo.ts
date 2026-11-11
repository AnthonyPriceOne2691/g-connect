/**
 * Откат загрузки (D-27, Q47): новый файл — в корзину, замена — прежней ревизией.
 *
 * Сверка — по ревизиям, а не по ячейкам: голова файла должна быть ревизией нашей записи. Сменилась
 * — после нас файл меняли (свежей версией, в интерфейсе, другой сессией), и откат унёс бы чужую
 * работу: отказ с объяснением, а осознанно — с `force`. Одно исключение — своя цепочка откатов:
 * откат более поздней загрузки возвращает наше содержимое НОВОЙ ревизией, голова другая, а
 * содержимое (sha256) — ровно записанное нами; чужой работы в нём нет. Прежняя ревизия замены
 * удержана навсегда ещё при записи, поэтому вернуть её можно и через неделю.
 */

import { unseenByDrive } from '../create-parent.js';
import { gcError } from '../errors.js';
import type { DriveClient, DriveFileInfo } from '../google/drive.js';
import type { UploadDetail, WriteRecord } from '../journal.js';
import type { UndoOptions, UndoOutcome } from '../undo-types.js';

type UndoDrive = Pick<DriveClient, 'fileInfo' | 'trash' | 'restoreRevision'>;

type UndoJournal = (record: WriteRecord, targetId: string, options: UndoOptions) => Promise<void>;

export async function undoUpload(
  record: WriteRecord,
  options: UndoOptions,
  journal: UndoJournal,
  targetId: string,
): Promise<UndoOutcome> {
  const { fileId, upload } = uploadOf(record);
  const drive = await driveOf(options);
  const head = await headOf(drive, fileId, upload);
  const ours = isOurs(head, upload);
  if (!ours && options.force !== true) throw changedAfterWrite(head, upload);
  const undone =
    upload.mode === 'new'
      ? await trashUploaded(drive, fileId, upload)
      : await restorePrevious(drive, fileId, upload);
  await journal(record, targetId, options);
  return {
    status: 'ok',
    restored: [],
    undoneCorrelationId: record.correlationId,
    at: record.at,
    structureUndone: undone,
    ...(ours ? {} : { notRestored: [forcedLoss(head, upload)] }),
  };
}

function uploadOf(record: WriteRecord): { fileId: string; upload: UploadDetail } {
  const fileId = record.structure?.fileId;
  const upload = record.structure?.upload;
  if (fileId !== undefined && upload !== undefined) return { fileId, upload };
  throw gcError('internal', {
    detail: `В записи о загрузке ${record.correlationId} нет id файла или его ревизий — откатывать нечем.`,
  });
}

async function driveOf(options: UndoOptions): Promise<UndoDrive> {
  if (options.drive !== undefined) return options.drive();
  throw gcError('bad_request', {
    detail:
      'Откат загрузки требует доступа к Drive, а этот вызов его не получил. Повтори откат из ' +
      'клиента с полным доступом или верни файл руками в интерфейсе Drive.',
    cause: 'drive_unavailable',
  });
}

/** Голова файла сейчас. Нет файла или доступа — отказ с названием файла, а не голый 404. */
async function headOf(
  drive: UndoDrive,
  fileId: string,
  upload: UploadDetail,
): Promise<DriveFileInfo> {
  try {
    return await drive.fileInfo(fileId);
  } catch (error) {
    throw unseenByDrive(
      error,
      `Файла «${upload.name}» (${fileId}) Drive этого профиля не видит: его удалили насовсем ` +
        'или закрыли доступ. Откатывать нечего — ничего не изменено.',
    );
  }
}

/** Файл всё ещё наш: голова — ревизия нашей записи или содержимое ровно то, что мы записали. */
function isOurs(head: DriveFileInfo, upload: UploadDetail): boolean {
  if (upload.revision !== undefined && head.headRevisionId === upload.revision) return true;
  return head.sha256 !== undefined && head.sha256.toLowerCase() === upload.sha256;
}

/** После нашей записи файл меняли: откат унёс бы чужую работу. */
function changedAfterWrite(head: DriveFileInfo, upload: UploadDetail) {
  const lose =
    upload.mode === 'new'
      ? 'отправил бы в корзину файл вместе с ней'
      : 'вернул бы прежнее содержимое поверх неё';
  return gcError('revision_conflict', {
    detail:
      `Файл «${upload.name}» после нашей записи меняли: сейчас на Диске ревизия ` +
      `${head.headRevisionId ?? '—'} (изменён ${head.modifiedTime ?? '—'}) с другим содержимым, ` +
      `наша — ${upload.revision ?? '—'}. Откат ${lose}, поэтому не выполнен: перечитай и реши, ` +
      'что вернуть. Осознанно — откат с force.',
    cause: 'file_changed_after_write',
  });
}

async function trashUploaded(
  drive: UndoDrive,
  fileId: string,
  upload: UploadDetail,
): Promise<string> {
  await drive.trash(fileId);
  return (
    `Файл «${upload.name}» отправлен в корзину Drive. Достать его оттуда можно только руками, ` +
    'в интерфейсе Drive — насовсем он не удалён.'
  );
}

/** Прежнее содержимое — новой ревизией того же файла: ID и ссылка у команды не меняются. */
async function restorePrevious(
  drive: UndoDrive,
  fileId: string,
  upload: UploadDetail,
): Promise<string> {
  const previous = upload.previousRevision;
  if (previous === undefined) {
    throw gcError('internal', {
      detail: `В записи о замене «${upload.name}» нет прежней ревизии — вернуть нечего.`,
    });
  }
  const restored = await drive.restoreRevision(fileId, previous);
  return (
    `Содержимое «${upload.name}» возвращено к прежнему (ревизия ${previous}) новой ревизией ` +
    `${restored.headRevisionId ?? '—'}: ID и ссылка те же. Заменённое содержимое (ревизия ` +
    `${upload.revision ?? '—'}) осталось в истории версий файла.`
  );
}

/** Что откат с `force` унёс вместе с нашей записью — сказать вслух (урок L5). */
function forcedLoss(head: DriveFileInfo, upload: UploadDetail): string {
  return upload.mode === 'new'
    ? `правки после нашей загрузки (ревизия ${head.headRevisionId ?? '—'}) — файл в корзине вместе с ними`
    : `правки после нашей замены (ревизия ${head.headRevisionId ?? '—'}) — содержимое стало ` +
        'прежним поверх них; они остались в истории версий файла';
}
