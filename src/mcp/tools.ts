/**
 * Шесть инструментов MCP (DESIGN.md §3).
 *
 * Определения отделены от транспорта нарочно: так их проверяют тестами без клиента и
 * без сети, а `server.ts` только связывает их с stdio. Зависимости приходят в `deps` —
 * ядро ничего не добывает само (гейт `di-indirection`).
 *
 * Шесть, а не тридцать: «не выставлять 30 мелких инструментов» — требование §3, потому
 * что контекст клиента конечен, а агент, получив тридцать ручек, начинает ошибаться в
 * арифметике индексов вместо того, чтобы описать намерение.
 */

import { z } from 'zod';

import { gcError, isGcError } from '../core/errors.js';
import type { SearchQuery } from '../core/google/drive.js';
import { runOperation } from './run-operation.js';
import { runCreate } from './run-create.js';
import { assertTargetKind, isDocOperation, runDocApply, runDocUndo } from './run-doc-operation.js';
import { limitOf, policyText, policyRules } from '../core/policy.js';
import { DEFAULT_ACCOUNT } from '../core/profiles.js';
import { buildSheetData, buildSheetMap } from '../core/sheets/map.js';
import { readDoc } from './read-doc.js';
import { readValues } from './read-values.js';
import type { ApplyOutcome } from '../core/sheets/rows.js';
import { resolveTarget, type RegistryEntry } from '../core/targets.js';
import { undoLast } from '../core/undo.js';

export type { ToolDeps, ToolDefinition, ToolResult } from './deps.js';
import type { ToolDeps, ToolDefinition, ToolResult } from './deps.js';
import {
  applyHint,
  applyOptions,
  journalOf,
  maybeReport,
  revisionOf,
  writeRight,
} from './apply-support.js';
import { applyInput, operationOf } from './apply-schema.js';
import { parseToolInput } from './boundary.js';
import { gcGrant } from './grant-tool.js';
import { gcTargets, profileIntro } from './targets-tool.js';
import { gcUnlock } from './unlock-tool.js';
import { targetArg } from './target-arg.js';

// `gc_targets` живёт в своём модуле (D-25); прежний адрес импорта — здесь.
export { gcTargets };

/** Общий разбор цели: реестр + ссылка. Здесь же решается, можно ли писать. */
async function resolve(deps: ToolDeps, target: string) {
  return resolveTarget(target, await deps.registry());
}

/**
 * Лист и строка шапки по умолчанию — из реестра, если вызов их не задал. Без этого
 * `gc_targets` обещал агенту «лист по умолчанию: Проекты», а операция уходила на ПЕРВЫЙ
 * лист книги (у владельца это «Инструкция»): нашла живая проба через протокол 2026-09-02.
 * Порядок старшинства: явный аргумент вызова → реестр → эвристика ядра.
 */
const sheetDefaults = (
  entry: RegistryEntry | null,
  sheet: string | undefined,
  headerRow: number | undefined,
): { sheet?: string; headerRow?: number } => {
  const wantedSheet = sheet ?? entry?.sheet;
  const wantedHeaderRow = headerRow ?? entry?.headerRow;
  return {
    ...(wantedSheet === undefined ? {} : { sheet: wantedSheet }),
    ...(wantedHeaderRow === undefined ? {} : { headerRow: wantedHeaderRow }),
  };
};

const readSheet = async (deps: ToolDeps, target: string, sheet?: string, headerRow?: number) => {
  const resolved = await resolve(deps, target);
  const wanted = sheetDefaults(resolved.entry, sheet, headerRow);
  const client = await deps.sheets();
  // Карта — лёгкая: первые MAP_ROWS строк листа, и карта сама говорит, что лист может
  // продолжаться (D-26). Строки целиком читает окно `values`, запись — весь лист.
  const snapshot = await client.getSpreadsheet(
    resolved.id,
    wanted.sheet === undefined ? {} : { sheet: wanted.sheet, maxRows: MAP_ROWS },
  );
  const data = buildSheetData(snapshot, wanted);
  return { resolved, client, data };
};

/** Сколько строк читает карта листа: ей нужны шапка, типы колонок и образцы, не весь лист. */
const MAP_ROWS = 500;

const readInput = {
  target: targetArg,
  mode: z.enum(['map', 'values', 'text']).default('map'),
  sheet: z.string().min(1).optional().describe('Таблица: имя листа; без него берётся первый'),
  headerRow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Таблица: переопределить строку шапки'),
  limit: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe(
      'Сколько строк или абзацев вернуть; строк таблицы — до 5000, по умолчанию все до предела',
    ),
  fromRow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Таблица, mode=values: с какой строки листа читать (номер строки, как в Google)'),
  withFormat: z
    .boolean()
    .default(false)
    .describe('Таблица, mode=values: вид ячеек по строкам (formats), чтобы найти отличающиеся'),
  tab: z.string().min(1).optional().describe('Документ: таб по заголовку; без него — единственный'),
  fromParagraph: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Документ, mode=text: с какого № абзаца читать (номера — из mode=map)'),
};

