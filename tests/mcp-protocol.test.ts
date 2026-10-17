/**
 * Инструменты через НАСТОЯЩИЙ протокол (раунд converge 2026-10-02, T38, T40): тот же
 * сервер, что у клиента, транспорт в памяти. Здесь видно то, чего не видят тесты, зовущие
 * обработчик напрямую, — границу входа между клиентом и обработчиком (D-22).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import type { Registry } from '../src/core/targets.js';
import { retryReporter } from '../src/mcp/server.js';
import { TOOLS, type ToolDeps } from '../src/mcp/tools.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';
import { protocolSession, viaProtocol } from './fixtures/protocol.js';

const registry: Registry = {
  targets: [
    {
      alias: 'forecast',
      id: 'DOC0000000000000000001',
      type: 'doc',
      allow: 'write',
      // Конверт как у живой цели doc-test: вставка пишется с первой фразы.
      auto: { ops: ['appendText', 'insertText'], maxChars: 1000 },
    },
  ],
};

/** Фейки со следом: что записано в документ и в журнал — видно после вызова. */
function harness() {
  const docs = new FakeDocsClient(forecastDoc());
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.reject(new Error('таблица не нужна')),
    docs: () => Promise.resolve(docs),
    drive: () => Promise.reject(new Error('Drive не нужен')),
    registry: () => Promise.resolve(registry),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('rev-1'),
  };
  return { deps, docs, journalled };
}

const deps = (): ToolDeps => harness().deps;

describe('обвязка: тесты говорят с тем же сервером, что и клиент', () => {
  it('рукопожатие отдаёт шесть инструментов и правила', async () => {
    const session = await protocolSession(deps);
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['gc_apply', 'gc_read', 'gc_scan', 'gc_search', 'gc_targets', 'gc_undo'].sort(),
      );
      expect(session.client.getInstructions() ?? '').toContain('конверт');
    } finally {
      await session.close();
    }
  });

  it('LR3-5: поля doc-операции доходят до обработчика — превью называет текст и таб', async () => {
    // До починки SDK срезал `tab` и `text` молча: ядро отвечало «text: Required» на запрос,
    // где текст был. Тест на обработчике это не видел — схему входа применяет только сервер.
    const result = await viaProtocol(
      'gc_apply',
      { op: 'appendText', target: 'forecast', tab: 'Черновики', text: 'Погода: дождь' },
      deps,
    );
    expect(result.error).toBeUndefined();
    const preview = result.data as { status: string; changes: { tab: string; after: string }[] };
    expect(preview.status).toBe('preview');
    expect(preview.changes[0]).toMatchObject({ tab: 'Черновики', after: 'Погода: дождь' });
  });
});

describe('D-22: модель видит прежнюю схему — сервер сменился, tools/list нет', () => {
  it('tools/list совпадает с тем, что отдавал McpServer по тем же определениям', async () => {
    // Тест-двойник (§6.5): старый способ регистрации против нового, поле в поле.
    const legacy = new McpServer({ name: 'g-connect', version: '0.1.0' });
    for (const definition of TOOLS) {
      legacy.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.input,
        },
        () => ({ content: [] }),
      );
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'legacy', version: '0' });
    await Promise.all([legacy.connect(serverSide), client.connect(clientSide)]);
    const session = await protocolSession(deps);
    try {
      type Listed = { name: string; inputSchema: { additionalProperties?: unknown } }[];
      const before = JSON.parse(JSON.stringify((await client.listTools()).tools)) as Listed;
      const after = JSON.parse(JSON.stringify((await session.client.listTools()).tools)) as Listed;
      // Единственная разница, и она честнее прежнего: пустую схему (`gc_targets`) McpServer
      // строил другой версией zod, без `additionalProperties: false`, — у остальных пяти он
      // был и раньше. Незнакомое поле теперь отклоняется и здесь, и схема это говорит.
      const targets = before.find((tool) => tool.name === 'gc_targets')!;
      expect(targets.inputSchema.additionalProperties).toBeUndefined();
      targets.inputSchema.additionalProperties = false;
      expect(after).toEqual(before);
    } finally {
      await client.close();
      await session.close();
    }
  });
});

