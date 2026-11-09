/**
 * Тексты загрузки (D-27, Q45–Q48): план человеку, вопрос о нескольких одноимённых файлах, ответ
 * «уже такое» и то, что легло на Диск. Отдельным модулем от контура записи (`upload-op.ts`):
 * здесь — что сказать, там — что сделать.
 */

import { createHash } from 'node:crypto';

import type { DriveFileInfo } from '../google/drive.js';
import type { ApplyOutcome } from '../sheets/write-types.js';
import type { LocalFile } from './local-file.js';

/** Что легло на Диск — человеку в ответе записи: id, ссылка, размер, время, sha256 (Q45). */
export interface UploadedFile {
  readonly id: string;
  readonly name: string;
  /** `webViewLink` Drive — та ссылка, что у команды. */
  readonly link: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly sha256: string | null;
  readonly revision: string | null;
  /** Замена: каким файл был до неё. */
  readonly previous?: {
    readonly size: number | null;
    readonly modifiedTime: string | null;
    readonly revision: string | null;
  };
}

/** Размер человеку: «52,3 МБ», «20,5 КБ», «812 Б» — двоичные единицы, как у Drive. */
export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'размер неизвестен';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[unit] ?? 'ГБ'}`;
}

/** sha256 человеку: первые и последние восемь знаков — сверить глазами хватает. */
export const shortSha = (sha: string): string => `${sha.slice(0, 8)}…${sha.slice(-8)}`;

/** Ссылка на файл: та, что назвал Drive, а без неё — обычная ссылка просмотра по ID. */
export const linkOf = (file: Pick<DriveFileInfo, 'id' | 'webViewLink'>): string =>
  file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`;

const contentText = (local: LocalFile): string =>
  `${sizeText(local.size)}, sha256 ${shortSha(local.sha256)}, ${local.mimeType}`;

/** План нового файла: что, сколько, чем сверить и куда. */
export function newFileText(name: string, local: LocalFile, parentName: string): string {
  return `новый файл «${name}» (${contentText(local)}) в ${parentName}`;
}

/**
 * План замены — было → станет. Свежая версия (имя то же) и замена файлом другого имени звучат
 * по-разному: вторая разрушающая, и человек должен видеть, ЧЕМ заменяется его файл.
 */
export function replaceText(file: DriveFileInfo, local: LocalFile, fresh: boolean): string {
  const head = fresh
    ? `свежая версия «${file.name}» на место прежней`
    : `замена содержимого «${file.name}» файлом «${local.name}»`;
  const kept = fresh ? 'ID и ссылка те же' : `ID, ссылка и имя «${file.name}» на Диске те же`;
  return (
    `${head}: было ${sizeText(file.size)}, изменён ${file.modifiedTime ?? '—'}; ` +
    `станет ${contentText(local)}; ${kept}; прежняя ревизия сохранится для отката`
  );
}

/**
 * Сверка плана для кода (D-16): подтверждая код, человек подтверждает ЭТО содержимое и ЭТУ голову
 * файла — сменилась голова, и прежний код уже не подходит.
 */
export const planDigest = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

const candidateText = (file: DriveFileInfo): string =>
  `${file.id} — ${linkOf(file)}, ${sizeText(file.size)}, изменён ${file.modifiedTime ?? '—'}`;

/**
 * Несколько одноимённых файлов в папке — вопрос, а не «заменю первый» (Q48): какой из них у
 * команды по ссылке, знает человек. Записи нет; выбранный заменяется по ID с `replace: true`.
 */
export function sameNameQuestion(
  files: readonly DriveFileInfo[],
  name: string,
  parentName: string,
  assumptions: readonly string[],
): ApplyOutcome {
  const candidates = files.map(candidateText);
  return {
    status: 'needs_clarification',
    changes: [],
    assumptions: [...assumptions],
    notes: [],
    questions: [
      {
        field: 'target',
        reason: 'ambiguous',
        detail:
          `В ${parentName} несколько файлов с именем «${name}» (${files.length}): какой из них ` +
          'заменить свежей версией, решает человек. Записи не было. Выбранный — тем же вызовом с ' +
          'replace: true и его ID в target.',
        candidates,
        available: candidates,
      },
    ],
    baseRevision: null,
    revisionAfter: null,
    planId: null,
  };
}

/** Содержимое на Диске уже такое — `no_change` с причиной, а не «готово» (§13.7). */
export function sameContent(
  file: DriveFileInfo,
  local: LocalFile,
  assumptions: readonly string[],
): ApplyOutcome {
  return {
    status: 'no_change',
    changes: [],
    assumptions: [...assumptions],
    notes: [
      `Содержимое «${file.name}» на Диске уже такое: sha256 ${shortSha(local.sha256)} совпал с ` +
        `локальным «${local.name}». Записи не было и строки журнала тоже — это не выполненная правка.`,
    ],
    questions: [],
    baseRevision: file.headRevisionId ?? null,
    revisionAfter: null,
    planId: null,
  };
}

/** Файл ответа записи: что легло, а у замены — и каким файл был до неё. */
export function uploadedFile(info: DriveFileInfo, before?: DriveFileInfo): UploadedFile {
  return {
    id: info.id,
    name: info.name,
    link: linkOf(info),
    size: info.size ?? null,
    modifiedTime: info.modifiedTime ?? null,
    sha256: info.sha256 ?? null,
    revision: info.headRevisionId ?? null,
    ...(before === undefined
      ? {}
      : {
          previous: {
            size: before.size ?? null,
            modifiedTime: before.modifiedTime ?? null,
            revision: before.headRevisionId ?? null,
          },
        }),
  };
}

/** Что сказать человеку после записи: что легло, ссылка, чем сверено и чем откатить. */
export function writtenNotes(file: UploadedFile, checked: string): string[] {
  const previous = file.previous;
  if (previous === undefined) {
    return [
      `Загружено: «${file.name}» (${sizeText(file.size)}), ссылка: ${file.link}. Id: ${file.id}.`,
      checked,
      'Откат отправит файл в корзину Drive; достать оттуда — руками, в интерфейсе Drive.',
    ];
  }
  return [
    `Заменено содержимое «${file.name}»: было ${sizeText(previous.size)} (изменён ` +
      `${previous.modifiedTime ?? '—'}), стало ${sizeText(file.size)} (изменён ` +
      `${file.modifiedTime ?? '—'}). ID и ссылка те же: ${file.link}.`,
    checked,
    `Прежняя ревизия ${previous.revision ?? '—'} удержана навсегда: откат вернёт её содержимое ` +
      'новой ревизией, если после нас файл не меняли.',
  ];
}
