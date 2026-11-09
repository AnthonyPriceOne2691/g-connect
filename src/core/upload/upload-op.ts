/**
 * Загрузка локального файла на Drive (D-27, Q45–Q48): новый файл в папку, свежая версия
 * одноимённого файла папки или замена содержимого файла по ID.
 *
 * Решение владельца 2026-11-09: «свежие версии положить — старая должна замениться новой, не
 * плодим копии». Одноимённый файл папки получает новую ревизию — ID и ссылка у команды те же — с
 * тем же правом, что создание файла: под разрешением проекта с первой фразы. Несколько одноимённых
 * — вопрос человеку, а не «первый попавшийся». Замена по ID файлом ДРУГОГО имени — разрушающая:
 * фраза человека с именем файла и код плана (D-20).
 *
 * Контур записи — тот же, что у создания файла (`finishWrite`): код плана, подтверждение,
 * однократность, предусловие, журнал. Предусловие перечитывает Drive: у замены голова файла и
 * время изменения те же, что в плане, у нового — одноимённого в папке так и нет; иначе
 * `stale_value`. Прежняя ревизия удерживается навсегда ДО замены — её вернёт откат. Загруженное
 * сверяется по sha256: Drive получил не то, что лежит на диске, — новый файл уходит в корзину,
 * замена возвращает прежнюю ревизию, и ответ — ошибка, а не «готово».
 */

import { gcError } from '../errors.js';
import type { DriveClient, DriveFileInfo, UploadBody } from '../google/drive.js';
import type { UploadDetail } from '../journal.js';
import {
  finishWrite,
  type Prepared,
  type StructuralFacts,
  type WriteContext,
  type WriteShape,
} from '../sheets/commit.js';
import type { SheetsClient } from '../sheets/types.js';
import type { ApplyOutcome, RowOptions, StructuralPlan } from '../sheets/write-types.js';
import type { LocalFile } from './local-file.js';
import { assertReplaceable, checkedUpload, stale } from './upload-checks.js';
import {
  newFileText,
  planDigest,
  replaceText,
  sameContent,
  sameNameQuestion,
  uploadedFile,
  writtenNotes,
  type UploadedFile,
} from './upload-plan.js';

/** Куда загружать: папка (новый файл или свежая версия одноимённого) или файл по ID. */
export type UploadPlace =
  | { readonly kind: 'folder'; readonly parentId: string; readonly parentName: string }
  | { readonly kind: 'file'; readonly fileId: string };

export interface UploadInput {
  /** Файл, уже проверенный `vetLocalFile`: внутри проекта, не скрытый, не секрет. */
  readonly local: LocalFile;
  /** Имя на Диске из запроса; без него — имя локального файла. */
  readonly name?: string;
  readonly place: UploadPlace;
  /** Как ядро поняло цель (вид голого ID — по ответу Drive), — в `assumptions` ответа. */
  readonly assumptions: readonly string[];
}

/** Исход загрузки; по факту записи — ещё и файл на Диске (`file`). */
export type UploadOutcome = ApplyOutcome & { readonly file?: UploadedFile };

/** Что сделает загрузка — по ответу Drive, до плана. */
type Target =
  | { readonly kind: 'new'; readonly parentId: string; readonly parentName: string }
  | { readonly kind: 'replace'; readonly file: DriveFileInfo; readonly targetId: string };

/** Что стало известно при записи: ответ Drive и чем сверено загруженное. */
interface Written {
  info?: DriveFileInfo;
  checked?: string;
}

export async function uploadFile(
  sheets: SheetsClient,
  drive: DriveClient,
  input: UploadInput,
  options: RowOptions = {},
): Promise<UploadOutcome> {
  const name = nameOf(input);
  const target = await targetOf(drive, input, name);
  if ('status' in target) return target;
  const unchanged = target.kind === 'replace' ? beforeReplace(target.file, input, options) : null;
  if (unchanged !== null) return unchanged;
  const structural = structuralOf(target, input.local, name);
  const written: Written = {};
  const outcome = await finishWrite(
    sheets,
    contextOf(target, structural),
    [],
    preparedOf(input),
    contourOptions(options, structural, written),
    'uploadFile',
    shapeOf(drive, target, input.local, name, written, structural),
  );
  return withFile(outcome, target, written);
}