export const gcRead: ToolDefinition = {
  name: 'gc_read',
  title: 'Прочитать документ или таблицу',
  description:
    'Начинай отсюда. mode=map даёт дешёвую карту и ПРЕДУПРЕЖДЕНИЯ: у таблицы — листы, ' +
    'границы данных, имена колонок с типами и допустимыми значениями; у документа — табы, ' +
    'оглавление с № абзацев и таблицы. mode=values читает строки таблицы окном: до 5000 за ' +
    'вызов, fromRow — с какой строки; truncated: true — строки дальше есть, продолжай с ' +
    'nextFromRow; withFormat: true — вид ячеек по строкам, чтобы найти отличающиеся. ' +
    'mode=text — абзацы документа.',
  input: readInput,
  async handle(args, deps) {
    // Обработчик разбирает вход САМ: схема транспорта не единственная граница —
    // тесты и раннер вызывают инструменты напрямую, и там валидировать больше некому.
    const input = z.object(readInput).parse(args);
    const resolved = await resolve(deps, input.target);
    if (resolved.type === 'doc') return readDoc(deps, resolved.id, input);
    if (input.mode === 'text') {
      throw gcError('bad_request', {
        detail: 'mode=text читает абзацы документа. У таблицы строки читает mode=values.',
      });
    }
    const { client, data } = await readSheet(deps, input.target, input.sheet, input.headerRow);

    if (input.mode === 'values') return readValues(client, resolved.id, data, input);
    return data.map;
  },
};

const searchInput = {
  scope: z.enum(['myDrive', 'sharedWithMe', 'sharedDrives', 'folder']).default('myDrive'),
  folderId: z.string().min(1).optional(),
  nameContains: z.string().min(1).optional(),
  fullText: z.string().min(1).optional(),
  type: z.enum(['sheet', 'doc', 'folder', 'any']).default('any'),
  modifiedAfter: z.string().min(4).optional().describe('ISO-дата: что изменилось после'),
  limit: z.number().int().positive().max(500).default(50),
};

export const gcSearch: ToolDefinition = {
  name: 'gc_search',
  title: 'Найти файлы на Диске',
  description:
    'Поиск по Диску: свои файлы, доступные мне, общие диски, папка. Полнотекстовый поиск ' +
    'работает по содержимому документов и PDF; по ячейкам таблиц на него полагаться нельзя.',
  input: searchInput,
  async handle(args, deps) {
    const input: SearchQuery = z.object(searchInput).parse(args);
    const drive = await deps.drive();
    const { files, incompleteBecause } = await drive.search(input);
    return {
      files,
      found: files.length,
      // Ограничения области печатаются ВСЕГДА, а не только при пустом результате:
      // «ничего не найдено» без причины — тот же молчаливый успех (§13.7 п.4).
      incompleteBecause,
      ...(files.length === 0
        ? {
            note: 'Пусто. Это может быть область поиска, а не отсутствие файлов — см. incompleteBecause.',
          }
        : {}),
    };
  },
};

const scanInput = {
  scope: z.enum(['myDrive', 'sharedWithMe', 'sharedDrives', 'folder']).default('myDrive'),
  folderId: z.string().min(1).optional(),
  nameContains: z.string().min(1).optional(),
  depth: z.enum(['inventory', 'map']).default('inventory'),
  maxFiles: z.number().int().positive().max(200).default(20),
};

export const gcScan: ToolDefinition = {
  name: 'gc_scan',
  title: 'Просканировать корпус',
  description:
    'Воронка: инвентарь по Диску → карта отобранных таблиц. Возвращает свод, а не ' +
    'содержимое: корпус в контекст не влезает. Бюджет по файлам ограничен правилом.',
  input: scanInput,
  async handle(args, deps) {
    const input = z.object(scanInput).parse(args);
    const drive = await deps.drive();
    const { files: inventory, incompleteBecause } = await drive.search({
      scope: input.scope,
      folderId: input.folderId,
      nameContains: input.nameContains,
      type: 'sheet',
      limit: Math.min(input.maxFiles, limitOf('scan.max-files', 500)),
    });

    if (input.depth !== 'map') {
      return {
        depth: 'inventory',
        files: inventory,
        found: inventory.length,
        incompleteBecause,
      };
    }

    const client = await deps.sheets();
    const maps = [];
    for (const file of inventory) {
      try {
        const map = buildSheetMap(await client.getSpreadsheet(file.id));
        maps.push({
          file: { id: file.id, name: file.name, url: file.url },
          sheet: map.sheet,
          headerRow: map.headerRow,
          headerRowConfident: map.headerRowConfident,
          dataRowCount: map.dataRowCount,
          columns: map.columns.map((c) => c.name),
          otherSheets: map.otherSheets.length,
          warnings: map.warnings,
        });
      } catch (error) {
        // Один недоступный файл не должен ронять скан целиком — но и молчать о нём нельзя.
        maps.push({
          file: { id: file.id, name: file.name, url: file.url },
          error: isGcError(error) ? error.payload.title : 'не прочитан',
        });
      }
    }
    return { depth: 'map', found: inventory.length, sheets: maps, incompleteBecause };
  },
};

