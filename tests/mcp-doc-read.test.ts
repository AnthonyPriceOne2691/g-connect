/**
 * Чтение документов через gc_read (уровень 3, слайс 1): карта, абзацы, отказы по виду
 * цели (P21, P22, чтение для P15). Фикстура — «Прогноз на матч» из spec.md.
 */

import { describe, expect, it } from 'vitest';

import { gcRead, type ToolDeps, type ToolResult } from '../src/mcp/tools.js';
import type { Registry } from '../src/core/targets.js';
import type { GcErrorPayload } from '../src/core/errors.js';
import { isGcError } from '../src/core/errors.js';
import { FakeDocsClient, buildDoc, forecastDoc, p } from './fixtures/doc.js';
import { FakeSheetsClient, reportSheet } from './fixtures/sheet.js';

const DOC_ID = 'DOC0000000000000000001';
const SHEET_ID = 'SHEET00000000000000001';

const registry: Registry = {
  targets: [
    { alias: 'forecast', id: DOC_ID, type: 'doc', allow: 'write' },
    { alias: 'log', id: SHEET_ID, type: 'sheet', allow: 'write', sheet: 'Лист1' },
  ],
};

const deps = (docsClient: FakeDocsClient): ToolDeps => ({
  account: 'default',
  sheets: () =>
    Promise.resolve(
      new FakeSheetsClient({
        id: SHEET_ID,
        title: 'Книга',
        sheets: [reportSheet()],
        revisionId: 'r',
      }),
    ),
  docs: () => Promise.resolve(docsClient),
  drive: () => Promise.reject(new Error('Drive в этом сьюте не нужен')),
  registry: () => Promise.resolve(registry),
  journal: () => Promise.resolve(),
  journalSource: { recent: () => Promise.resolve([]) },
  revision: () => Promise.resolve('rev-1'),
});

const read = async (args: Record<string, unknown>, d: ToolDeps): Promise<ToolResult> => {
  try {
    return { ok: true, data: await gcRead.handle(args, d) };
  } catch (error) {
    if (isGcError(error)) return { ok: false, error: error.payload };
    throw error;
  }
};

const err = (result: ToolResult): GcErrorPayload => {
  expect(result.ok).toBe(false);
  return result.error!;
};

describe('P21 — gc_read mode=map по doc-цели', () => {
  it('отдаёт карту: табы, оглавление, таблицы, ревизия', async () => {
    const result = await read({ target: 'forecast' }, deps(new FakeDocsClient(forecastDoc())));
    expect(result.ok).toBe(true);
    const map = result.data as {
      revisionId: string;
      tabs: { title: string; headings: unknown[]; tables: unknown[] }[];
    };
    expect(map.revisionId).toBe('rev-forecast-1');
    expect(map.tabs.map((t) => t.title)).toEqual(['Прогноз', 'Черновики']);
    expect(map.tabs[0]!.headings).toHaveLength(3);
    expect(map.tabs[0]!.tables).toHaveLength(1);
  });
});

describe('mode=text — абзацы документа', () => {
  it('документ с двумя табами без tab — вопрос со списком, а не первый попавшийся', async () => {
    const result = await read(
      { target: 'forecast', mode: 'text' },
      deps(new FakeDocsClient(forecastDoc())),
    );
    const payload = err(result);
    expect(payload.code).toBe('bad_request');
    expect(payload.detail).toContain('Черновики');
  });

  it('с tab читает названный таб; несуществующий таб называет, что есть', async () => {
    const d = deps(new FakeDocsClient(forecastDoc()));
    const result = await read({ target: 'forecast', mode: 'text', tab: 'Черновики' }, d);
    expect(result.ok).toBe(true);
    const data = result.data as { tab: string; paragraphs: { n: number; text: string }[] };
    expect(data.tab).toBe('Черновики');
    expect(data.paragraphs[0]!.text).toContain('Устаревший прогноз');

    const missing = err(await read({ target: 'forecast', mode: 'text', tab: 'Нет такого' }, d));
    expect(missing.detail).toContain('Прогноз, Черновики');
  });

  it('единственный таб отдаётся без tab; fromParagraph и limit режут выдачу', async () => {
    const doc = buildDoc({
      tabs: [{ title: 'Один', content: [p('первый'), p('второй'), p('третий')] }],
    });
    const d = deps(new FakeDocsClient(doc));
    const result = await read({ target: 'forecast', mode: 'text', fromParagraph: 2, limit: 1 }, d);
    expect(result.ok).toBe(true);
    const data = result.data as { paragraphs: { n: number; text: string }[]; truncated: boolean };
    expect(data.paragraphs).toEqual([{ n: 2, text: 'второй', style: 'NORMAL_TEXT' }]);
    expect(data.truncated).toBe(true);
  });

  it('suggestions в документе — предупреждение в ответе', async () => {
    const doc = { ...forecastDoc(), hasSuggestions: true };
    const result = await read(
      { target: 'forecast', mode: 'text', tab: 'Прогноз' },
      deps(new FakeDocsClient(doc)),
    );
    expect(result.ok).toBe(true);
    expect((result.data as { warnings?: string[] }).warnings?.join(' ')).toContain('предложения');
  });
});

describe('P22-класс — вид цели решает, какие режимы существуют', () => {
  it('mode=values по документу — отказ с советом map|text', async () => {
    const payload = err(
      await read({ target: 'forecast', mode: 'values' }, deps(new FakeDocsClient(forecastDoc()))),
    );
    expect(payload.code).toBe('bad_request');
    expect(payload.detail).toContain('mode=text');
  });

  it('mode=text по таблице — отказ с советом values', async () => {
    const payload = err(
      await read({ target: 'log', mode: 'text' }, deps(new FakeDocsClient(forecastDoc()))),
    );
    expect(payload.code).toBe('bad_request');
    expect(payload.detail).toContain('mode=values');
  });
});
