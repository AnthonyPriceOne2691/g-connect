/**
 * Резолв цели: alias из реестра, URL или ID (DESIGN.md §3, §11.2).
 *
 * Реестр — ОПЦИОНАЛЬНЫЙ оверлей (D-10): без него ядро работает с любой ссылкой,
 * но право на запись даёт только реестр. Асимметрия сознательная: читать широко,
 * писать узко (D-8).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { gcError } from './errors.ts';
import { denyByRule } from './policy.ts';
import { DEFAULT_ACCOUNT, profileDir } from './profiles.ts';

export type TargetType = 'doc' | 'sheet' | 'folder' | 'form' | 'unknown';
export type Permission = 'read' | 'write';

export interface RegistryEntry {
  readonly alias: string;
  readonly id: string;
  readonly type: TargetType;
  readonly allow?: Permission;
  readonly sheet?: string;
  readonly headerRow?: number;
  readonly columns?: Readonly<Record<string, string>>;
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
  readonly key?: readonly string[];
}

export interface Registry {
  readonly targets: readonly RegistryEntry[];
}

export interface ResolvedTarget {
  readonly id: string;
  readonly type: TargetType;
  readonly allow: Permission;
  readonly alias: string | null;
  readonly entry: RegistryEntry | null;
}

const URL_PATTERNS: readonly { readonly re: RegExp; readonly type: TargetType }[] = [
  { re: /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/, type: 'doc' },
  { re: /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/, type: 'sheet' },
  { re: /docs\.google\.com\/forms\/d\/([A-Za-z0-9_-]+)/, type: 'form' },
  { re: /drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]+)/, type: 'folder' },
  { re: /drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/, type: 'unknown' },
];

/** ID файла Google: 20+ символов из безопасного алфавита, без пробелов и точек. */
const BARE_ID = /^[A-Za-z0-9_-]{20,}$/;

export function parseTargetUrl(ref: string): { id: string; type: TargetType } | null {
  for (const { re, type } of URL_PATTERNS) {
    const match = re.exec(ref);
    if (match?.[1] !== undefined) return { id: match[1], type };
  }
  return null;
}

export async function loadRegistry(account: string = DEFAULT_ACCOUNT): Promise<Registry> {
  const path = join(profileDir(account), 'targets.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const targets = (parsed as { targets?: unknown }).targets;
    if (!Array.isArray(targets)) return { targets: [] };
    return { targets: targets as RegistryEntry[] };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { targets: [] };
    throw gcError('internal', {
      detail: `Реестр целей ${path} не читается: проверь, что это валидный JSON.`,
      cause: (error as Error).message,
    });
  }
}

/**
 * Ссылка/alias/ID → цель. Право по умолчанию `read`: произвольная ссылка из промпта
 * пишущей не становится, даже если очень хочется (§11.2).
 */
export function resolveTarget(ref: string, registry: Registry = { targets: [] }): ResolvedTarget {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw gcError('bad_request', { detail: 'Пустая ссылка на цель.' });
  }

  const byAlias = registry.targets.filter((t) => t.alias === trimmed);
  if (byAlias.length > 1) {
    throw gcError('ambiguous_target', {
      detail: `В реестре несколько целей с алиасом «${trimmed}».`,
    });
  }
  const entry = byAlias[0];
  if (entry !== undefined) {
    return {
      id: entry.id,
      type: entry.type,
      allow: entry.allow ?? 'read',
      alias: entry.alias,
      entry,
    };
  }

  const fromUrl = parseTargetUrl(trimmed);
  const id = fromUrl?.id ?? (BARE_ID.test(trimmed) ? trimmed : null);
  if (id === null) {
    throw gcError('ambiguous_target', {
      detail:
        `«${trimmed}» — не ссылка Google, не ID и не алиас из реестра. ` +
        `Известные алиасы: ${registry.targets.map((t) => t.alias).join(', ') || 'реестр пуст'}.`,
    });
  }

  const known = registry.targets.find((t) => t.id === id);
  return {
    id,
    type: fromUrl?.type ?? known?.type ?? 'unknown',
    allow: known?.allow ?? 'read',
    alias: known?.alias ?? null,
    entry: known ?? null,
  };
}

/** Запись разрешена только целям из реестра с `allow: write` (§11.2, правило write.allowlist). */
export function assertWritable(target: ResolvedTarget): void {
  if (target.allow === 'write') return;
  denyByRule(
    'write.allowlist',
    target.alias === null
      ? `Цель ${target.id} не описана в реестре, поэтому доступна только для чтения. ` +
          'Добавить её с allow: write может человек, не агент.'
      : `Цель «${target.alias}» описана как read-only.`,
  );
}
