/**
 * Подпись окна Touch ID (27.11, D-24): окно называет G connect и профиль, а не `age-plugin-se`.
 *
 * macOS пишет в окне имя файла программы, которая просит палец, — целиком, с пробелами и
 * скобками; ссылка и подмена `argv[0]` его не меняют, нужна копия (проверка владельца 27.11,
 * `age-plugin-se` 0.2.1). `age` ищет плагин по имени в `PATH`, поэтому в папке профиля двое:
 * копия плагина под именем окна и прокладка `age-plugin-se` — при расшифровке она запускает
 * копию, всё остальное отдаёт настоящему плагину. Пути вписаны в прокладку при записи, из
 * окружения она ничего не берёт; программы по-прежнему приходят только из Homebrew (`age.ts`).
 *
 * Подпись не мешает открыть Google: сбой подготовки — окно по-старому, расшифровка идёт, а отказ
 * без касания называет причину (`unlock_declined` в `age.ts`).
 */

import { randomBytes } from 'node:crypto';
import {
  chmod,
  constants,
  copyFile,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { profileLabel } from '../profile-names.js';
import { profileDir } from '../profiles.js';

/** Где лежит папка подписи и как называется окно. */
export interface FingerWindow {
  readonly dir: string;
  readonly label: string;
}

/** Папка — первой в `PATH` расшифровки, или причина, по которой окно будет без подписи. */
export type FingerReady = { readonly dir: string } | { readonly failed: string };

const PLUGIN = 'age-plugin-se';
const PRIVATE = 0o700;

/** Окно профиля — словами строки перед ним (`profileLabel`, урок L30); папка — рядом с ключом. */
export function fingerWindow(account: string): FingerWindow {
  return { dir: join(profileDir(account), 'finger'), label: profileLabel(account) };
}

/** Имя файла из подписи: косая черта и управляющие знаки сделали бы из имени путь или мусор. */
export function fingerFileName(label: string): string {
  return [...label]
    .filter((char) => char !== '/' && char >= ' ')
    .join('')
    .trim();
}

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Прокладка: копия — только при расшифровке (`identity-v1`) и только если она на месте. */
export function shimText(copy: string, plugin: string): string {
  const own = quoted(copy);
  return [
    '#!/bin/sh',
    '# G connect: окно Touch ID при расшифровке называется по профилю (D-24, finger-window.ts).',
    `if [ "$1" = --age-plugin=identity-v1 ] && [ -x ${own} ]; then exec ${own} "$@"; fi`,
    `exec ${quoted(plugin)} "$@"`,
    '',
  ].join('\n');
}

/** Через временное имя: соседний сервер того же профиля видит прежний файл или новый, не половину. */
async function place(target: string, write: (draft: string) => Promise<void>): Promise<void> {
  const draft = join(dirname(target), `.part-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await write(draft);
    await chmod(draft, PRIVATE);
    await rename(draft, target);
  } finally {
    await rm(draft, { force: true });
  }
}

/** Почему папку не подготовить, ещё ничего не тронув, — или `undefined`, если можно. */
function unfit(window: FingerWindow, name: string): string | undefined {
  if (name === '' || name.startsWith('.') || name === PLUGIN) {
    return `подпись «${window.label}» не годится в имя файла`;
  }
  if (window.dir.includes(':'))
    return `в пути папки подписи «:» — PATH его разрежет (${window.dir})`;
  return undefined;
}

/**
 * Подготовить папку перед расшифровкой. Копия и прокладка пишутся каждый раз заново: клон APFS
 * мгновенный, свежая копия не отстаёт от `brew upgrade` и не хранит чужой правки.
 */
export async function prepareFinger(plugin: string, window: FingerWindow): Promise<FingerReady> {
  const name = fingerFileName(window.label);
  const reason = unfit(window, name);
  if (reason !== undefined) return { failed: reason };
  try {
    await mkdir(window.dir, { recursive: true, mode: PRIVATE });
    await chmod(window.dir, PRIVATE);
    // Ссылку Homebrew на Cellar копируем её целью: клон ссылки остался бы ссылкой, и окно
    // назвалось бы по цели.
    const source = await realpath(plugin);
    const copy = join(window.dir, name);
    await place(copy, (draft) => copyFile(source, draft, constants.COPYFILE_FICLONE));
    await place(join(window.dir, PLUGIN), (draft) => writeFile(draft, shimText(copy, plugin)));
    return { dir: window.dir };
  } catch (error) {
    return { failed: `папка подписи не подготовлена: ${(error as Error).message}` };
  }
}
