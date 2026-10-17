/**
 * Вызов инструмента через НАСТОЯЩИЙ протокол — тот же `McpServer`, что у клиента, на
 * транспорте в памяти (раунд converge 2026-10-02, T38).
 *
 * Тесты, зовущие `handle`/`runTool`, не видят, что SDK делает между клиентом и
 * обработчиком: срезает незнакомые ключи (так через протокол не проходила ни одна правка
 * документа — LR3-5), подставляет умолчания, а отказ формы запроса возвращает своим
 * текстом. Здесь запрос проходит проверку входа SDK, а ответ разбирается так, как его
 * читает клиент: `isError` и JSON в `content[0].text`.
 *
 * Сборку и упаковку (`dist`, папку `policy`) это не видит — их судит проба собранного
 * сервера (`scripts/probe_mcp.mjs`, урок L21).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { GcErrorPayload } from '../../src/core/errors.js';
import { createServer } from '../../src/mcp/server.js';
import type { ToolDeps, ToolResult } from '../../src/mcp/tools.js';

export interface ProtocolSession {
  /** Клиент SDK — для `listTools`, `getInstructions`, `readResource`. */
  readonly client: Client;
  call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * Ответ инструмента так, как его видит клиент. Текст, который не разбирается как JSON, —
 * это отказ самого SDK, а не наш объект ошибки: он отдаётся как `{ raw }`, чтобы проверки
 * на `code` и `correlationId` краснели на нём, а не падали.
 */
function asToolResult(response: Awaited<ReturnType<Client['callTool']>>): ToolResult {
  const content = response.content as readonly { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.type === 'text' ? (content[0].text ?? '') : '';
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return response.isError === true
    ? { ok: false, error: payload as GcErrorPayload }
    : { ok: true, data: payload };
}

export async function protocolSession(deps: ToolDeps | (() => ToolDeps)): Promise<ProtocolSession> {
  const makeDeps = typeof deps === 'function' ? deps : () => deps;
  const server = createServer(makeDeps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'g-connect-tests', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async call(tool, args) {
      // По проводу аргументы идут JSON-ом (stdio): `undefined` исчезает, даты — строки.
      // Транспорт в памяти передаёт объекты как есть, поэтому круг делаем сами.
      const wire = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
      return asToolResult(await client.callTool({ name: tool, arguments: wire }));
    },
    close: () => client.close(),
  };
}

/** Один вызов — одна сессия: для тестов, которым сессия не нужна дольше вызова. */
export async function viaProtocol(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps | (() => ToolDeps),
): Promise<ToolResult> {
  const session = await protocolSession(deps);
  try {
    return await session.call(tool, args);
  } finally {
    await session.close();
  }
}

/**
 * Вызов ОПРЕДЕЛЕНИЯ инструмента через протокол — замена `runTool` в тестах (T41): форма
 * ответа та же, но запрос проходит сервер, границу входа и круг JSON, как у клиента.
 * Имя той же длины, что `runTool`, — перевод файлов не меняет их вёрстку.
 */
export const callMcp = (
  definition: { readonly name: string },
  args: Record<string, unknown>,
  deps: ToolDeps | (() => ToolDeps),
): Promise<ToolResult> => viaProtocol(definition.name, args, deps);