export const gcApply: ToolDefinition = {
  name: 'gc_apply',
  title: 'Записать в таблицу (по умолчанию — превью)',
  description:
    'Адресация по именам колонок и ключу строки, а не по A1. По умолчанию возвращает ПЛАН ' +
    '(status=preview) и ничего не пишет — покажи план человеку. Запись только с ' +
    'dryRun=false. Неизвестная колонка или значение вне списка допустимых дают ' +
    'status=needs_clarification с вариантами: спроси, не угадывай.',
  input: applyInput,
  // Вход судит ядро (`operationOf`): неизвестная операция, поля НАЗВАННОЙ операции, типы.
  // Общая схема `applyInput` — для `tools/list`, чтобы модель видела поля, а не для суда.
  parseInput: (args) => args,
  async handle(args, deps) {
    const operation = operationOf(args);

    // Право проверяется ДО любого обращения к Google. Порядок не косметика: при
    // обратном порядке запрос на запись в чужой файл сначала лез в сеть, и человек
    // получал «файл не найден» вместо «нет права записи» — нашла живая проба через
    // протокол, юнит-тесты вызывали обработчик и этого не видели.
    const resolved = await resolve(deps, operation.target);
    const right = operation.dryRun === false ? await writeRight(deps, resolved) : undefined;

    // Создание файла идёт до всякого чтения таблицы: у него нет ни листа, ни карты, а
    // цель — папка. Ветка ранняя намеренно — иначе `getSpreadsheet` на папке отказал бы
    // «файл не найден» вместо понятного ответа.
    if (
      operation.op === 'createSheet' ||
      operation.op === 'createDoc' ||
      operation.op === 'createFolder'
    ) {
      return runCreate(operation, resolved, deps, right);
    }

    // Вид цели решает путь ДО чтения (P22): doc-операции идут в Docs API, и табличная
    // операция по документу отклоняется здесь, а не «файл не найден» из чужого API.
    assertTargetKind(operation, resolved);
    if (isDocOperation(operation)) {
      return runDocApply(operation, resolved, deps, right);
    }

    const client = await deps.sheets();
    const wanted = sheetDefaults(resolved.entry, operation.sheet, operation.headerRow);
    const snapshot = await client.getSpreadsheet(
      resolved.id,
      wanted.sheet === undefined ? {} : { sheet: wanted.sheet },
    );
    const data = buildSheetData(snapshot, wanted);

    const options = applyOptions(deps, resolved, operation, right);

    const outcome: ApplyOutcome = await runOperation(client, data, operation, options);

    // Отчёт файлом — по запросу: писать его на каждый вызов значит копить мусор.
    const reportPath = await maybeReport(args['report'] === true, outcome, {
      spreadsheet: data.map.spreadsheetTitle,
      sheet: data.map.sheet,
      alias: resolved.alias,
      revision: data.map.revisionId,
      op: operation.op,
    });

    return {
      ...outcome,
      target: { id: resolved.id, alias: resolved.alias, sheet: data.map.sheet },
      hint: applyHint(outcome),
      ...(reportPath === null ? {} : { reportFile: reportPath }),
    };
  },
};

const undoInput = {
  target: targetArg,
  force: z.boolean().default(false).describe('Откатить, даже если документ правили после'),
  /**
   * Живой прогон 2026-09-04: отказ «назови её id — gc-…» советовал то, чего нельзя было
   * сделать — параметра для id в схеме не существовало. Совет без способа его исполнить
   * хуже отсутствия совета.
   */
  record: z
    .string()
    .min(1)
    .optional()
    .describe('id записи журнала (correlationId) — откатить именно её, а не последнюю'),
};

/**
 * Что сказать человеку после отката. Форма отчёта обязана совпадать с формой правки:
 * живой прогон 2026-09-04 показал, что откат правки ВИДА отчитывался значением ячейки —
 * значением, которого правка не касалась (урок L5).
 */
