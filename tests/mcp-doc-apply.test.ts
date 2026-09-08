/**
 * Doc-операции через инструменты (уровень 3, слайс 4): превью → запись → откат тем же
 * путём, каким ходит живой клиент; отказы по виду цели (P22 / T6).
 */

import { describe, expect, it } from 'vitest';

import { gcApply, gcUndo, type ToolDeps, type ToolResult } from '../src/mcp/tools.js';
import type { Registry } from '../src/core/targets.js';
import type { WriteRecord } from '../src/core/journal.js';
import { isGcError } from '../src/core/errors.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';
import { FakeSheetsClient, reportSheet } from './fixtures/sheet.js';

const DOC_ID = 'DOC0000000000000000001';
const SHEET_ID = 'SHEET00000000000000001';

const registry: Registry = {
  targets: [
    { alias: 'forecast', id: DOC_ID, type: 'doc', allow: 'write' },
    { alias: 'log', id: SHEET_ID, type: 'sheet', allow: 'write', sheet: 'Лист1', key: ['Проект'] },
  ],
};

function harness() {
  const docs = new FakeDocsClient(forecastDoc());
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () =>
      Promise.resolve(
        new FakeSheetsClient({ id: SHEET_ID, title: 'Книга', sheets: [reportSheet()] }),
      ),
    docs: () => Promise.resolve(docs),
    drive: () => Promise.reject(new Error('Drive не нужен')),
    registry: () => Promise.resolve(registry),
    journal: async (r) => {
      journalled.push(r);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('rev-1'),
  };
  return { deps, docs, journalled };
}

const call = async (
  tool: typeof gcApply,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolResult> => {
  try {
    return { ok: true, data: await tool.handle(args, deps) };
  } catch (error) {
    if (isGcError(error)) return { ok: false, error: error.payload };
    throw error;
  }
};

describe('сквозной путь: превью → запись → откат', () => {
  it('insertText по doc-цели проходит контур целиком', async () => {
    const { deps, docs } = harness();
    const preview = await call(
      gcApply,
      {
        op: 'insertText',
        target: 'forecast',
        tab: 'Прогноз',
        text: 'Погода: дождь',
        where: { textStartsWith: 'Ставим на победу' },
      },
      deps,
    );
    expect(preview.ok).toBe(true);
    const plan = preview.data as { status: string; planId: string };
    expect(plan.status).toBe('preview');

    const written = await call(
      gcApply,
      {
        op: 'insertText',
        target: 'forecast',
        tab: 'Прогноз',
        text: 'Погода: дождь',
        where: { textStartsWith: 'Ставим на победу' },
        dryRun: false,
        confirm: plan.planId,
      },
      deps,
    );
    expect(written.ok).toBe(true);
    expect((written.data as { status: string }).status).toBe('ok');
    expect((await docs.getDocument()).tabs[0]!.paragraphs.map((p) => p.text)).toContain(
      'Погода: дождь',
    );

    const undone = await call(gcUndo, { target: 'forecast' }, deps);
    expect(undone.ok).toBe(true);
    expect((undone.data as { status: string; docUndone: string }).docUndone).toContain('Погода');
    expect((await docs.getDocument()).tabs[0]!.paragraphs.map((p) => p.text)).not.toContain(
      'Погода: дождь',
    );
  });
});

describe('P22 / T6 — вид цели решает до чтения', () => {
  it('appendText по таблице — отказ с советом табличных операций', async () => {
    const { deps } = harness();
    const result = await call(gcApply, { op: 'appendText', target: 'log', text: 'х' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('bad_request');
    expect(result.error!.detail).toContain('таблица');
  });

  it('appendRow по документу — отказ с перечнем doc-операций', async () => {
    const { deps } = harness();
    const result = await call(
      gcApply,
      { op: 'appendRow', target: 'forecast', values: { Дата: '2026-09-08' } },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error!.detail).toContain('appendText');
  });
});
