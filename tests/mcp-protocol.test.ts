/**
 * Инструменты через НАСТОЯЩИЙ протокол (раунд converge 2026-10-02, T38): тот же
 * `McpServer`, что у клиента, транспорт в памяти. Здесь видно то, чего не видят тесты,
 * зовущие обработчик напрямую, — проверку входа SDK между клиентом и обработчиком.
 */

import { describe, expect, it } from 'vitest';

import type { Registry } from '../src/core/targets.js';
import type { ToolDeps } from '../src/mcp/tools.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';
import { protocolSession, viaProtocol } from './fixtures/protocol.js';

const registry: Registry = {
  targets: [{ alias: 'forecast', id: 'DOC0000000000000000001', type: 'doc', allow: 'write' }],
};

const deps = (): ToolDeps => ({
  account: 'default',
  sheets: () => Promise.reject(new Error('таблица не нужна')),
  docs: () => Promise.resolve(new FakeDocsClient(forecastDoc())),
  drive: () => Promise.reject(new Error('Drive не нужен')),
  registry: () => Promise.resolve(registry),
  journal: () => Promise.resolve(),
  journalSource: { recent: () => Promise.resolve([]) },
  revision: () => Promise.resolve('rev-1'),
});

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
