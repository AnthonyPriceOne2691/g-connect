/**
 * Правка вида ячеек (фаза 2.5a): примеры V2–V7, V12 и откат вида.
 *
 * Отдельным файлом, потому что гейт длины тестов (1000 строк) отклонил их житьё в
 * `sheets.test.ts` — и по делу: это другая операция, а не ещё один случай записи.
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { formatKey } from '../src/core/sheets/a1.js';
import type { CellFormat } from '../src/core/sheets/types.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { findReplace } from '../src/core/sheets/find-replace-op.js';
import { formatCells } from '../src/core/sheets/format-op.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';
import { undoLast } from '../src/core/undo.js';
import { FakeSheetsClient, formattedSheet, formulaSheet, snapshot } from './fixtures/sheet.js';

type Thrown = { payload: { code: string; cause?: string; detail: string } };
const thrown = async (run: Promise<unknown>): Promise<Thrown> =>
  run.then(
    () => {
      throw new Error('ожидался отказ, а вызов прошёл');
    },
    (error: unknown) => error as Thrown,
  );

describe('V2–V7, V11, V12 — правка вида', () => {
  const book = () => snapshot([formattedSheet()]);
  const data = () => buildSheetData(book());
  const where = { Проект: 'G connect' };

  const confirmedFormat = async (
    client: FakeSheetsClient,
    columns: readonly string[],
    format: Parameters<typeof formatCells>[4],
    options: Parameters<typeof formatCells>[5] = {},
  ): Promise<ApplyOutcome> => {
    const preview = await formatCells(client, data(), where, columns, format, options);
    if (preview.status !== 'preview') return preview;
    return formatCells(client, data(), where, columns, format, {
      ...options,
      dryRun: false,
      confirm: preview.planId ?? '',
    });
  };

  it('V2: превью правки вида — ячейка, «было → станет» по виду, код плана, записи нет', async () => {
    const client = new FakeSheetsClient(book());
    const preview = await formatCells(client, data(), where, ['Статус'], { bold: true });
    expect(preview.status).toBe('preview');
    expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]?.kind).toBe('format');
    expect(preview.changes[0]?.a1).toBe('Оформленный!C2');
    expect(preview.changes[0]?.beforeFormat).toEqual({ background: '#ffcc00' });
    expect(preview.changes[0]?.afterFormat).toEqual({ background: '#ffcc00', bold: true });
    expect(client.formatWrites).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('V3: запись по коду правит вид и НЕ трогает значения', async () => {
    const client = new FakeSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const before = (await client.getSpreadsheet()).sheets[0]?.rows[1]?.map((c) => c.value);
    const outcome = await confirmedFormat(
      client,
      ['Статус'],
      { bold: true },
      {
        journal: async (r) => {
          journalled.push(r);
        },
      },
    );
    expect(outcome.status).toBe('ok');
    expect(client.formatWrites).toHaveLength(1);
    // Ни одной записи значений — на это оракул, а не обещание в комментарии.
    expect(client.writes).toHaveLength(0);
    const after = (await client.getSpreadsheet()).sheets[0]?.rows[1]?.map((c) => c.value);
    expect(after).toEqual(before);
    expect(journalled[0]?.changes[0]?.beforeFormat).toEqual({ background: '#ffcc00' });
    expect(journalled[0]?.changes[0]?.afterFormat).toEqual({ background: '#ffcc00', bold: true });
  });

  it('V4: gc_undo возвращает вид, значения по-прежнему целы', async () => {
    const client = new FakeSheetsClient(book());
    const journalled: WriteRecord[] = [];
    await confirmedFormat(
      client,
      ['Статус'],
      { bold: true },
      {
        journal: async (r) => {
          journalled.push(r);
        },
      },
    );
    const undone = await undoLast(client, 'SHEET1', {
      recent: () => Promise.resolve(journalled),
    });
    expect(undone.status).toBe('ok');
    const cell = (await client.getSpreadsheet()).sheets[0]?.rows[1]?.[2];
    expect(cell?.format).toEqual({ background: '#ffcc00', bold: false });
    expect(cell?.value).toBe('в работе');
    expect(client.writes).toHaveLength(0);
  });

  it('V5: частичная правка не сбрасывает остальные поля вида', async () => {
    const client = new FakeSheetsClient(book());
    const preview = await formatCells(client, data(), where, ['Часы'], { italic: true });
    expect(preview.changes[0]?.afterFormat).toEqual({ align: 'right', italic: true });
  });

  it('V6: две правки вида — один план, один код, одна строка журнала', async () => {
    const client = new FakeSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const outcome = await confirmedFormat(
      client,
      ['Проект', 'Часы'],
      { underline: true, align: 'center' },
      {
        journal: async (r) => {
          journalled.push(r);
        },
      },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes).toHaveLength(2);
    expect(journalled).toHaveLength(1);
    expect(client.formatWrites).toHaveLength(2);
  });

  it('V7: вид формульной колонки без force блокируется так же, как запись', async () => {
    const client = new FakeSheetsClient(snapshot([formulaSheet()]));
    const failure = await thrown(
      formatCells(client, buildSheetData(snapshot([formulaSheet()])), where, ['Итого'], {
        bold: true,
      }),
    );
    expect(failure.payload.code).toBe('write_blocked');
    expect(failure.payload.cause).toBe('formula_column');
  });

  it('V12: правка вида без изменений → no_change с причиной, записи нет', async () => {
    const client = new FakeSheetsClient(book());
    const outcome = await formatCells(client, data(), where, ['Часы'], { align: 'right' });
    expect(outcome.status).toBe('no_change');
    // Причина именно про вид, а не «значения уже такие»: у пустого результата своя причина.
    expect(outcome.notes.join(' ')).toContain('Вид уже такой');
    expect(client.formatWrites).toHaveLength(0);
  });

  it('includeHeader правит и заголовок, но только если там есть что менять', async () => {
    const client = new FakeSheetsClient(book());
    // Шапка «Часы» уже жирная — значит в плане останется одна ячейка данных, а не две.
    const already = await formatCells(
      client,
      data(),
      where,
      ['Часы'],
      { bold: true },
      { includeHeader: true },
    );
    expect(already.changes.map((c) => c.a1)).toEqual(['Оформленный!B2']);

    // Курсива у шапки нет — попадают обе ячейки, и вид шапки в плане виден целиком.
    const both = await formatCells(
      client,
      data(),
      where,
      ['Часы'],
      { italic: true },
      { includeHeader: true },
    );
    expect(both.changes.map((c) => c.a1)).toEqual(['Оформленный!B1', 'Оформленный!B2']);
    expect(both.changes[0]?.beforeFormat).toEqual({ bold: true, align: 'center' });
    expect(both.changes[0]?.afterFormat).toEqual({ bold: true, align: 'center', italic: true });
  });
});

/** Слайс 4: поиск и замена. Превью обязано перечислять ячейки, а не число. */
describe('V8, V10 — findReplace', () => {
  const book = () => snapshot([formattedSheet()]);
  const data = () => buildSheetData(book());
  const input = {
    find: 'в работе',
    replace: 'готово',
    matchCase: false,
    matchEntireCell: false,
    searchByRegex: false,
  };

  it('V8: превью перечисляет КАЖДУЮ затронутую ячейку с «было → станет»', async () => {
    const client = new FakeSheetsClient(book());
    const preview = await findReplace(client, data(), input);
    expect(preview.status).toBe('preview');
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]?.a1).toBe('Оформленный!C2');
    expect(preview.changes[0]?.before).toBe('в работе');
    expect(preview.changes[0]?.after).toBe('готово');
    expect(client.writes).toHaveLength(0);
  });

  it('замена по регулярному выражению правит все совпадения и не путает алфавиты', async () => {
    const client = new FakeSheetsClient(book());
    const preview = await findReplace(client, data(), {
      ...input,
      find: 'o+',
      replace: '0',
      searchByRegex: true,
    });
    const byCell = Object.fromEntries(preview.changes.map((c) => [c.a1, c.after]));
    expect(byCell['Оформленный!A2']).toBe('G c0nnect');
    expect(byCell['Оформленный!A3']).toBe('lash-try-0n');
    // «в работе» написано кириллицей: латинское `o` там не совпадает, и ячейка не тронута.
    expect(byCell['Оформленный!C2']).toBeUndefined();
  });

  it('matchEntireCell не трогает частичные совпадения', async () => {
    const client = new FakeSheetsClient(book());
    const partial = await findReplace(client, data(), { ...input, find: 'работе' });
    expect(partial.changes).toHaveLength(1);
    const whole = await findReplace(client, data(), {
      ...input,
      find: 'работе',
      matchEntireCell: true,
    });
    expect(whole.status).toBe('no_change');
  });

  it('формульная колонка пропускается с оговоркой, а не роняет всю замену', async () => {
    const client = new FakeSheetsClient(snapshot([formulaSheet()]));
    const outcome = await findReplace(client, buildSheetData(snapshot([formulaSheet()])), {
      ...input,
      find: 'connect',
      replace: 'connect!',
    });
    expect(outcome.status).toBe('preview');
    expect(outcome.notes.join(' ')).toContain('формульная');
    // Ни одна ячейка формульной колонки в план не попала.
    expect(outcome.changes.every((c) => c.column !== 'Итого')).toBe(true);
  });

  it('замена проходит подтверждение кодом плана и уходит в журнал одной строкой', async () => {
    const client = new FakeSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const preview = await findReplace(client, data(), input);
    const outcome = await findReplace(client, data(), input, {
      dryRun: false,
      confirm: preview.planId ?? '',
      journal: async (r) => {
        journalled.push(r);
      },
    });
    expect(outcome.status).toBe('ok');
    expect(journalled).toHaveLength(1);
    expect(journalled[0]?.op).toBe('findReplace');
    expect(client.writes).toHaveLength(1);
  });
});

