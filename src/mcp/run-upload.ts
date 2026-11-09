/**
 * Загрузка локального файла на Drive на фасаде (D-27, Q45–Q48) — разводка рядом с созданием:
 * цель — папка или сам файл, а не таблица, и до чтения таблицы она не доходит.
 *
 * Порядок несущий и закреплён тестами. Вид цели по реестру и ссылке — первым: «не папка» и «файл
 * Google» не стоят ни запроса, ни касания. Каталог проекта — до права и файла: файлы берутся
 * только из него (решение владельца 2026-11-09). Право — до любого обращения к Google и до чтения
 * файла: sha256 ролика в 65 МБ не считается ради отказа `needs_grant`. Файл проверяет
 * `vetLocalFile` из зависимостей — в сервере настоящий, в тестах двойник.
 */

import { assertCreateTarget, createParentOf } from '../core/create-parent.js';
import { gcError } from '../core/errors.js';
import type { parseOperation } from '../core/ops.js';
import { denyByRule } from '../core/policy.js';
import type { ResolvedTarget } from '../core/targets.js';
import type { LocalFile } from '../core/upload/local-file.js';
import { uploadFile, type UploadPlace } from '../core/upload/upload-op.js';
import { applyHint, applyOptions, writeRight } from './apply-support.js';
import type { ToolDeps } from './deps.js';

type UploadOperation = Extract<ReturnType<typeof parseOperation>, { op: 'uploadFile' }>;

export async function runUpload(
  operation: UploadOperation,
  resolved: ResolvedTarget,
  deps: ToolDeps,
): Promise<unknown> {
  assertUploadTarget(resolved, operation.replace);
  const project = projectOf(deps);
  const right = operation.dryRun === false ? await writeRight(deps, resolved) : undefined;
  const local = await vetOf(deps)(project, operation.localPath);
  const { place, assumptions, target } = await placeOf(operation, resolved, deps);
  const outcome = await uploadFile(
    await deps.sheets(),
    await deps.drive(),
    {
      local,
      ...(operation.name === undefined ? {} : { name: operation.name }),
      place,
      assumptions,
    },
    applyOptions(deps, target, operation, right),
  );
  return {
    ...outcome,
    target: { id: resolved.id, alias: resolved.alias },
    hint: applyHint(outcome),
  };
}

/**
 * Вид цели без Google и без права. В папку — как у создания (Q21, Q22). Замена — только файла:
 * у папки содержимого нет, а содержимое таблицы и документа Google правят операциями.
 */
function assertUploadTarget(resolved: ResolvedTarget, replace: boolean): void {
  if (!replace) {
    assertCreateTarget(resolved);
    return;
  }
  if (resolved.type === 'unknown') return;
  const name = resolved.alias === null ? resolved.id : `«${resolved.alias}»`;
  const kinds = { folder: 'папка', sheet: 'таблица', doc: 'документ', form: 'форма' } as const;
  const why =
    resolved.type === 'folder'
      ? 'у папки содержимого нет. В папку загружают без replace: одноимённый файл в ней получит ' +
        'свежую версию'
      : 'содержимое файла Google заменяется правками, а не загрузкой';
  throw gcError('bad_request', {
    detail: `Цель ${name} — ${kinds[resolved.type]}: ${why}. Ничего не загружено.`,
    cause: 'upload_not_a_file',
  });
}

/** Каталог проекта сессии: файлы для Диска берутся только из него — и без него ниоткуда. */
function projectOf(deps: ToolDeps): string {
  if (deps.project !== undefined) return deps.project;
  return denyByRule(
    'upload.project-files-only',
    'Загрузка берёт файлы только из каталога проекта сессии (CLAUDE_PROJECT_DIR), а клиент его ' +
      'не назвал. Ничего не загружено: загрузка идёт из сессии Claude Code, открытой в проекте.',
  );
}

function vetOf(deps: ToolDeps): (projectDir: string, localPath: string) => Promise<LocalFile> {
  if (deps.vetLocalFile !== undefined) return deps.vetLocalFile;
  throw gcError('internal', {
    detail: 'Проверка локального файла не подключена к этому вызову — загрузка недоступна.',
  });
}

/**
 * Куда загружать. Папку называет `createParentOf`: вид голого ID — у Drive, корень — только явно.
 * Дальше по вызову цель — папка: ревизию таблицы у неё не спрашивают (живой прогон 2026-10-17).
 */
async function placeOf(
  operation: UploadOperation,
  resolved: ResolvedTarget,
  deps: ToolDeps,
): Promise<{ place: UploadPlace; assumptions: readonly string[]; target: ResolvedTarget }> {
  if (operation.replace) {
    return { place: { kind: 'file', fileId: resolved.id }, assumptions: [], target: resolved };
  }
  const parent = await createParentOf(resolved, () => deps.drive());
  return {
    place: { kind: 'folder', parentId: parent.parentId, parentName: parent.parentName },
    assumptions: parent.assumptions,
    target: { ...resolved, type: 'folder' },
  };
}