/**
 * Код плана и строка журнала — под целью вызова: папкой (новый файл и свежая версия по имени) или
 * файлом (замена по ID). `gc_undo` по той же цели её и находит, как у создания (Q20). Ревизия «до»
 * — голова заменяемого файла: у нового её нет.
 */
function contextOf(target: Target, structural: StructuralPlan): WriteContext {
  return {
    targetId: target.kind === 'new' ? target.parentId : target.targetId,
    sheet: structural.sheet,
    sheetId: 0,
    revisionId: target.kind === 'replace' ? (target.file.headRevisionId ?? null) : null,
  };
}

const preparedOf = (input: UploadInput): Prepared => ({
  resolved: [],
  assumptions: [...input.assumptions],
  notes: [],
  questions: [],
  touches: [],
});

/** Ответ записи: что легло на Диск — полем `file` и словами в `notes`, а не одним «ok». */
function withFile(outcome: ApplyOutcome, target: Target, written: Written): UploadOutcome {
  if (outcome.status !== 'ok' || written.info === undefined) return outcome;
  const file = uploadedFile(written.info, target.kind === 'replace' ? target.file : undefined);
  return {
    ...outcome,
    notes: [...outcome.notes, ...writtenNotes(file, written.checked ?? '')],
    file,
  };
}

/**
 * Имя на Диске — из запроса или локального файла, в NFC. macOS хранит имя так, как его дала
 * программа, и «й» бывает двумя знаками (NFD): человек видит одно имя, сравнение — разные, и свежая
 * версия легла бы копией.
 */
function nameOf(input: UploadInput): string {
  const name = (input.name ?? input.local.name).trim().normalize('NFC');
  if (name.length > 0) return name;
  throw gcError('bad_request', {
    detail: 'Имя файла на Диске не может быть пустым. Ничего не загружено.',
    cause: 'upload_empty_name',
  });
}

/**
 * Цель по ответу Drive. Файл по ID — его сведения; папка — одноимённые файлы в ней: ни одного —
 * новый файл, один — свежая версия, несколько — вопрос человеку (Q48).
 */
async function targetOf(
  drive: DriveClient,
  input: UploadInput,
  name: string,
): Promise<Target | ApplyOutcome> {
  const { place } = input;
  if (place.kind === 'file') {
    const file = assertReplaceable(await drive.fileInfo(place.fileId), 'id');
    return { kind: 'replace', file, targetId: place.fileId };
  }
  const same = await sameNamed(drive, place.parentId, name);
  const only = same.length === 1 ? same[0] : undefined;
  if (same.length === 0) {
    return { kind: 'new', parentId: place.parentId, parentName: place.parentName };
  }
  if (only === undefined) return sameNameQuestion(same, name, place.parentName, input.assumptions);
  // Голова и размер — у `fileInfo`, как у замены по ID: план и предусловие читают одно и то же.
  const file = assertReplaceable(await drive.fileInfo(only.id), 'folder');
  return { kind: 'replace', file, targetId: place.parentId };
}

/**
 * Одноимённые в папке: имя в NFC и, если отличается, в NFD — файл, положенный на Диск с Mac мимо
 * G connect, мог сохранить разложенную форму. Файл, найденный обеими формами, — один.
 */
async function sameNamed(
  drive: DriveClient,
  parentId: string,
  name: string,
): Promise<DriveFileInfo[]> {
  const forms = [...new Set([name, name.normalize('NFD')])];
  const found = await Promise.all(forms.map((form) => drive.findByName(parentId, form)));
  return [...new Map(found.flat().map((file) => [file.id, file])).values()];
}

