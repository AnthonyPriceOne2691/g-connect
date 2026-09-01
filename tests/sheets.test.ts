/** Примеры A1–A11 из delivery/active/spec.md. Ни одного обращения к Google. */

import { describe, expect, it } from 'vitest';

import { buildSheetData, buildSheetMap, detectHeaderRow } from '../src/core/sheets/map.ts';
import { appendRow, setCells, upsertRow } from '../src/core/sheets/rows.ts';
import { FakeSheetsClient, formulaSheet, snapshot, twoDatesSheet } from './fixtures/sheet.ts';

const NOW = new Date(2026, 8, 1, 10, 0, 0);
const data = () => buildSheetData(snapshot());
const aliases = { Часы: ['затрачено', 'time'] };

describe('A1 — карта листа', () => {
  it('шапка найдена во второй строке, а не в первой', () => {
    const map = buildSheetMap(snapshot());
    expect(map.headerRow).toBe(2);
    expect(map.headerRowReason).toContain('строка 2');
    expect(map.columns.map((c) => c.name)).toEqual(['Дата', 'Проект', 'Статус', 'Часы']);
    expect(map.dataRowCount).toBe(2);
    expect(map.usedRange).toBe('Лист1!A1:D4');
  });

  it('типы колонок выведены, enum взят из проверки данных таблицы', () => {
    const map = buildSheetMap(snapshot());
    const byName = Object.fromEntries(map.columns.map((c) => [c.name, c]));
    expect(byName['Дата']?.type).toBe('date');
    expect(byName['Дата']?.dateFormat).toBe('iso');
    expect(byName['Часы']?.type).toBe('number');
    expect(byName['Статус']?.enumValues).toEqual(['в работе', 'готово', 'пауза']);
    expect(byName['Статус']?.enumSource).toBe('validation');
  });

  it('строки над шапкой попадают в предупреждения, а не теряются молча', () => {
    expect(buildSheetMap(snapshot()).warnings.join(' ')).toContain('над шапкой');
  });

  it('карта для агента не тащит все строки, данные лежат отдельно', () => {
    const { map, rows } = data();
    expect(map.sampleRows).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(map)).not.toContain('sampleAll');
  });

  it('headerRow можно задать вручную, когда эвристика не угадала', () => {
    const map = buildSheetMap(snapshot(), { headerRow: 1 });
    expect(map.headerRow).toBe(1);
    expect(map.headerRowReason).toContain('задана вызывающим');
  });

  it('эвристика не путает подпись отчёта с шапкой и на других формах листа', () => {
    const guess = detectHeaderRow([
      [{ value: 'Журнал' }, { value: null }],
      [{ value: null }, { value: null }],
      [{ value: 'Дата' }, { value: 'Проект' }],
      [{ value: '2026-09-01' }, { value: 'G connect' }],
    ]);
    expect(guess.row).toBe(3);
  });
});

describe('A2, A3 — upsert правит строку, а не плодит дубликаты', () => {
  it('A2: существующий ключ → одна правка D3, новых строк нет', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertRow(
      client,
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 3 },
      { dryRun: false },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes).toEqual([
      { kind: 'set', a1: 'Лист1!D3', column: 'Часы', before: 2, after: 3 },
    ]);
    expect(client.writes).toHaveLength(1);
  });

  it('A3: нового ключа нет → добавляется строка 5', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertRow(
      client,
      data(),
      { Дата: '2026-09-02', Проект: 'G connect' },
      { Статус: 'готово', Часы: 1 },
      { dryRun: false, now: NOW },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes.every((c) => c.kind === 'addRow')).toBe(true);
    expect(outcome.changes.map((c) => c.a1)).toEqual([
      'Лист1!A5',
      'Лист1!B5',
      'Лист1!C5',
      'Лист1!D5',
    ]);
  });

  it('dryRun по умолчанию: план есть, записи нет (§11.1)', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertRow(
      client,
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 9 },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.changes).toHaveLength(1);
    expect(client.writes).toHaveLength(0);
  });

  it('повторный upsert с теми же значениями не порождает изменений', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 2 },
    );
    expect(outcome.changes).toHaveLength(0);
  });
});

describe('A4, A4b, A4c — ступени резолва имени колонки', () => {
  it('A4: «Статус проекта» → «Статус» с оговоркой в превью (ступень 4)', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { 'Статус проекта': 'готово' },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.assumptions).toEqual(['«Статус проекта» → колонка «Статус»']);
    expect(outcome.changes[0]?.a1).toBe('Лист1!C3');
  });

  it('A4b: подтверждённый алиас пишет молча, оговорок нет (ступень 3)', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { Затрачено: 4 },
      { aliases },
    );
    expect(outcome.assumptions).toEqual([]);
    expect(outcome.changes[0]).toMatchObject({ column: 'Часы', a1: 'Лист1!D3', after: 4 });
  });

  it('A4c: опечатка «Стаус» → «Статус» с оговоркой', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { Стаус: 'готово' },
    );
    expect(outcome.assumptions).toEqual(['«Стаус» → колонка «Статус»']);
  });

  it('латинская «c» в «Cтатус» и регистр — ступень 2, молча', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { cтатус: 'готово' },
    );
    expect(outcome.assumptions).toEqual([]);
    expect(outcome.changes[0]?.column).toBe('Статус');
  });
});

