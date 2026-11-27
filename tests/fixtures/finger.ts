/**
 * Заглушки `age` и плагина для подписи окна Touch ID (D-24, 27.11). `age`-заглушка ищет плагин по
 * `PATH`, как настоящий, и печатает свой `PATH` первой строкой; плагин-заглушка печатает метку
 * версии, имя своего файла — им macOS называет окно — и аргументы:
 * «v1|G connect (work)|--age-plugin=identity-v1».
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Так `age` зовёт плагин при расшифровке. */
export const IDENTITY_CALL = '--age-plugin=identity-v1';

/** Плагин-заглушка: `метка|имя файла|аргументы`. */
export const pluginScript = (mark: string): string =>
  `#!/bin/sh\nprintf '%s|%s|%s' '${mark}' "\${0##*/}" "$*"\n`;

const AGE_SCRIPT = `#!/bin/sh\nprintf '%s\\n' "$PATH"\nexec age-plugin-se ${IDENTITY_CALL}\n`;

export async function writeProgram(file: string, text: string): Promise<void> {
  await writeFile(file, text);
  await chmod(file, 0o755);
}

/** Каталог программ с заглушками `age` и плагина — как `/opt/homebrew/bin`. */
export async function stubPrograms(root: string): Promise<string> {
  const bin = join(root, 'brew');
  await mkdir(bin, { recursive: true });
  await writeProgram(join(bin, 'age'), AGE_SCRIPT);
  await writeProgram(join(bin, 'age-plugin-se'), pluginScript('v1'));
  return bin;
}

/** Что напечатала `age`-заглушка: `PATH` ребёнка и строку плагина. */
export function agePrinted(stdout: string): { readonly path: string; readonly plugin: string } {
  const [path = '', plugin = ''] = stdout.split('\n');
  return { path, plugin };
}

/** Метаданные токена для расшифровки профилем: получатель — `r`. */
export const STUB_META = { obtained_at: 0, recipient: 'r', sealed_at: 0 } as const;