function undoHint(outcome: Awaited<ReturnType<typeof undoLast>>): string | undefined {
  if (outcome.status === 'nothing_to_undo') {
    return `Откатывать нечего. ${outcome.detail ?? ''}`.trim();
  }
  const values = outcome.restored.filter((r) => r.kind !== 'format').length;
  const formats = outcome.restored.filter((r) => r.kind !== 'value').length;
  const parts = [
    ...(values === 0 ? [] : [`значения в ${values} ячейк(ах)`]),
    ...(formats === 0 ? [] : [`вид ${formats} ячейк(и)`]),
    ...(outcome.structureUndone === undefined ? [] : [outcome.structureUndone.replace(/\.$/, '')]),
    // У отката документа ячеек нет: без этого поля подсказка велела агенту сказать
    // «вернулось — ничего» сразу после удалённой вставки (живой прогон 2026-10-02, LR3-6).
    ...(outcome.docUndone === undefined ? [] : [outcome.docUndone.replace(/\.$/, '')]),
  ];
  const what = parts.length === 0 ? 'ничего: список возвращённого пуст' : parts.join('; ');
  const not =
    outcome.notRestored === undefined || outcome.notRestored.length === 0
      ? ''
      : ` НЕ вернулось: ${outcome.notRestored.join('; ')}.`;
  return `Откат выполнен. Вернулось — ${what}.${not} Скажи человеку именно это, а не «откачено».`;
}

export const gcUndo: ToolDefinition = {
  name: 'gc_undo',
  title: 'Откатить последнюю запись',
  description:
    'Обратная запись по снимку «до» из журнала. Откатывает последнюю ещё не откаченную ' +
    'запись. Если после неё документ правил человек — откат не выполняется, и это ' +
    'сообщается: перечитай документ и реши, что вернуть.',
  input: undoInput,
  async handle(args, deps) {
    const input = z.object(undoInput).parse(args);
    const resolved = await resolve(deps, input.target);
    await writeRight(deps, resolved);
    if (resolved.type === 'doc') {
      const outcome = await runDocUndo(deps, resolved, input);
      return {
        ...outcome,
        target: { id: resolved.id, alias: resolved.alias },
        hint: undoHint(outcome),
      };
    }
    const client = await deps.sheets();
    const outcome = await undoLast(client, resolved.id, deps.journalSource, {
      account: deps.account,
      force: input.force,
      ...(input.record === undefined ? {} : { correlationId: input.record }),
      currentRevision: await revisionOf(deps, resolved),
      readRevision: () => revisionOf(deps, resolved),
      trash: async (fileId: string) => {
        const drive = await deps.drive();
        await drive.trash(fileId);
      },
      ...(deps.project === undefined ? {} : { project: deps.project }),
      journal: journalOf(deps),
    });
    return {
      ...outcome,
      target: { id: resolved.id, alias: resolved.alias },
      // Раньше здесь стояло «журнал по этой цели пуст» — утверждение, неверное в двух
      // из трёх случаев (всё уже откачено; записи с таким id нет). Причину называет ядро.
      hint: undoHint(outcome),
    };
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  gcTargets,
  gcRead,
  gcSearch,
  gcScan,
  gcApply,
  gcUndo,
  gcGrant,
  gcUnlock,
];

/** Ровно восемь — §3 с поправками D-23 и D-24 (право записи и доступ к Google). Тест сверяет. */
export const EXPECTED_TOOL_COUNT = 8;

/**
 * Единый перехват на границе: наружу уходит payload ошибки, а не исключение и не
 * стектрейс. Клиент показывает человеку название проблемы и предлагаемое действие.
 */
export async function runTool(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolResult> {
  try {
    return { ok: true, data: await definition.handle(parseToolInput(definition, args), deps) };
  } catch (error) {
    const gc = isGcError(error)
      ? error
      : gcError('internal', {
          detail: `Инструмент ${definition.name} упал неожиданно.`,
          cause: (error as Error).message,
        });
    return { ok: false, error: gc.payload };
  }
}

/**
 * Справка о правилах для `instructions` сервера: собирается из rules.md, а не копируется.
 * Профиль сервера — первой строкой (D-25): клиент показывает агенту только начало
 * инструкций (~5 тыс. знаков из 23 тыс., замер 2026-10-19).
 */
export function serverInstructions(account: string = DEFAULT_ACCOUNT): string {
  const rules = policyRules();
  return [
    profileIntro(account),
    '',
    policyText(),
    '',
    '---',
    `Машинная часть правил: ${String(rules.length)} шт., исполняется ядром независимо от того,`,
    'прочитаны ли они. Полный список — ресурс policy://rules.',
  ].join('\n');
}