describe('A5, A6 — неоднозначность и отсутствие спрашиваются', () => {
  it('A5: «Дата» при «Дата начала» и «Дата сдачи» → вопрос с кандидатами', async () => {
    const twoDates = buildSheetData(snapshot([twoDatesSheet()]));
    const outcome = await setCells(
      new FakeSheetsClient(),
      twoDates,
      { Проект: 'G connect' },
      { Дата: 'сегодня' },
      { now: NOW },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('ambiguous');
    expect(outcome.questions[0]?.candidates).toEqual(['Дата начала', 'Дата сдачи']);
    expect(outcome.changes).toHaveLength(0);
  });

  it('A6: колонки нет → вопрос со полным списком, колонка не создана', async () => {
    const client = new FakeSheetsClient();
    const outcome = await setCells(
      client,
      data(),
      { Проект: 'G connect' },
      { Бюджет: 100 },
      { dryRun: false },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('no_match');
    expect(outcome.questions[0]?.available).toEqual(['Дата', 'Проект', 'Статус', 'Часы']);
    expect(client.writes).toHaveLength(0);
  });
});

describe('A7, A8, A9 — значения', () => {
  it('A7: «В РАБОТЕ» приводится к «в работе» молча', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Статус: 'В РАБОТЕ' },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.changes).toHaveLength(0);
    expect(outcome.notes.join(' ')).toContain('приведено к «в работе»');
  });

  it('A8: «почти готово» — новое значение, а не опечатка → вопрос со списком', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Статус: 'почти готово' },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('not_in_enum');
    expect(outcome.questions[0]?.candidates).toEqual(['в работе', 'готово', 'пауза']);
    expect(outcome.questions[0]?.detail).toContain('проверкой данных');
  });

  it('A9: «3ч» записывается числом 3', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: '3ч' },
    );
    expect(outcome.changes[0]?.after).toBe(3);
    expect(outcome.notes.join(' ')).toContain('разобрано как 3');
  });

  it('«много» в числовую колонку — вопрос, а не 0 и не NaN', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 'много' },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('not_a_number');
  });

  it('«сегодня» пишется в формате колонки: точки там, где точки', async () => {
    const twoDates = buildSheetData(snapshot([twoDatesSheet()]));
    const outcome = await setCells(
      new FakeSheetsClient(),
      twoDates,
      { Проект: 'G connect' },
      { 'Дата сдачи': 'сегодня' },
      { now: NOW },
    );
    expect(outcome.changes[0]?.after).toBe('01.09.2026');
  });
});

describe('A10, A11 — блокировки и похожие ключи', () => {
  it('A10: запись в формульную колонку блокируется с внятной причиной', async () => {
    const formulas = buildSheetData(snapshot([formulaSheet()]));
    await expect(
      setCells(new FakeSheetsClient(), formulas, { Проект: 'G connect' }, { Итого: 10 }),
    ).rejects.toMatchObject({
      payload: {
        code: 'write_blocked',
        cause: 'formula_column',
        action: { kind: 'confirm_explicitly' },
      },
    });
  });

  it('A10b: с осознанным подтверждением запись разрешена', async () => {
    const formulas = buildSheetData(snapshot([formulaSheet()]));
    const outcome = await setCells(
      new FakeSheetsClient(),
      formulas,
      { Проект: 'G connect' },
      { Итого: 10 },
      { force: true },
    );
    expect(outcome.status).toBe('preview');
  });

  it('A11: «Gconnect» вместо «G connect» → вопрос вместо новой строки', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Проект: 'Gconnect' },
      { Часы: 1 },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('key_not_found');
    expect(outcome.questions[0]?.candidates).toEqual(['G connect']);
  });

  it('ревизия изменилась с момента чтения → revision_conflict, а не слепая запись', async () => {
    await expect(
      upsertRow(
        new FakeSheetsClient(),
        data(),
        { Проект: 'G connect' },
        { Часы: 1 },
        { expectRevision: 'rev-0', dryRun: false },
      ),
    ).rejects.toMatchObject({ payload: { code: 'revision_conflict' } });
  });

  it('ключ подошёл нескольким строкам → уточнить, а не править все', async () => {
    const many = buildSheetData(
      snapshot([
        {
          title: 'Лист1',
          sheetId: 0,
          rows: [
            [{ value: 'Проект' }, { value: 'Часы' }],
            [{ value: 'G connect' }, { value: 1 }],
            [{ value: 'G connect' }, { value: 2 }],
          ],
        },
      ]),
    );
    await expect(
      upsertRow(new FakeSheetsClient(), many, { Проект: 'G connect' }, { Часы: 5 }),
    ).rejects.toMatchObject({ payload: { code: 'ambiguous_target' } });
  });

  it('appendRow пишет дубликат осознанно — там это законно', async () => {
    const client = new FakeSheetsClient();
    const outcome = await appendRow(
      client,
      data(),
      { Дата: '2026-09-01', Проект: 'G connect', Часы: 2 },
      { dryRun: false },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes).toHaveLength(3);
    expect(client.writes.map((w) => w.range)).toEqual(['Лист1!A5', 'Лист1!B5', 'Лист1!D5']);
  });
});

describe('универсальность ядра (D-10)', () => {
  it('в коде ядра нет имён листов, колонок и таблиц', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(path)));
        else if (entry.name.endsWith('.ts')) out.push(path);
      }
      return out;
    };

    // Имена из фикстуры: если они всплывут в КОДЕ, значит ядро подогнали под таблицу.
    // Комментарии вырезаются: пример в прозе («„Бюджет“ не должен быть похож на „Часы“»)
    // объясняет порог и ничего не зашивает — первая версия теста краснела именно на нём.
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const forbidden = ['Лист1', 'Проект', 'Часы', 'Отчёт за сентябрь', 'daily-log', 'Сроки'];
    for (const file of await walk('src')) {
      const code = stripComments(await readFile(file, 'utf8'));
      for (const word of forbidden) {
        expect(code, `${file} зашивает «${word}» в код`).not.toContain(word);
      }
    }
  });
});