/**
 * Дефекты, найденные живой проверкой в соседней сессии 2026-09-03.
 *
 * Главный — код плана у правки вида не различал СОДЕРЖАНИЕ: «сделать жирным» и «снять
 * жирность» получали один код, и подтверждение человека переставало указывать на
 * конкретную правку. Оракулов на это не было ни одного: `plan.test.ts` проверял хеш от
 * рукописного плана, а тесты операции сравнивали планы по ячейкам, но не по кодам.
 */
describe('код плана различает содержание правки вида', () => {
  const book = () => snapshot([formattedSheet()]);
  const data = () => buildSheetData(book());
  const where = { Проект: 'G connect' };
  const plan = async (format: Parameters<typeof formatCells>[4]): Promise<ApplyOutcome> =>
    formatCells(new FakeSheetsClient(book()), data(), where, ['Часы'], format);

  it('разные поля вида на одной ячейке дают разные коды', async () => {
    const italic = await plan({ italic: true });
    const underline = await plan({ underline: true });
    expect(italic.planId).not.toBe(underline.planId);
  });

  it('противоположные правки одного поля дают разные коды', async () => {
    const on = await plan({ bold: true });
    // Ячейка «Часы» жирной не была, поэтому «снять жирность» — это no_change, а не план:
    // код у него null, и подтверждать нечего. Проверяем оба конца.
    const off = await plan({ bold: false });
    expect(on.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(off.status).toBe('no_change');
    expect(off.planId).toBeNull();
  });

  it('код от другого плана вида не проходит: запись отклоняется как plan_mismatch', async () => {
    const client = new FakeSheetsClient(book());
    const italic = await formatCells(client, data(), where, ['Часы'], { italic: true });
    const written = await formatCells(
      client,
      data(),
      where,
      ['Часы'],
      { underline: true },
      {
        dryRun: false,
        confirm: italic.planId ?? '',
      },
    );
    expect(written.status).toBe('plan_mismatch');
    expect(client.formatWrites).toHaveLength(0);
  });

  it('«снять жирность» там, где жирности нет, — no_change с причиной про вид', async () => {
    const outcome = await plan({ bold: false });
    expect(outcome.status).toBe('no_change');
    expect(outcome.notes.join(' ')).toContain('Вид уже такой');
  });

  it('замена без совпадений называет СВОЮ причину, а не «значения уже такие»', async () => {
    const client = new FakeSheetsClient(book());
    const outcome = await findReplace(client, data(), {
      find: 'такой-строки-нет-нигде',
      replace: 'x',
      matchCase: false,
      matchEntireCell: false,
      searchByRegex: false,
    });
    expect(outcome.status).toBe('no_change');
    expect(outcome.notes.join(' ')).toContain('Совпадений не найдено');
    expect(outcome.notes.join(' ')).not.toContain('уже такие значения');
  });

  it('у ячейки заголовка в плане видно её текст, а не null', async () => {
    const outcome = await formatCells(
      new FakeSheetsClient(book()),
      data(),
      where,
      ['Часы'],
      { italic: true },
      { includeHeader: true },
    );
    const header = outcome.changes.find((c) => c.a1.endsWith('1'));
    expect(header?.before).toBe('Часы');
    expect(header?.after).toBe('Часы');
  });
});

/**
 * Сравнение видов (`formatKey`). Мутационный гейт показал `a1.ts` 63% — сворачивание
 * «false ≡ не задано» стоит на одной строке, и её мутанты выживали.
 */
describe('сравнение видов', () => {
  it('«не жирный» и «жирности нет» — один вид', () => {
    expect(formatKey({ bold: false })).toBe(formatKey(undefined));
    expect(formatKey({ italic: false, underline: false })).toBe(formatKey({}));
  });

  it('заданный флаг от незаданного отличается', () => {
    expect(formatKey({ bold: true })).not.toBe(formatKey(undefined));
  });

  it('выравнивание и фон НЕ сворачиваются: у них нет нейтрального значения', () => {
    // У align значение по умолчанию зависит от типа данных, белый фон — осознанный выбор.
    expect(formatKey({ align: 'left' })).not.toBe(formatKey(undefined));
    expect(formatKey({ background: '#ffffff' })).not.toBe(formatKey(undefined));
  });

  it('порядок ключей не влияет, лишние undefined отбрасываются', () => {
    expect(formatKey({ bold: true, align: 'right' })).toBe(
      formatKey({ align: 'right', bold: true }),
    );
    // `italic: undefined` строгий TS в литерале не пустит, а из данных такое приходит —
    // поэтому через приведение: важно, что ключ со значением undefined в ключ не попадает.
    expect(formatKey({ bold: true, italic: undefined } as unknown as CellFormat)).toBe(
      formatKey({ bold: true }),
    );
  });
});

/**
 * Поиск и замена, границы. Мутационный гейт показал `find-replace-op.ts` 52% — половина
 * мутантов выживала, а это ПИШУЩИЙ путь: escaping и регистр там решают, что попадёт в
 * таблицу.
 */
describe('findReplace — регистр, экранирование, область', () => {
  const book = () => snapshot([formattedSheet()]);
  const data = () => buildSheetData(book());
  const run = (over: Partial<Parameters<typeof findReplace>[2]>): Promise<ApplyOutcome> =>
    findReplace(new FakeSheetsClient(book()), data(), {
      find: 'x',
      replace: 'y',
      matchCase: false,
      matchEntireCell: false,
      searchByRegex: false,
      ...over,
    });

  it('matchCase: true не трогает другой регистр', async () => {
    const insensitive = await run({ find: 'g CONNECT', replace: 'X' });
    expect(insensitive.changes).toHaveLength(1);
    const sensitive = await run({ find: 'g CONNECT', replace: 'X', matchCase: true });
    expect(sensitive.status).toBe('no_change');
  });

  it('обычный поиск не работает как регулярное выражение: точка это точка', async () => {
    // Без экранирования `G.connect` совпало бы с «G connect» — и замена ушла бы не туда.
    const literal = await run({ find: 'G.connect', replace: 'X' });
    expect(literal.status).toBe('no_change');
    const asRegex = await run({ find: 'G.connect', replace: 'X', searchByRegex: true });
    expect(asRegex.changes).toHaveLength(1);
  });

  it('matchEntireCell сравнивает всю ячейку и тоже уважает регистр', async () => {
    const whole = await run({ find: 'g connect', replace: 'X', matchEntireCell: true });
    expect(whole.changes[0]?.after).toBe('X');
    const cased = await run({
      find: 'g connect',
      replace: 'X',
      matchEntireCell: true,
      matchCase: true,
    });
    expect(cased.status).toBe('no_change');
  });

  it('columns сужает область: колонка вне списка не трогается', async () => {
    // Кириллическое «о» на этой фикстуре есть только в «Статусе» — значит запрос по
    // «Проекту» обязан дать no_change, а не «те же две ячейки».
    const everywhere = await run({ find: 'о', replace: '0' });
    expect(everywhere.changes.every((c) => c.column === 'Статус')).toBe(true);
    expect(everywhere.changes.length).toBeGreaterThan(0);

    const otherColumn = await run({ find: 'о', replace: '0', columns: ['Проект'] });
    expect(otherColumn.status).toBe('no_change');

    const sameColumn = await run({ find: 'о', replace: '0', columns: ['Статус'] });
    expect(sameColumn.changes).toHaveLength(everywhere.changes.length);
  });

  it('замена на пустую строку законна: это очистка, а не «нечего менять»', async () => {
    const cleared = await run({ find: 'в работе', replace: '', matchEntireCell: true });
    expect(cleared.status).toBe('preview');
    expect(cleared.changes[0]?.after).toBe('');
  });
});
