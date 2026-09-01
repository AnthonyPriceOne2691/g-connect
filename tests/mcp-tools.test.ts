/** Примеры B1, B2, B5, B6, B7, B8 спеки фазы 2: набор инструментов и граница ошибок. */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { noopJournal } from '../src/core/journal.js';
import type { Registry } from '../src/core/targets.js';
import {
  EXPECTED_TOOL_COUNT,
  TOOLS,
  gcApply,
  gcRead,
  gcTargets,
  gcUndo,
  runTool,
  serverInstructions,
  type ToolDeps,
} from '../src/mcp/tools.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

const registry: Registry = {
  targets: [
    { alias: 'log', id: SHEET_ID, type: 'sheet', allow: 'write', sheet: 'Лист1', key: ['Проект'] },
    { alias: 'reference', id: 'DOCID000000000000000000', type: 'doc' },
  ],
};

const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  process.env['GCONNECT_HOME'] = await mkdtemp(join(tmpdir(), 'gconnect-mcp-'));
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

interface Harness {
  readonly deps: ToolDeps;
  readonly client: FakeSheetsClient;
  readonly journalled: WriteRecord[];
}

const harness = (over: Partial<ToolDeps> = {}): Harness => {
  const client = new FakeSheetsClient(snapshot());
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    drive: () => Promise.resolve({ search: () => Promise.resolve([]) }),
    registry: () => Promise.resolve(registry),
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('rev-1'),
    ...over,
  };
  return { deps, client, journalled };
};

describe('B1 — набор инструментов', () => {
  it('ровно шесть, и это требование §3, а не совпадение', () => {
    expect(TOOLS).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(TOOLS.map((t) => t.name)).toEqual([
      'gc_targets',
      'gc_read',
      'gc_search',
      'gc_scan',
      'gc_apply',
      'gc_undo',
    ]);
  });

  it('у каждого есть внятное описание и схема входа', () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).toMatch(/^gc_[a-z]+$/);
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      // Описание — то, по чему агент выбирает инструмент: короткое бесполезно.
      expect(tool.description.length, tool.name).toBeGreaterThan(60);
      expect(typeof tool.input, tool.name).toBe('object');
    }
  });

  it('описание gc_apply предупреждает про план вместо записи и про вопрос вместо догадки', () => {
    // Ищем смысл, а не конкретное слово: агенту важно, что по умолчанию возвращается
    // план со `status=preview`, а не что мы назвали это «превью».
    expect(gcApply.description).toMatch(/ПЛАН|preview/);
    expect(gcApply.description).toContain('dryRun=false');
    expect(gcApply.description.toLowerCase()).toContain('не угадывай');
    expect(gcRead.description).toContain('ПРЕДУПРЕЖДЕНИЯ');
  });
});

describe('B2 — gc_targets отдаёт права, но не секреты', () => {
  it('цели с правами и пометка про allowlist', async () => {
    const { deps } = harness();
    const result = await runTool(gcTargets, {}, deps);
    expect(result.ok).toBe(true);
    const data = result.data as { targets: { alias: string; allow: string }[]; note: string };
    expect(data.targets).toHaveLength(2);
    expect(data.targets.find((t) => t.alias === 'log')?.allow).toBe('write');
    expect(data.targets.find((t) => t.alias === 'reference')?.allow).toBe('read');
    expect(data.note).toContain('write.allowlist');
  });

  it('в ответе нет ни токенов, ни путей к профилю', async () => {
    const { deps } = harness();
    const json = JSON.stringify((await runTool(gcTargets, {}, deps)).data);
    expect(json).not.toContain('access_token');
    expect(json).not.toContain('refresh_token');
    expect(json).not.toContain('.gconnect');
  });
});

describe('B4, B5 — превью по умолчанию и вопрос вместо догадки', () => {
  it('gc_apply без dryRun возвращает preview и ничего не пишет', async () => {
    const { deps, client, journalled } = harness();
    const result = await runTool(
      gcApply,
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 5 } },
      deps,
    );
    const data = result.data as { status: string; hint?: string };
    expect(data.status).toBe('preview');
    expect(data.hint).toContain('Покажи его человеку');
    expect(client.writes).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });

  it('неизвестная колонка → needs_clarification со списком и подсказкой спросить', async () => {
    const { deps } = harness();
    const result = await runTool(
      gcApply,
      { op: 'setCells', target: 'log', where: { Проект: 'G connect' }, values: { Бюджет: 100 } },
      deps,
    );
    const data = result.data as {
      status: string;
      questions: { available: string[] }[];
      hint?: string;
    };
    expect(data.status).toBe('needs_clarification');
    expect(data.questions[0]?.available).toContain('Часы');
    expect(data.hint).toContain('Не угадывай');
  });

  it('с dryRun=false пишет и журналирует', async () => {
    const { deps, client, journalled } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'log',
        key: { Проект: 'G connect' },
        values: { Часы: 5 },
        dryRun: false,
      },
      deps,
    );
    expect((result.data as { status: string }).status).toBe('ok');
    expect(client.writes).toHaveLength(1);
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toMatchObject({ op: 'upsertRow', revisionAfter: 'rev-1' });
  });
});

