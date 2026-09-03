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
import type { SheetData, SheetsClient } from '../core/sheets/types.js';
import { operationJsonSchema, parseOperation } from '../core/ops.js';
import { limitOf, policyText, policyRules } from '../core/policy.js';
import { listProfiles, profileStatus } from '../core/profiles.js';
import { buildSheetData, buildSheetMap } from '../core/sheets/map.js';
import { findReplace } from '../core/sheets/find-replace-op.js';
import { formatCells } from '../core/sheets/format-op.js';
import { appendRow, upsertRow, type ApplyOutcome } from '../core/sheets/rows.js';
import { setCells } from '../core/sheets/set-cells-op.js';
import { assertWritable, resolveTarget, type RegistryEntry } from '../core/targets.js';
import { undoLast } from '../core/undo.js';

export type { ToolDeps, ToolDefinition, ToolResult } from './deps.js';
import type { ToolDeps, ToolDefinition, ToolResult } from './deps.js';
import { applyHint, applyOptions, maybeReport } from './apply-support.js';

const targetArg = z.string().min(1).describe('alias из реестра, ссылка на файл или его ID');

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
  const snapshot = await client.getSpreadsheet(
    resolved.id,
    wanted.sheet === undefined ? {} : { sheet: wanted.sheet },
  );
  const data = buildSheetData(snapshot, wanted);
  return { resolved, client, data };
};

export const gcTargets: ToolDefinition = {
  name: 'gc_targets',
  title: 'Доступные цели',
  description:
    'Что агенту разрешено читать и во что писать: цели из реестра с алиасами и правами, ' +
    'плюс состояние подключённых аккаунтов Google. Секретов не отдаёт.',
  input: {},
  async handle(_args, deps) {
    const registry = await deps.registry();
    const accounts = await Promise.all((await listProfiles()).map((a) => profileStatus(a)));
    return {
      targets: registry.targets.map((t) => ({
        alias: t.alias,
        id: t.id,
        type: t.type,
        allow: t.allow ?? 'read',
        sheet: t.sheet ?? null,
        headerRow: t.headerRow ?? null,
        key: t.key ?? null,
      })),
      accounts: accounts.map((a) => ({
        account: a.account,
        state: a.state,
        scopes: a.scopes.length,
        // `expiresAt` (срок access-токена, час) агенту НЕ отдаём: в живом прогоне B13
        // он был прочитан как «срок входа истёк 1 сентября», и агент посоветовал
        // перелогиниться при refreshAgeDays=0 и пустых warnings. Актуальное про доступ
        // живёт в warnings, срок access-токена человеку показывает `gc status`.
        ...(a.warnings.length > 0 ? { warnings: a.warnings } : {}),
      })),
      note:
        'Произвольная ссылка доступна только для чтения: право записи даёт реестр ' +
        '(правило write.allowlist).',
    };
  },
};

const readInput = {
  target: targetArg,
  mode: z.enum(['map', 'values']).default('map'),
  sheet: z.string().min(1).optional().describe('Имя листа; без него берётся первый'),
  headerRow: z.number().int().positive().optional().describe('Переопределить строку шапки'),
  limit: z.number().int().positive().max(5000).optional().describe('Сколько строк вернуть'),
};

