#!/usr/bin/env node
/**
 * Артефакт-оракул: сервер стартует ИЗ `dist/` и говорит по протоколу MCP.
 *
 * Зачем скриптом в репозитории, а не разовым файлом: в фазе 2 эта проба гонялась вручную,
 * и `artifact_oracle` в STATUS стоял `n/a` — объявленный оракул без файла есть снятая
 * проверка с видом усиления (§4.6). Здесь она исполняемая.
 *
 *   node scripts/probe_mcp.mjs           # только протокол: ничего не пишет, Google не нужен
 *   node scripts/probe_mcp.mjs --live    # плюс превью на живой цели (нужен профиль)
 *
 * Живой режим НИЧЕГО не записывает: он берёт превью и проверяет, что код плана есть, а
 * запись без кода отклоняется.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.argv.includes('--live');
const TARGET = process.env.GCONNECT_PROBE_TARGET ?? 'infra-test';

const failures = [];
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  if (!ok) failures.push(name);
};

const server = spawn('node', [join(ROOT, 'dist/mcp/server.js')], {
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
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`таймаут на ${method}`)), 30_000);
  });

const callTool = async (name, args) => {
  const message = await send('tools/call', { name, arguments: args });
  const text = message.result?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0' },
  });
  check('initialize отвечает', init.result?.serverInfo?.name === 'g-connect', init.result?.serverInfo?.version);
  check('instructions непустые', (init.result?.instructions ?? '').length > 1000);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const tools = await send('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check('инструментов ровно шесть', names.length === 6, names.join(', '));

  const applySchema = (tools.result?.tools ?? []).find((t) => t.name === 'gc_apply')?.inputSchema;
  check('gc_apply объявляет confirm', applySchema?.properties?.confirm !== undefined);

  const resources = await send('resources/list', {});
  const uris = (resources.result?.resources ?? []).map((r) => r.uri);
  check('ресурс policy://rules отдаётся', uris.includes('policy://rules'));

  if (LIVE) {
    const map = await callTool('gc_read', { target: TARGET, mode: 'map' });
    check('gc_read map читает лист', typeof map.sheet === 'string', `лист ${map.sheet}, шапка ${map.headerRow}`);

    // Ключевую колонку берём из РЕЕСТРА, а не из первой колонки листа: на живой таблице
    // первая колонка — не ключ, и проба падала на needs_clarification вместо проверки.
    const targets = await callTool('gc_targets', {});
    const entry = (targets.targets ?? []).find((x) => x.alias === TARGET);
    const key = entry?.key?.[0] ?? map.columns?.[0]?.name;
    check('реестр объявляет ключ строки', typeof key === 'string', String(key));
    const preview = await callTool('gc_apply', {
      op: 'upsertRow',
      target: TARGET,
      key: { [key]: 'G connect' },
      values: { Статус: 'Запущено' },
    });
    check(
      'превью отдаёт код плана из шести символов',
      /^[0-9a-f]{6}$/.test(preview.planId ?? ''),
      `status=${preview.status}, planId=${preview.planId}`,
    );
    check('превью ничего не записало', preview.status === 'preview' || preview.status === 'no_change');

    const noConfirm = await callTool('gc_apply', {
      op: 'upsertRow',
      target: TARGET,
      key: { [key]: 'G connect' },
      values: { Статус: 'Запущено' },
      dryRun: false,
    });
    check(
      'запись без кода плана отклонена',
      noConfirm.code === 'confirm_required' || noConfirm.raw?.includes('confirm_required'),
      noConfirm.code ?? noConfirm.status ?? '',
    );
  }
} catch (error) {
  check(`проба упала: ${error.message}`, false, stderr.slice(0, 300));
} finally {
  server.kill();
}

if (failures.length > 0) {
  process.stdout.write(`probe_mcp: красные проверки — ${failures.join('; ')}\n`);
  process.exit(1);
}
process.stdout.write(`probe_mcp: всё зелёное${LIVE ? ' (живой режим)' : ' (протокол)'}\n`);