describe('B6, B7 — граница ошибок', () => {
  it('неизвестная операция → ok:false с кодом и списком допустимых, без стектрейса', async () => {
    const { deps } = harness();
    const result = await runTool(gcApply, { op: 'удалиВсё', target: 'log', values: {} }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('bad_request');
    expect(result.error?.detail).toContain('upsertRow');
    expect(JSON.stringify(result.error)).not.toContain('at Object');
  });

  it('запись в цель вне реестра → policy_denied с id правила', async () => {
    const { deps, client } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: `https://docs.google.com/spreadsheets/d/UNLISTED0000000000000/edit`,
        key: { Проект: 'G connect' },
        values: { Часы: 1 },
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_denied');
    expect(result.error?.cause).toBe('write.allowlist');
    expect(client.writes).toHaveLength(0);
  });

  it('право проверяется ДО обращения к Google, а не после (нашла живая проба)', async () => {
    // Клиент, который падает при любом вызове: если право проверяется вторым,
    // тест увидит ошибку сети вместо policy_denied — как это и было.
    const { deps } = harness({
      sheets: () => Promise.reject(new Error('в Google лезть не должны были')),
    });
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'https://docs.google.com/spreadsheets/d/UNLISTED0000000000000/edit',
        key: { Проект: 'x' },
        values: { Часы: 1 },
        dryRun: false,
      },
      deps,
    );
    expect(result.error?.code).toBe('policy_denied');
    expect(result.error?.cause).toBe('write.allowlist');
  });

  it('read-only цель не пишется даже при dryRun=false', async () => {
    const { deps } = harness();
    const result = await runTool(
      gcApply,
      { op: 'appendRow', target: 'reference', values: { Часы: 1 }, dryRun: false },
      deps,
    );
    expect(result.error?.cause).toBe('write.allowlist');
  });

  it('неожиданное падение инструмента тоже приходит как payload, а не как исключение', async () => {
    const { deps } = harness({
      sheets: () => Promise.reject(new Error('сеть отвалилась внезапно')),
    });
    const result = await runTool(gcRead, { target: 'log', mode: 'map' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('internal');
    expect(result.error?.cause).toContain('сеть отвалилась');
    expect(result.error?.title.length).toBeGreaterThan(0);
  });

  it('у каждой ошибки границы есть correlationId — иначе её не найти в аудите', async () => {
    const { deps } = harness();
    const result = await runTool(gcApply, { op: 'нет такой', target: 'log', values: {} }, deps);
    expect(result.error?.correlationId).toMatch(/^gc-/);
  });
});

describe('B8 — правила уходят клиенту', () => {
  it('instructions содержат политику и число машинных правил', () => {
    const text = serverInstructions();
    expect(text).toContain('Правила работы с документами');
    expect(text).toContain('policy://rules');
    expect(text).toMatch(/\d+ шт\./);
  });
});

describe('gc_read — карта как первый шаг', () => {
  it('mode=map отдаёт карту с предупреждениями, а не строки', async () => {
    const { deps } = harness();
    const data = (await runTool(gcRead, { target: 'log', mode: 'map' }, deps)).data as {
      headerRow: number;
      columns: { name: string }[];
      warnings: string[];
    };
    expect(data.headerRow).toBe(2);
    expect(data.columns.map((c) => c.name)).toContain('Статус');
    expect(data.warnings.join(' ')).toContain('над шапкой');
  });

  it('mode=values помечает усечение, а не молча обрезает', async () => {
    const { deps } = harness();
    const data = (await runTool(gcRead, { target: 'log', mode: 'values', limit: 1 }, deps))
      .data as {
      rows: unknown[];
      truncated: boolean;
    };
    expect(data.rows).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });
});

describe('gc_undo через инструмент', () => {
  it('откат после записи возвращает значения и сообщает, что откатил', async () => {
    const { deps, journalled } = harness();
    await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'log',
        key: { Проект: 'G connect' },
        values: { Часы: 9 },
        dryRun: false,
      },
      deps,
    );
    const result = await runTool(gcUndo, { target: 'log' }, deps);
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; restored: { value: unknown }[] };
    expect(data.status).toBe('ok');
    expect(data.restored[0]?.value).toBe(2);
    expect(journalled.some((r) => r.op === 'undo')).toBe(true);
  });

  it('нечего откатывать → говорит прямо', async () => {
    const { deps } = harness({ journalSource: { recent: () => Promise.resolve([]) } });
    const data = (await runTool(gcUndo, { target: 'log' }, deps)).data as {
      status: string;
      hint?: string;
    };
    expect(data.status).toBe('nothing_to_undo');
    expect(data.hint).toContain('откатывать нечего');
  });

  it('откат по read-only цели запрещён', async () => {
    const { deps } = harness();
    const result = await runTool(gcUndo, { target: 'reference' }, deps);
    expect(result.error?.cause).toBe('write.allowlist');
  });
});

describe('noopJournal не мешает', () => {
  it('запись с noopJournal проходит и ничего не журналирует', async () => {
    const { deps, client } = harness({ journal: noopJournal });
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'log',
        key: { Проект: 'G connect' },
        values: { Часы: 3 },
        dryRun: false,
      },
      deps,
    );
    expect((result.data as { status: string }).status).toBe('ok');
    expect(client.writes).toHaveLength(1);
  });
});
