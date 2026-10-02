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

import { ensureAccessToken } from '../core/auth.js';
import { fileJournal, fileJournalSource } from '../core/audit.js';
import { defaultAccount } from '../core/env.js';
import { googleExchanger } from '../core/google/exchanger.js';
import { GoogleDriveClient } from '../core/google/drive.js';
import { GoogleDocsClient } from '../core/google/docs.js';
import { GoogleSheetsClient } from '../core/google/sheets.js';
import { policyText } from '../core/policy.js';
import { loadRegistry } from '../core/targets.js';
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
 * Токен берётся при каждом обращении, а не один раз при старте: сервер живёт часами,
 * access-токен — минуты, и `ensureAccessToken` сам обновит его по refresh-токену.
 */
const token = (): Promise<string> =>
  ensureAccessToken({ account: ACCOUNT, exchanger: googleExchanger });

/** Настоящие зависимости: Google, реестр и журнал профиля. Собираются на каждый вызов. */
function deps(): ToolDeps {
  return {
    account: ACCOUNT,
    sheets: async () => new GoogleSheetsClient({ accessToken: await token() }),
    docs: async () => new GoogleDocsClient({ accessToken: await token() }),
    drive: async () => new GoogleDriveClient(await token()),
    registry: () => loadRegistry(ACCOUNT),
    journal: fileJournal,
    journalSource: fileJournalSource,
    revision: async (targetId) => {
      const client = new GoogleSheetsClient({ accessToken: await token() });
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
export function createServer(makeDeps: () => ToolDeps = deps): Server {
  const server = new Server(
    { name: 'g-connect', version: '0.1.0' },
    {
      // Правила уходят клиенту вместе с рукопожатием: агент видит их до первого вызова.
      instructions: serverInstructions(),
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
        : await runTool(definition, args, makeDeps());
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
