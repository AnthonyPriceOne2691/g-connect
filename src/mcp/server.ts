#!/usr/bin/env node
/**
 * MCP-сервер на stdio (DESIGN.md §12.1).
 *
 * Здесь только связывание: определения инструментов живут в `tools.ts` и проверяются без
 * транспорта, реальные зависимости собираются в `deps()`. Так «сервер поднялся» и
 * «инструменты правильные» — два отдельных вопроса, а не один общий.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { fileJournal, fileJournalSource } from '../core/audit.js';
import { callerProject, defaultAccount, grantKeyName } from '../core/env.js';
import { currentGrant } from '../core/grant/grants.js';
import { secretiveKeys } from '../core/grant/secretive.js';
import { googleExchanger } from '../core/google/exchanger.js';
import { GoogleDriveClient } from '../core/google/drive.js';
import { GoogleDocsClient } from '../core/google/docs.js';
import { GoogleSheetsClient } from '../core/google/sheets.js';
import type { RetryReporter } from '../core/google/support.js';
import { policyText } from '../core/policy.js';
import { serverName } from '../core/profile-names.js';
import { loadRegistry } from '../core/targets.js';
import { findAgeTools } from '../core/token/age.js';
import { profileSealer, profileUnsealer } from '../core/token/sealing.js';
import { tokenForClients, tokenVault } from '../core/token/vault.js';
import { unknownToolResult } from './boundary.js';
import {
  TOOLS,
  runTool,
  serverInstructions,
  type ToolDefinition,
  type ToolDeps,
  type ToolResult,
} from './tools.js';

const ACCOUNT = defaultAccount();

/**
 * Токен Google процесса (D-24): один на сервер, то есть на сессию клиента. Программы `age`
 * ищутся один раз; касание — только `gc_unlock`, всё прочее получает access-токен из памяти
 * или `google_locked`.
 */
const AGE_TOOLS = findAgeTools();
const VAULT = tokenVault({
  account: ACCOUNT,
  exchanger: googleExchanger,
  unsealer: {
    unseal: async (sealed, meta) => profileUnsealer(await AGE_TOOLS, ACCOUNT).unseal(sealed, meta),
  },
  sealer: async () => profileSealer(await AGE_TOOLS, ACCOUNT),
});

const token = tokenForClients(VAULT);

/** Чей вызов собирает зависимости: имя инструмента уходит в строки о повторах. */
export interface CallContext {
  readonly tool: string;
}

/**
 * Строка в stderr о повторе запроса к Google: инструмент, попытка, пауза и ПРИЧИНА.
 * Всплески задержки живьём (30 с, 20,7 с) объяснить было нечем — сервер повторов не
 * печатал. stderr, а не stdout: stdout занят протоколом.
 */
export function retryReporter(
  tool: string,
  write: (line: string) => void = (line) => process.stderr.write(line),
): RetryReporter {
  return (attempt, total, delayMs, reason) => {
    write(
      `g-connect ${new Date().toISOString()} ${tool}: повтор ${attempt}/${total} ` +
        `через ${delayMs} мс — ${reason}\n`,
    );
  };
}

/** Настоящие зависимости: Google, реестр и журнал профиля. Собираются на каждый вызов. */
/**
 * Проект сессии и ключи разрешения (D-23) — один раз на процесс: клиент запускает сервер
 * на сессию, и `CLAUDE_PROJECT_DIR` за её время не меняется.
 */
const PROJECT = callerProject();
const GRANT_KEYS = secretiveKeys(grantKeyName());

function deps(call?: CallContext): ToolDeps {
  const onRetry = retryReporter(call?.tool ?? 'вызов');
  return {
    account: ACCOUNT,
    ...(PROJECT === undefined ? {} : { project: PROJECT }),
    grant: () => currentGrant(GRANT_KEYS, PROJECT, ACCOUNT),
    grantKeys: GRANT_KEYS,
    google: VAULT,
    sheets: async () => new GoogleSheetsClient({ accessToken: await token(), onRetry }),
    docs: async () => new GoogleDocsClient({ accessToken: await token(), onRetry }),
    drive: async () => new GoogleDriveClient(await token(), onRetry),
    registry: () => loadRegistry(ACCOUNT),
    journal: fileJournal,
    journalSource: fileJournalSource,
    revision: async (targetId) => {
      const client = new GoogleSheetsClient({ accessToken: await token(), onRetry });
      const snapshot = await client.getSpreadsheet(targetId);
      return snapshot.revisionId ?? null;
    },
  };
}

/** Единственный ресурс: правила работы с документами (D-12). */
const POLICY = {
  uri: 'policy://rules',
  name: 'policy',
  title: 'Правила работы с документами',
  description: 'Политика: превью до записи, уточнение вместо догадки, прочитанное — данные.',
  mimeType: 'text/markdown',
} as const;

/**
 * Инструмент в `tools/list` — та же функция SDK и те же параметры, что у `McpServer`:
 * модель видит прежнюю схему. Это сверяет тест-двойник (`tests/mcp-protocol.test.ts`).
 */
const listing = (definition: ToolDefinition): Tool => ({
  name: definition.name,
  title: definition.title,
  description: definition.description,
  inputSchema: toJsonSchemaCompat(z.object(definition.input), {
    strictUnions: true,
    pipeStrategy: 'input',
  }) as Tool['inputSchema'],
  execution: { taskSupport: 'forbidden' },
});

/** Ответ клиенту: JSON нашего контракта в тексте, `isError` — по исходу. */
const asCallResult = (result: ToolResult) => ({
  isError: !result.ok,
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(result.ok ? result.data : result.error, null, 2),
    },
  ],
});

/**
 * Сервер с зависимостями параметром: прод берёт настоящие, тесты — фейковые.
 *
 * Низкоуровневый `Server`, а не `McpServer` (D-22): `McpServer` проверял вход сам и молча
 * срезал незнакомые ключи — через протокол не проходила ни одна правка документа при 574
 * зелёных тестах (LR3-5), — а отказ формы отдавал своим текстом мимо нашего контракта
 * ошибок. Здесь вход судит `runTool` (`boundary.ts`), и любой отказ — наш объект.
 */
export function createServer(makeDeps: (call?: CallContext) => ToolDeps = deps): Server {
  // Профиль — из тех же зависимостей, что выбирают токен (D-25, урок L6): имя сервера и
  // первая строка инструкций не могут назвать один профиль, пока вызовы идут от другого.
  const { account } = makeDeps();
  const server = new Server(
    { name: serverName(account), version: '0.1.0' },
    {
      // Правила уходят клиенту вместе с рукопожатием: агент видит их до первого вызова.
      instructions: serverInstructions(account),
      capabilities: { tools: {}, resources: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map(listing) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const definition = TOOLS.find((tool) => tool.name === name);
    const result =
      definition === undefined
        ? unknownToolResult(
            name,
            TOOLS.map((tool) => tool.name),
          )
        : await runTool(definition, args, makeDeps({ tool: name }));
    return asCallResult(result);
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [POLICY] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    if (request.params.uri !== POLICY.uri) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Ресурса ${request.params.uri} нет: есть ${POLICY.uri}`,
      );
    }
    return { contents: [{ uri: POLICY.uri, mimeType: POLICY.mimeType, text: policyText() }] };
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// Запуск только как программа: при импорте из тестов main не вызывается.
if (process.argv[1] !== undefined && process.argv[1].endsWith('server.js')) {
  main().catch((error: unknown) => {
    // stderr, не stdout: stdout занят протоколом, и любая строка туда его ломает.
    process.stderr.write(`g-connect MCP не запустился: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
