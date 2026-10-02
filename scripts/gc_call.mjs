#!/usr/bin/env node
/**
 * Один вызов инструмента G connect СВОИМ процессом сервера из свежего `dist` — для живого
 * прогона чек-листа. Соединение сессии-редактора с MCP поднято при её старте и старше
 * правок: оно проверило бы прошлую версию (см. MEMORY.md, «Соединение MCP старше правок»).
 * Транспорт — тот же, что у `probe_mcp.mjs`: JSON-RPC по stdio.
 *
 *   npm run build
 *   node scripts/gc_call.mjs gc_targets '{}'
 *   node scripts/gc_call.mjs gc_read '{"target":"doc-test","mode":"map"}'
 *   node scripts/gc_call.mjs gc_apply '{"target":"doc-test","op":"appendText","text":"…"}'
 *
 * Журнал — файловый в профиле, поэтому `gc_undo` отдельным вызовом видит записи прошлых.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [tool, rawArgs = '{}'] = process.argv.slice(2);
if (tool === undefined) {
  process.stdout.write("Использование: node scripts/gc_call.mjs <инструмент> '<json-аргументы>'\n");
  process.exit(2);
}
const args = JSON.parse(rawArgs);

const server = spawn('node', [`${ROOT}dist/mcp/server.js`], {
  env: { ...process.env, GCONNECT_ACCOUNT: process.env.GCONNECT_ACCOUNT ?? 'default' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (d) => (stderr += d.toString()));
const pending = new Map();
let buffer = '';
let nextId = 1;
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve !== undefined) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    // Таймер снимается ответом: висящий таймер держал процесс живым до конца минуты, и
    // каждый вызов выглядел 60-секундным — настоящая задержка вызова была не видна.
    const timer = setTimeout(() => reject(new Error(`таймаут на ${method}`)), 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gc-call', version: '0' },
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const startedAt = Date.now();
  const message = await send('tools/call', { name: tool, arguments: args });
  process.stderr.write(`${tool}: ${Date.now() - startedAt} мс\n`);
  const text = message.result?.content?.[0]?.text ?? JSON.stringify(message.error ?? message);
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }
  process.stdout.write(
    `${JSON.stringify({ isError: message.result?.isError === true, result }, null, 2)}\n`,
  );
  // stderr сервера — всегда: там строки о повторах запросов к Google (T44). Раньше он
  // печатался только при отказе, и медленный вызов нечем было объяснить.
  if (stderr !== '') process.stderr.write(stderr);
} catch (error) {
  process.stdout.write(`ОШИБКА: ${error.message}\n${stderr.slice(0, 500)}\n`);
  process.exitCode = 1;
} finally {
  server.kill();
}
