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

  it('отказ по виду цели случается ДО любого чтения — заглушки чтения падают при вызове', async () => {
    // Рабочие заглушки не отличали «до чтения» от «после» (находка читателя 2026-10-01).
    const { deps } = harness();
    const blind: ToolDeps = {
      ...deps,
      docs: () => Promise.reject(new Error('документ читать нельзя')),
      sheets: () => Promise.reject(new Error('таблицу читать нельзя')),
    };
    const sheetOp = await call(
      gcApply,
      { op: 'appendRow', target: 'forecast', values: { а: 1 } },
      blind,
    );
    expect(sheetOp.ok ? null : sheetOp.error?.detail).toContain('appendText');
    const docOp = await call(gcApply, { op: 'appendText', target: 'log', text: 'х' }, blind);
    expect(docOp.ok ? null : docOp.error?.detail).toContain('таблица');
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

describe('находки читателя 2026-10-01: до Google — значит до Google', () => {
  it('P19b: локальная картинка отклоняется, и docs() не вызывается вовсе', async () => {
    const { deps } = harness();
    let touched = 0;
    const strict: ToolDeps = {
      ...deps,
      docs: () => {
        touched += 1;
        return Promise.reject(new Error('к Google ходить нельзя'));
      },
    };
    const result = await call(
      gcApply,
      { target: 'forecast', op: 'insertInlineImage', uri: '/Users/anthony/shot.png' },
      strict,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error?.cause).toBe('image.local-source');
    // Раньше проверка стояла после documents.get: «до сети» было неправдой.
    expect(touched).toBe(0);
  });

  it('expectRevision с ушедшей ревизией — отказ без записи, а не тихая запись по свежему чтению', async () => {
    const { deps, docs, journalled } = harness();
    const result = await call(
      gcApply,
      {
        target: 'forecast',
        op: 'appendText',
        text: 'новый абзац',
        dryRun: false,
        expectRevision: 'rev-давняя',
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error?.cause).toBe('expect_revision');
    expect(docs.applied).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });
});
