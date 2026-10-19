/**
 * Куда создавать (D-26, Q20–Q22): папка нового файла названа всегда.
 *
 * Без родителя Drive кладёт файл в корень «Моего диска» молча. Так и вышло в вести
 * portfolio-site-38 (19.10): у голого ID папки общего диска вид неизвестен, ядро не нашло в
 * нём папки реестра и создало папку в корне с `status: ok`, а журнал записал её под `root` —
 * откат по ID папки её не находил. Теперь корень — только явной целью (`"root"`, «Мой диск»),
 * вид голого ID называет Drive, а всё, что не папка, — отказ ДО плана и до создания, с тем,
 * чем папку назвать.
 */

import { gcError, isGcError, type GcError } from './errors.js';
import type { DriveClient, DriveFile } from './google/drive.js';
import { MY_DRIVE_ID, type ResolvedTarget, type TargetType } from './targets.js';

/** Папка создания: id для Drive и как назвать её человеку. */
export interface CreateParent {
  readonly parentId: string;
  readonly parentName: string;
  /** Как ядро поняло цель, если её вид назвал Drive, — уходит в `assumptions` ответа. */
  readonly assumptions: readonly string[];
}

/**
 * Вид цели по реестру и ссылке — без Google и без права: отказ «не папка» не должен стоить
 * ни запроса, ни касания. Голый ID проходит дальше — его вид знает только Drive.
 */
export function assertCreateTarget(resolved: ResolvedTarget): void {
  if (resolved.type === 'folder') return;
  if (resolved.type === 'unknown' && resolved.alias === null) return;
  throw resolved.alias === null
    ? notAFolder(resolved.id, kindName(resolved.type), 'по ссылке')
    : notAFolder(`«${resolved.alias}»`, kindName(resolved.type), 'так в реестре');
}

/**
 * Папка, в которой создавать. Drive спрашивается лениво — только о голом ID: у цели реестра и
 * у ссылки вид уже известен, и лишний запрос (а под замком — касание) им ни к чему.
 */
export async function createParentOf(
  resolved: ResolvedTarget,
  drive: () => Promise<Pick<DriveClient, 'fileKind'>>,
): Promise<CreateParent> {
  assertCreateTarget(resolved);
  if (resolved.type === 'folder') {
    const parentName = resolved.id === MY_DRIVE_ID ? 'Мой диск' : (resolved.alias ?? resolved.id);
    return { parentId: resolved.id, parentName, assumptions: [] };
  }
  const file = await askDrive(await drive(), resolved.id);
  if (file.type !== 'folder') {
    // У «прочего» Drive вид называет только `mimeType` — его и говорим человеку.
    const kind = file.type === 'other' ? `файл ${file.mimeType}` : kindName(file.type);
    throw notAFolder(resolved.id, `${kind} «${file.name}»`, 'по ответу Drive');
  }
  return {
    parentId: resolved.id,
    parentName: `папке «${file.name}»`,
    assumptions: [`Цель ${resolved.id} — папка «${file.name}»: вид и имя — по ответу Drive.`],
  };
}

/**
 * Вид голого ID — у Drive. Не нашёл или нет доступа — отказ с той же подсказкой, а не корень:
 * прежде именно эта развилка уводила создание в «Мой диск». Сбой сети, квота, замок — как
 * есть: их лечит повтор или касание, а не другая цель.
 */
async function askDrive(drive: Pick<DriveClient, 'fileKind'>, id: string): Promise<DriveFile> {
  try {
    return await drive.fileKind(id);
  } catch (error) {
    if (!isGcError(error)) throw error;
    const { code, cause } = error.payload;
    if (code !== 'not_found' && code !== 'forbidden') throw error;
    throw gcError(code, {
      detail:
        `Drive этого профиля не видит ${id}: такого ID нет или к нему нет доступа — папку может ` +
        `видеть другой профиль G connect. Ничего не создано, и в корне «Мой диск» тоже. ${folderHint()}`,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** Вид не-папки человеку, именительным: «Цель X — таблица, а не папка». */
function kindName(type: Exclude<TargetType, 'folder'>): string {
  const names: Readonly<Record<typeof type, string>> = {
    sheet: 'таблица',
    doc: 'документ',
    form: 'форма',
    unknown: 'файл неизвестного вида',
  };
  return names[type];
}

function notAFolder(target: string, kind: string, source: string): GcError {
  return gcError('bad_request', {
    detail:
      `Цель ${target} — ${kind}, а не папка (${source}): создавать можно только в папке, ` +
      `ничего не создано. ${folderHint()}`,
    cause: 'create_needs_folder',
  });
}

/** Чем назвать папку — одна подсказка на все отказы создания (Q21): не «исправь», а как. */
function folderHint(): string {
  return (
    'Назови папку: ссылкой на неё (https://drive.google.com/drive/folders/<id папки>), ' +
    'папкой реестра с правом записи или "root" — «Мой диск» под разрешением проекта.'
  );
}