/**
 * Замена до плана: та ли голова, что у вызова без превью (`expectRevision`), есть ли что менять и
 * будет ли чем откатить. Без ревизии содержимого прежнее вернуть нечем — правку, которую нечем
 * вернуть, ядро не делает вовсе.
 */
function beforeReplace(
  file: DriveFileInfo,
  input: UploadInput,
  options: RowOptions,
): ApplyOutcome | null {
  if (options.expectRevision !== undefined && options.expectRevision !== file.headRevisionId) {
    throw stale(
      `Ревизия ${options.expectRevision}, на которой строился план, ушла: у «${file.name}» сейчас ` +
        `${file.headRevisionId ?? '—'}. Записи не было — перечитай и построй план заново.`,
      'expect_revision',
    );
  }
  if (file.sha256 !== undefined && file.sha256.toLowerCase() === input.local.sha256.toLowerCase()) {
    return sameContent(file, input.local, input.assumptions);
  }
  if (file.headRevisionId !== undefined) return null;
  throw gcError('bad_request', {
    detail:
      `Drive не назвал ревизию содержимого «${file.name}» — вернуть прежнее содержимое было бы ` +
      'нечем, поэтому замены не будет. Ничего не загружено: загрузи файл новым (без replace, с ' +
      'другим именем) или замени его руками в интерфейсе Drive.',
    cause: 'replace_without_revision',
  });
}

/**
 * План для кода и превью. Замена файлом ДРУГОГО имени — разрушающая (D-20): подтверждается фразой
 * с именем заменяемого файла, свежая версия — правом создания, как новый файл.
 */
function structuralOf(target: Target, local: LocalFile, name: string): StructuralPlan {
  if (target.kind === 'new') {
    return {
      kind: 'uploadFile',
      sheet: name,
      title: name,
      anchor: newFileText(name, local, target.parentName),
      content: planDigest(['new', target.parentId, name, local.sha256, local.size, local.mimeType]),
    };
  }
  const { file } = target;
  const fresh = name === file.name.normalize('NFC');
  return {
    kind: 'uploadFile',
    sheet: file.name,
    title: file.name,
    anchor: replaceText(file, local, fresh),
    content: planDigest([
      'replace',
      file.id,
      local.sha256,
      local.size,
      local.mimeType,
      file.headRevisionId,
      file.modifiedTime,
    ]),
    ...(fresh ? {} : { confirmPhrase: `заменяю файл ${file.name}`, confirmToken: file.name }),
  };
}

/**
 * Опции контура. Право нового файла и свежей версии — право СОЗДАНИЯ в папке (Q48, решение
 * владельца): под разрешением проекта с первой фразы, как `createDoc`. Замену файлом другого
 * имени конверт не разрешает никогда: её подписывает человек названием (`confirmToken`), и до
 * судьи конверта она не доходит. Ревизия после записи — голова файла по ответу Drive.
 */
function contourOptions(
  options: RowOptions,
  structural: StructuralPlan,
  written: Written,
): RowOptions {
  const judge = options.authorize;
  const named = structural.confirmToken !== undefined;
  return {
    ...options,
    ...(judge === undefined || named
      ? {}
      : { authorize: (_op, cells) => judge('createFile', cells) }),
    readRevision: () => Promise.resolve(written.info?.headRevisionId ?? null),
  };
}

const bodyOf = (local: LocalFile): UploadBody => ({
  path: local.path,
  size: local.size,
  mimeType: local.mimeType,
});

/** Чем перепроверить и чем записать — по виду цели. */
function shapeOf(
  drive: DriveClient,
  target: Target,
  local: LocalFile,
  name: string,
  written: Written,
  structural: StructuralPlan,
): WriteShape {
  if (target.kind === 'new') {
    return {
      structural,
      precondition: () => assertStillNew(drive, target, name),
      apply: () => applyNew(drive, target, name, local, written),
    };
  }
  return {
    structural,
    precondition: () => assertSameHead(drive, target.file),
    apply: () => applyReplace(drive, target.file, local, written),
  };
}

