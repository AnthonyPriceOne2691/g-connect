/** Пример B12 спеки: превью файлом, который открывается сам по себе. */

import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderPreview, reportFileName, reportsDir, writeReport } from '../src/core/report/html.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';

const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  process.env['GCONNECT_HOME'] = await mkdtemp(join(tmpdir(), 'gconnect-report-'));
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

const meta = {
  title: 'Превью: upsertRow',
  spreadsheet: 'Рабочий журнал',
  sheet: 'Лист1',
  alias: 'log',
  revision: 'rev-1',
};

const preview: ApplyOutcome = {
  status: 'preview',
  changes: [
    { kind: 'set', a1: 'Лист1!D3', column: 'Часы', before: 2, after: 3 },
    { kind: 'addRow', a1: 'Лист1!B5', column: 'Проект', before: null, after: 'G connect' },
  ],
  assumptions: ['«Статус проекта» → колонка «Статус»'],
  notes: ['«3ч» разобрано как 3'],
  questions: [],
  baseRevision: 'rev-1',
  revisionAfter: null,
};

describe('B12 — HTML-превью', () => {
  it('показывает было → станет по каждой ячейке', () => {
    const html = renderPreview(preview, meta);
    expect(html).toContain('Лист1!D3');
    expect(html).toContain('Часы');
    expect(html).toContain('>2<');
    expect(html).toContain('>3<');
    expect(html).toContain('новая строка');
    expect(html).toContain('План: ничего ещё не записано');
  });

  it('оговорки и нормализации видны человеку, а не только в JSON', () => {
    const html = renderPreview(preview, meta);
    expect(html).toContain('Как я понял запрос');
    expect(html).toContain('«Статус проекта» → колонка «Статус»');
    expect(html).toContain('разобрано как 3');
  });

  it('вопросы выносятся отдельным блоком с вариантами', () => {
    const html = renderPreview(
      {
        status: 'needs_clarification',
        changes: [],
        assumptions: [],
        notes: [],
        questions: [
          {
            field: 'Статус',
            reason: 'not_in_enum',
            detail: '«почти готово» нет среди допустимых',
            candidates: ['в работе', 'готово'],
            available: [],
          },
        ],
        baseRevision: null,
        revisionAfter: null,
      },
      meta,
    );
    expect(html).toContain('Нужен ответ человека');
    expect(html).toContain('в работе · готово');
  });

  it('самодостаточен: ни одной внешней ссылки, ни скриптов', () => {
    const html = renderPreview(preview, meta);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<style>');
    expect(html).toContain('prefers-color-scheme');
  });

  it('значения из документа экранируются: содержимое ячейки не становится разметкой', () => {
    const html = renderPreview(
      {
        ...preview,
        changes: [
          {
            kind: 'set',
            a1: 'Лист1!A1',
            column: '<b>колонка</b>',
            before: null,
            after: '<script>alert(1)</script>',
          },
        ],
      },
      { ...meta, spreadsheet: '"кавычки" & <теги>' },
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;кавычки&quot; &amp; &lt;теги&gt;');
  });

  it('файл пишется рядом с профилем с правами 600 и различимым именем', async () => {
    const at = new Date('2026-09-01T20:15:30.000Z');
    const path = await writeReport(renderPreview(preview, meta), 'preview', at);
    expect(path.startsWith(reportsDir())).toBe(true);
    expect(path.endsWith('-preview.html')).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain('Лист1!D3');
  });

  it('имена не сталкиваются: в них есть время до секунды и вид отчёта', () => {
    const a = reportFileName(new Date('2026-09-01T20:15:30.000Z'), 'preview');
    const b = reportFileName(new Date('2026-09-01T20:15:31.000Z'), 'preview');
    const c = reportFileName(new Date('2026-09-01T20:15:30.000Z'), 'applied');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^2026-09-01T20-15-30-preview\.html$/);
  });

  it('пустой план говорит об этом, а не показывает пустую таблицу', () => {
    const html = renderPreview({ ...preview, changes: [] }, meta);
    expect(html).toContain('Изменений нет');
  });
});