describe('D-22: любой отказ на границе — наш объект, а не текст SDK', () => {
  it('операции нет — bad_request со списком допустимых и correlationId', async () => {
    const result = await viaProtocol('gc_apply', { op: 'удалиВсё', target: 'forecast' }, deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'unknown_operation' });
    expect(result.error?.detail).toContain('appendText');
    expect(result.error?.correlationId).toMatch(/^gc-/);
  });

  it('неверный тип поля — путь и correlationId: и у gc_apply, и у прочих инструментов', async () => {
    const apply = await viaProtocol(
      'gc_apply',
      { op: 'insertTable', target: 'forecast', tab: 'Прогноз', rows: 'два', columns: 3 },
      deps,
    );
    expect(apply.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(apply.error?.detail).toContain('rows');
    expect(apply.error?.correlationId).toMatch(/^gc-/);

    const read = await viaProtocol('gc_read', { target: 'forecast', mode: 'кратко' }, deps);
    expect(read.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(read.error?.detail).toContain('допустимы: map, values, text');
  });

  it('инструмента нет — наш отказ со списком, а не «Tool not found»', async () => {
    const result = await viaProtocol('gc_delete_everything', {}, deps);
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'unknown_tool' });
    expect(result.error?.detail).toContain('gc_apply');
  });
});

describe('D-22: опечатка в поле — отказ с подсказкой, и ничего не сделано', () => {
  it('в конверте с dryRun=false опечатка afterHeding не пишет «куда-нибудь»', async () => {
    // Живой прогон 2026-10-02: такая правка ушла бы в конец таба сразу, без плана.
    const { deps: d, docs, journalled } = harness();
    const before = JSON.stringify(await docs.getDocument());
    const result = await viaProtocol(
      'gc_apply',
      {
        op: 'appendText',
        target: 'forecast',
        tab: 'Прогноз',
        afterHeding: 'Составы',
        text: 'Судья: Раморенко',
        dryRun: false,
      },
      d,
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'unknown_field' });
    expect(result.error?.detail).toContain('«afterHeding» (возможно, «afterHeading»)');
    expect(journalled).toHaveLength(0);
    expect(JSON.stringify(await docs.getDocument())).toBe(before);
  });

  it('gc_undo с опечаткой в record не откатывает «последнюю» вместо названной', async () => {
    const { deps: d, docs, journalled } = harness();
    const written = await viaProtocol(
      'gc_apply',
      { op: 'appendText', target: 'forecast', tab: 'Прогноз', text: 'Судья', dryRun: false },
      d,
    );
    expect((written.data as { status: string }).status).toBe('ok');
    const afterWrite = JSON.stringify(await docs.getDocument());

    const undone = await viaProtocol('gc_undo', { target: 'forecast', recrd: 'gc-x' }, d);
    expect(undone.error).toMatchObject({ code: 'bad_request', cause: 'unknown_field' });
    expect(undone.error?.detail).toContain('(возможно, «record»)');
    expect(JSON.stringify(await docs.getDocument())).toBe(afterWrite);
    expect(journalled).toHaveLength(1);
  });

  it('gc_read с опечаткой limt — отказ с подсказкой limit', async () => {
    const result = await viaProtocol('gc_read', { target: 'forecast', limt: 5 }, deps);
    expect(result.error).toMatchObject({ cause: 'unknown_field' });
    expect(result.error?.detail).toContain('(возможно, «limit»)');
  });
});

describe('ресурс правил через протокол', () => {
  it('policy://rules читается; чужой адрес — отказ, а не пустота', async () => {
    const session = await protocolSession(deps);
    try {
      const { resources } = await session.client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(['policy://rules']);
      const read = await session.client.readResource({ uri: 'policy://rules' });
      expect(JSON.stringify(read.contents)).toContain('конверт');
      await expect(session.client.readResource({ uri: 'policy://secrets' })).rejects.toThrow(
        /policy:\/\/rules/,
      );
    } finally {
      await session.close();
    }
  });
});

describe('повторы запросов к Google видны (T44)', () => {
  it('строка в stderr называет инструмент, попытку, паузу и причину', () => {
    const lines: string[] = [];
    retryReporter('gc_read', (line) => lines.push(line))(
      2,
      4,
      1000,
      'google_unavailable: HTTP 503',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /gc_read: повтор 2\/4 через 1000 мс — google_unavailable: HTTP 503\n$/,
    );
  });
});