/** Пока строился план, одноимённого в папке не появилось: иначе новый файл стал бы копией. */
async function assertStillNew(
  drive: DriveClient,
  target: Extract<Target, { kind: 'new' }>,
  name: string,
): Promise<void> {
  const same = await sameNamed(drive, target.parentId, name);
  if (same.length === 0) return;
  throw stale(
    `Пока строился план, в ${target.parentName} появился файл «${name}»: загрузка новым файлом ` +
      'сделала бы копию. Записи не было — покажи план заново: файл ляжет свежей версией.',
    'upload_name_taken',
  );
}

/** Голова файла и время изменения — те же, что в плане (Q46): иначе запись затёрла бы чужое. */
async function assertSameHead(drive: DriveClient, file: DriveFileInfo): Promise<void> {
  const now = await drive.fileInfo(file.id);
  if (now.headRevisionId === file.headRevisionId && now.modifiedTime === file.modifiedTime) return;
  throw stale(
    `Файл «${file.name}» изменился после превью: ревизия ${file.headRevisionId ?? '—'} → ` +
      `${now.headRevisionId ?? '—'}, изменён ${file.modifiedTime ?? '—'} → ` +
      `${now.modifiedTime ?? '—'}. Запись не выполнена — перечитай и подтверди новый план.`,
    'file_changed_after_preview',
  );
}

async function applyNew(
  drive: DriveClient,
  target: Extract<Target, { kind: 'new' }>,
  name: string,
  local: LocalFile,
  written: Written,
): Promise<StructuralFacts> {
  const uploaded = await drive.upload(target.parentId, name, bodyOf(local));
  written.checked = await checkedUpload(uploaded, local, {
    undo: () => drive.trash(uploaded.id),
    undone: 'Загруженное отправлено в корзину — на Диске его нет',
    stuck: `Загруженное в корзину не ушло: ${uploaded.webViewLink ?? uploaded.id} — удали его руками`,
  });
  written.info = uploaded;
  return { fileId: uploaded.id, upload: detailOf('new', uploaded, local) };
}

/**
 * Замена: прежняя ревизия удерживается навсегда ДО записи — без этого Drive со временем удалил
 * бы её из истории, и откату нечего было бы вернуть.
 */
async function applyReplace(
  drive: DriveClient,
  file: DriveFileInfo,
  local: LocalFile,
  written: Written,
): Promise<StructuralFacts> {
  const previous = file.headRevisionId ?? '';
  await drive.keepRevision(file.id, previous);
  const replaced = await drive.replace(file.id, bodyOf(local));
  written.checked = await checkedUpload(replaced, local, {
    undo: () => drive.restoreRevision(file.id, previous),
    undone: `Прежнее содержимое «${file.name}» возвращено новой ревизией`,
    stuck:
      `Вернуть прежнее содержимое «${file.name}» не удалось: ревизия ${previous} удержана ` +
      'навсегда — верни её в «Управлении версиями» Drive',
  });
  written.info = replaced;
  return {
    fileId: file.id,
    upload: {
      ...detailOf('replace', replaced, local),
      previousRevision: previous,
      ...(file.size === undefined ? {} : { previousSize: file.size }),
      ...(file.modifiedTime === undefined ? {} : { previousModifiedTime: file.modifiedTime }),
    },
  };
}

/** Строка журнала о загруженном: по ответу Drive, а чего он не назвал — по локальному файлу. */
function detailOf(mode: UploadDetail['mode'], info: DriveFileInfo, local: LocalFile): UploadDetail {
  return {
    mode,
    name: info.name,
    size: info.size ?? local.size,
    sha256: (info.sha256 ?? local.sha256).toLowerCase(),
    ...(info.headRevisionId === undefined ? {} : { revision: info.headRevisionId }),
  };
}