export const gcRead: ToolDefinition = {
  name: 'gc_read',
  title: 'Прочитать документ или таблицу',
  description:
    'Начинай отсюда. mode=map даёт дешёвую карту: листы, границы данных, имена колонок с ' +
    'типами и допустимыми значениями, примеры строк и ПРЕДУПРЕЖДЕНИЯ (шапка выбрана ' +
    'неуверенно, на листе два блока, объединённые ячейки). mode=values читает строки.',
  input: readInput,
  async handle(args, deps) {
    // Обработчик разбирает вход САМ: схема транспорта не единственная граница —
    // тесты и раннер вызывают инструменты напрямую, и там валидировать больше некому.
    const input = z.object(readInput).parse(args);
    const { data } = await readSheet(deps, input.target, input.sheet, input.headerRow);

    if (input.mode === 'values') {
      const limit = Math.min(input.limit ?? 100, limitOf('read.max-rows', 500));
      // Границу данных знает карта, и с 2026-09-03 `data.rows` уже без пустого хвоста:
      // резать по `dataRowCount` здесь было бы той же ловушкой, что в карте — счётчик
      // считает непустые строки где угодно, и таблица «блок, пропуск, блок» потеряла бы
      // хвостовой блок. Ограничиваем только лимитом.
      const withData = data.rows;
      return {
        sheet: data.map.sheet,
        headerRow: data.map.headerRow,
        columns: data.map.columns.map((c) => c.name),
        rows: withData.slice(0, limit),
        truncated: withData.length > limit,
        warnings: data.map.warnings,
      };
    }
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

/** Разводка по операциям. Вынесено: в обработчике это была четвёртая ветка подряд. */
async function runOperation(
  client: SheetsClient,
  data: SheetData,
  operation: ReturnType<typeof parseOperation>,
  options: Parameters<typeof appendRow>[3],
): Promise<ApplyOutcome> {
  if (operation.op === 'appendRow') return appendRow(client, data, operation.values, options);
  if (operation.op === 'upsertRow') {
    return upsertRow(client, data, operation.key, operation.values, options);
  }
  if (operation.op === 'findReplace') {
    return findReplace(
      client,
      data,
      {
        find: operation.find,
        replace: operation.replace,
        ...(operation.columns === undefined ? {} : { columns: operation.columns }),
        matchCase: operation.matchCase,
        matchEntireCell: operation.matchEntireCell,
        searchByRegex: operation.searchByRegex,
      },
      options,
    );
  }
  if (operation.op === 'formatCells') {
    return formatCells(client, data, operation.where, operation.columns, operation.format, {
      ...options,
      includeHeader: operation.includeHeader,
    });
  }
  return setCells(client, data, operation.where, operation.values, options);
}

export const gcApply: ToolDefinition = {
  name: 'gc_apply',
  title: 'Записать в таблицу (по умолчанию — превью)',
  description:
    'Адресация по именам колонок и ключу строки, а не по A1. По умолчанию возвращает ПЛАН ' +
    '(status=preview) и ничего не пишет — покажи план человеку. Запись только с ' +
    'dryRun=false. Неизвестная колонка или значение вне списка допустимых дают ' +
    'status=needs_clarification с вариантами: спроси, не угадывай.',
  input: {
    op: z.enum(['appendRow', 'upsertRow', 'setCells', 'formatCells', 'findReplace']),
    /** Превью файлом: широкую таблицу в терминале не читают (§13.3, ступень 0). */
    report: z.boolean().default(false).describe('Дополнительно записать превью HTML-файлом'),
    target: targetArg,
    sheet: z.string().min(1).optional(),
    headerRow: z.number().int().positive().optional(),
    key: z.record(z.string(), z.unknown()).optional().describe('upsertRow: ключ строки'),
    where: z.record(z.string(), z.unknown()).optional().describe('setCells: условие отбора'),
    values: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Имена колонок → значения (для записи; formatCells их не требует)'),
    columns: z
      .array(z.string().min(1))
      .optional()
      .describe('formatCells: имена колонок, чей вид правим'),
    format: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'formatCells: bold, italic, underline, align (left|center|right), background #RRGGBB',
      ),
    includeHeader: z
      .boolean()
      .optional()
      .describe('formatCells: заодно поправить ячейку заголовка этих колонок'),
    find: z.string().min(1).optional().describe('findReplace: что искать'),
    replace: z.string().optional().describe('findReplace: на что заменить'),
    matchCase: z.boolean().optional().describe('findReplace: учитывать регистр'),
    matchEntireCell: z.boolean().optional().describe('findReplace: совпадение по всей ячейке'),
    searchByRegex: z
      .boolean()
      .optional()
      .describe('findReplace: find — регулярное выражение (битое отклоняется до записи)'),
    dryRun: z.boolean().default(true),
    force: z.boolean().default(false),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe('Код плана из превью — им человек подтверждает ИМЕННО эту правку'),
    expectRevision: z
      .string()
      .min(1)
      .optional()
      .describe('Ревизия для вызовов БЕЗ превью (CLI, раннер): у превью её несёт код плана'),
  },
  async handle(args, deps) {
    const operation = parseOperation(args);

    // Право проверяется ДО любого обращения к Google. Порядок не косметика: при
    // обратном порядке запрос на запись в чужой файл сначала лез в сеть, и человек
    // получал «файл не найден» вместо «нет права записи» — нашла живая проба через
    // протокол, юнит-тесты вызывали обработчик и этого не видели.
    const resolved = await resolve(deps, operation.target);
    if (operation.dryRun === false) assertWritable(resolved);

    const client = await deps.sheets();
    const wanted = sheetDefaults(resolved.entry, operation.sheet, operation.headerRow);
    const snapshot = await client.getSpreadsheet(
      resolved.id,
      wanted.sheet === undefined ? {} : { sheet: wanted.sheet },
    );
    const data = buildSheetData(snapshot, wanted);

    const options = applyOptions(deps, resolved, operation);

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
      hint: applyHint(outcome.status),
      ...(reportPath === null ? {} : { reportFile: reportPath }),
    };
  },
};

const undoInput = {
  target: targetArg,
  force: z.boolean().default(false).describe('Откатить, даже если документ правили после'),
};

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
    assertWritable(resolved);
    const client = await deps.sheets();
    const outcome = await undoLast(client, resolved.id, deps.journalSource, {
      account: deps.account,
      force: input.force,
      currentRevision: await deps.revision(resolved.id),
      journal: deps.journal,
    });
    return {
      ...outcome,
      target: { id: resolved.id, alias: resolved.alias },
      // Раньше здесь стояло «журнал по этой цели пуст» — утверждение, неверное в двух
      // из трёх случаев (всё уже откачено; записи с таким id нет). Причину называет ядро.
      hint:
        outcome.status === 'nothing_to_undo'
          ? `Откатывать нечего. ${outcome.detail ?? ''}`.trim()
          : undefined,
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
];

/** Ровно шесть — это требование §3, а не совпадение. Тест сверяет. */
export const EXPECTED_TOOL_COUNT = 6;

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
    return { ok: true, data: await definition.handle(args, deps) };
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

/** Справка о правилах для `instructions` сервера: собирается из rules.md, а не копируется. */
export function serverInstructions(): string {
  const rules = policyRules();
  return [
    policyText(),
    '',
    '---',
    `Машинная часть правил: ${String(rules.length)} шт., исполняется ядром независимо от того,`,
    'прочитаны ли они. Полный список — ресурс policy://rules.',
    '',
    `Схема операции gc_apply: ${JSON.stringify(operationJsonSchema().required)}.`,
  ].join('\n');
}
