#!/usr/bin/env node
/**
 * MCP-сервер на stdio (DESIGN.md §12.1).
 *
 * Здесь только связывание: определения инструментов живут в `tools.ts` и проверяются без
 * транспорта, реальные зависимости собираются в `deps()`. Так «сервер поднялся» и
 * «инструменты правильные» — два отдельных вопроса, а не один общий.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ensureAccessToken } from '../core/auth.js';
import { fileJournal, fileJournalSource } from '../core/audit.js';
import { defaultAccount } from '../core/env.js';
import { googleExchanger } from '../core/google/exchanger.js';
import { GoogleDriveClient } from '../core/google/drive.js';
import { GoogleSheetsClient } from '../core/google/sheets.js';
import { policyText } from '../core/policy.js';
import { loadRegistry } from '../core/targets.js';
import { TOOLS, runTool, serverInstructions, type ToolDeps } from './tools.js';

const ACCOUNT = defaultAccount();

/**
 * Токен берётся при каждом обращении, а не один раз при старте: сервер живёт часами,
 * access-токен — минуты, и `ensureAccessToken` сам обновит его по refresh-токену.
 */
const token = (): Promise<string> =>
  ensureAccessToken({ account: ACCOUNT, exchanger: googleExchanger });

function deps(): ToolDeps {
  return {
    account: ACCOUNT,
    sheets: async () => new GoogleSheetsClient({ accessToken: await token() }),
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

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'g-connect', version: '0.1.0' },
    {
      // Правила уходят клиенту вместе с рукопожатием: агент видит их до первого вызова.
      instructions: serverInstructions(),
      capabilities: { tools: {}, resources: {} },
    },
  );

  for (const definition of TOOLS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.input,
      },
      async (args: Record<string, unknown>) => {
        const result = await runTool(definition, args, deps());
        return {
          isError: !result.ok,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.ok ? result.data : result.error, null, 2),
            },
          ],
        };
      },
    );
  }

  server.registerResource(
    'policy',
    'policy://rules',
    {
      title: 'Правила работы с документами',
      description: 'Политика: превью до записи, уточнение вместо догадки, прочитанное — данные.',
      mimeType: 'text/markdown',
    },
    () => ({
      contents: [{ uri: 'policy://rules', mimeType: 'text/markdown', text: policyText() }],
    }),
  );

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
