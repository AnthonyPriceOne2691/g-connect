/**
 * Гарнитура, кегль и формат числа (D-26, Q11–Q12): «Реестр инфраструктуры» выравнивают видом —
 * данные Carlito 10, шапка Carlito 11 жирная, даты dd.mm.yyyy, — а ядро этих полей не видело и
 * не писало.
 *
 * Шов судится на форме ответа Google (урок L28): заглушка отдаёт `userEnteredFormat`, как его
 * описывает документация Sheets API, и принимает `repeatCell` — маску и тело правки видно там
 * же, где их увидит Google. Откат и сравнение видов — на фейках `tests/fixtures/sheet.ts`;
 * `gc_read` и `gc_apply` — через настоящий протокол (урок L26).
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import type { JournalChange, WriteRecord } from '../src/core/journal.js';
import { parseOperation } from '../src/core/ops.js';
import { renderPreview } from '../src/core/report/html.js';
import { formatKey } from '../src/core/sheets/a1.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';
import type { CellFormat, SheetSnapshot } from '../src/core/sheets/types.js';
import { undoLast } from '../src/core/undo.js';
import { gcApply, gcRead, type ToolDeps } from '../src/mcp/tools.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';
import { callMcp } from './fixtures/protocol.js';

const ID = '1FONTregistryEEEEEEEEEEEEEEEEEEEEEEE';
const TITLE = 'Реестр';
const DATE_DOTTED = { type: 'DATE', pattern: 'dd.mm.yyyy' } as const;
const CARLITO_10 = { fontFamily: 'Carlito', fontSize: 10 } as const;

type GoogleCell = sheets_v4.Schema$CellData;
type GoogleFormat = sheets_v4.Schema$CellFormat;

/**
 * Вид, который лист даёт сам (`effectiveFormat`): Google отдаёт его у КАЖДОЙ ячейки, и своим
 * ядро его считать не должно — откатывать вид листа нечем.
 */
const SHEET_DEFAULT = { textFormat: { fontFamily: 'Arial', fontSize: 10 } };

/** Текст, как его отдаёт Google; явный вид — только в `userEnteredFormat`. */
const text = (value: string, format?: GoogleFormat): GoogleCell => ({
  effectiveValue: { stringValue: value },
  formattedValue: value,
  effectiveFormat: SHEET_DEFAULT,
  ...(format === undefined ? {} : { userEnteredFormat: format }),
});

/** Дата: серийное число, видимый текст и формат DATE в `effectiveFormat` — так она и приходит. */
const date = (serial: number, shown: string, format: GoogleFormat): GoogleCell => ({
  effectiveValue: { numberValue: serial },
  formattedValue: shown,
  effectiveFormat: { ...SHEET_DEFAULT, numberFormat: { ...DATE_DOTTED } },
  userEnteredFormat: format,
});

const font = (fontFamily: string, fontSize: number, bold?: boolean): GoogleFormat => ({
  textFormat: { fontFamily, fontSize, ...(bold === undefined ? {} : { bold }) },
});

/** «Реестр»: шапка Carlito 11 жирная, данные Carlito 10 — и строки, дописанные без этого вида. */
function registryRows(): GoogleCell[][] {
  const header = font('Carlito', 11, true);
  const data = font('Carlito', 10);
  const dated = { ...font('Carlito', 10), numberFormat: { ...DATE_DOTTED } };
  return [
    [text('Проект', header), text('Запуск', header), text('Владелец', header)],
    [text('G connect', data), date(46266, '01.09.2026', dated), text('Антон', data)],
    [text('lash-try-on', data), date(46236, '02.08.2026', dated), text('Антон', data)],
    // Дописана агентом: шрифт не тот, дата — ISO-текстом и без формата (весть владельца).
    [text('portfolio', font('Arial', 10)), text('2026-10-19'), text('Антон')],
    [text('ops-bot'), text('2026-10-18'), text('Антон')],
    // Оформленные пустые ячейки: Google отдаёт такую строку, но данных в ней нет.
    [{ userEnteredFormat: data }, { userEnteredFormat: data }],
  ];
}

/** Номера строк диапазона: «'Лист'» — весь лист, «'Лист'!A5:ZZ9» — с 5 по 9. */
function rowsOf(range: string | undefined, total: number): [number, number] {
  const match = /!A(\d+):[A-Z]+(\d+)$/.exec(range ?? '');
  return match === null ? [1, total] : [Number(match[1]), Number(match[2])];
}

/** Google, отвечающий формой документации; правки вида — в `requests`, как их получил бы он. */
function google(rows: readonly GoogleCell[][] = registryRows()) {
  const requests: sheets_v4.Schema$Request[] = [];
  const properties = {
    sheetId: 4,
    title: TITLE,
    gridProperties: { rowCount: 1000, columnCount: 26 },
  };
  const book = { title: 'Реестр инфраструктуры ИИ-отдела' };
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean; ranges?: string[] }) => {
        if (params.includeGridData !== true) {
          return Promise.resolve({ data: { properties: book, sheets: [{ properties }] } });
        }
        const [from, to] = rowsOf(params.ranges?.[0], rows.length);
        const rowData = rows.slice(from - 1, to).map((values) => ({ values }));
        return Promise.resolve({
          data: {
            properties: book,
            sheets: [{ properties, data: [{ startRow: from - 1, rowData }] }],
          },
        });
      },
      batchUpdate: (params: { requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
        requests.push(...params.requestBody.requests);
        return Promise.resolve({ data: {} });
      },
    },
  } as unknown as sheets_v4.Sheets;
  const drive = {
    files: { get: () => Promise.resolve({ data: { version: '1' } }) },
  } as unknown as drive_v3.Drive;
  return { api: { sheets, drive }, requests };
}

type Google = ReturnType<typeof google>;

const clientOf = (g: Google): GoogleSheetsClient =>
  new GoogleSheetsClient({ accessToken: 'нет', api: g.api });

/** Цель с конвертом на правку вида: запись идёт с первой фразы, без кода плана (D-18). */
function depsOf(g: Google, journalled: WriteRecord[] = []): ToolDeps {
  const client = clientOf(g);
  return {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () =>
      Promise.resolve({
        targets: [
          {
            alias: 'registry',
            id: ID,
            type: 'sheet',
            allow: 'write',
            sheet: TITLE,
            headerRow: 1,
            key: ['Проект'],
            auto: { ops: ['formatCells'], maxCells: 6 },
          },
        ],
      }),
    journal: (record: WriteRecord) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('1'),
  };
}

describe('Q11 — шрифт, кегль и формат числа видны при чтении', () => {
  it('Q11: шов — гарнитура, кегль и формат числа из userEnteredFormat переходят в вид ячейки', async () => {
    const book = await clientOf(google()).getSpreadsheet(ID, { sheet: TITLE });
    const rows = book.sheets[0]?.rows ?? [];
    expect(rows[0]?.[0]?.format).toEqual({ bold: true, fontFamily: 'Carlito', fontSize: 11 });
    expect(rows[1]?.[1]?.format).toEqual({ ...CARLITO_10, numberFormat: DATE_DOTTED });
    expect(rows[3]?.[0]?.format).toEqual({ fontFamily: 'Arial', fontSize: 10 });
    // Вид листа (`effectiveFormat`) своим не считается — как и раньше у жирности.
    expect(rows[3]?.[1]?.format).toBeUndefined();
  });

  it('Q11: шов — тип UNSPECIFIED и незнакомый не читаются, пустые шаблон и шрифт — тоже', async () => {
    const rows = [
      [text('Проект'), text('Сумма'), text('Доля'), text('Код')],
      [
        text('G connect', { textFormat: { fontFamily: '', fontSize: 10 } }),
        text('100', { numberFormat: { type: 'NUMBER', pattern: '' } }),
        text('0,5', { numberFormat: { type: 'NUMBER_FORMAT_TYPE_UNSPECIFIED', pattern: '0%' } }),
        text('X1', { numberFormat: { type: 'NEW_TYPE_FROM_GOOGLE' }, textFormat: { bold: true } }),
      ],
    ];
    const book = await clientOf(google(rows)).getSpreadsheet(ID, { sheet: TITLE });
    const cells = book.sheets[0]?.rows[1] ?? [];
    expect(cells[0]?.format).toEqual({ fontSize: 10 });
    expect(cells[1]?.format).toEqual({ numberFormat: { type: 'NUMBER' } });
    expect(cells[2]?.format).toBeUndefined();
    expect(cells[3]?.format).toEqual({ bold: true });
  });

  it('Q11: карта — шрифт шапки и шрифт с форматом даты первой строки данных', async () => {
    const result = await callMcp(gcRead, { target: 'registry', mode: 'map' }, depsOf(google()));
    type Column = { name: string; headerFormat?: CellFormat; format?: CellFormat };
    const columns = (result.data as { columns: Column[] }).columns;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName['Проект']?.headerFormat).toEqual({
      bold: true,
      fontFamily: 'Carlito',
      fontSize: 11,
    });
    expect(byName['Проект']?.format).toEqual(CARLITO_10);
    expect(byName['Запуск']?.format).toEqual({ ...CARLITO_10, numberFormat: DATE_DOTTED });
  });

  it('Q11: gc_read values с withFormat — вид строка в строку с rows, отличающаяся строка видна', async () => {
    const result = await callMcp(
      gcRead,
      { target: 'registry', mode: 'values', withFormat: true },
      depsOf(google()),
    );
    const data = result.data as {
      rows: { value: Record<string, unknown>[] };
      formats: { kind: string; value: Record<string, CellFormat>[] };
    };
    // Оформленная пустая строка в хвосте — строка ответа, раз вид просили (Q38): в rows она пуста,
    // в formats — её вид. Без withFormat её нет (следующий тест). До Q38 её не было и здесь.
    expect(data.rows.value).toHaveLength(5);
    expect(data.rows.value[4]).toEqual({ Проект: null, Запуск: null, Владелец: null });
    expect(data.formats.value).toHaveLength(data.rows.value.length);
    expect(data.formats.value[4]).toEqual({ Проект: CARLITO_10, Запуск: CARLITO_10 });
    // Вид — тоже данные из документа: имя шрифта и шаблон формата пишет кто угодно.
    expect(data.formats.kind).toBe('data');
    expect(data.formats.value[0]).toEqual({
      Проект: CARLITO_10,
      Запуск: { ...CARLITO_10, numberFormat: DATE_DOTTED },
      Владелец: CARLITO_10,
    });
    // Дописанная строка: шрифт другой, у даты явного вида нет — такая ячейка не попадает.
    expect(data.rows.value[2]).toMatchObject({ Проект: 'portfolio' });
    expect(data.formats.value[2]).toEqual({ Проект: { fontFamily: 'Arial', fontSize: 10 } });
    // Строка без явного вида — пустой объект, а не пропуск: номер строки не съезжает.
    expect(data.formats.value[3]).toEqual({});
  });

  it('Q11: без withFormat ключа formats в ответе нет — ответ не растёт без просьбы', async () => {
    const result = await callMcp(gcRead, { target: 'registry', mode: 'values' }, depsOf(google()));
    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty('formats');
    expect((result.data as { rows: { value: unknown[] } }).rows.value).toHaveLength(4);
  });
});

type Payload = { code: string; cause?: string; detail: string };

/** Операция правки вида с данным `format` — как её пришлёт агент. */
const formatOp = (format: unknown) => ({
  op: 'formatCells',
  target: 'registry',
  where: { Проект: 'portfolio' },
  columns: ['Проект'],
  format,
});

const refusal = (format: unknown): Payload => {
  try {
    parseOperation(formatOp(format));
  } catch (error) {
    return (error as { payload: Payload }).payload;
  }
  throw new Error('ожидался отказ, а разбор прошёл');
};

describe('Q12 — граница gc_apply: шрифт, кегль и формат числа', () => {
  it('Q12: шрифт, кегль и формат числа проходят разбор formatCells; шрифт — без пробелов по краям', () => {
    const op = parseOperation(
      formatOp({
        fontFamily: '  Carlito ',
        fontSize: 10,
        numberFormat: { pattern: 'dd.mm.yyyy', type: 'DATE' },
      }),
    );
    expect(op.op === 'formatCells' ? op.format : null).toEqual({
      ...CARLITO_10,
      numberFormat: DATE_DOTTED,
    });
  });

  it.each([5, 97, 10.5])('Q12: кегль %s — отказ bad_request с понятным текстом', (fontSize) => {
    const payload = refusal({ fontSize });
    expect(payload.code).toBe('bad_request');
    expect(payload.cause).toBe('schema_violation');
    expect(payload.detail).toContain('format.fontSize: кегль — целое число пунктов от 6 до 96');
  });

  it('Q12: null у шрифта, кегля и формата числа не принимается — это слово отката, а не правки', () => {
    for (const field of ['fontFamily', 'fontSize', 'numberFormat']) {
      const payload = refusal({ [field]: null });
      expect(payload.code, field).toBe('bad_request');
      expect(payload.detail, field).toContain(`format.${field}`);
      expect(payload.detail, field).toContain('пишет только откат');
    }
  });

  it('Q12: незнакомый тип формата числа и опечатка в нём — отказ с перечислением допустимого', () => {
    const type = refusal({ numberFormat: { type: 'DATES' } });
    expect(type.detail).toContain(
      'format.numberFormat.type: значения «DATES» нет; допустимы: TEXT, NUMBER, PERCENT, ' +
        'CURRENCY, DATE, TIME, DATE_TIME, SCIENTIFIC',
    );
    const typo = refusal({ numberFormat: { type: 'DATE', patern: 'dd.mm.yyyy' } });
    expect(typo.code).toBe('bad_request');
    expect(typo.detail).toContain('patern');
    expect(typo.detail).toContain(
      'Допустимые поля вида: bold, italic, underline, align, background, fontFamily, ' +
        'fontSize, numberFormat',
    );
  });
});

describe('Q12 — запрос repeatCell: маска и тело', () => {
  const write = async (format: CellFormat): Promise<sheets_v4.Schema$RepeatCellRequest> => {
    const g = google();
    await clientOf(g).batchUpdate(ID, [{ kind: 'format', sheetId: 4, row: 5, column: 1, format }]);
    return g.requests[0]?.repeatCell ?? {};
  };
  /** Маска как множество: порядок путей Google не важен. */
  const maskOf = (request: sheets_v4.Schema$RepeatCellRequest): string[] =>
    (request.fields ?? '').split(',').sort();

  it('Q12: шрифт, кегль и формат числа — в маске и в теле, ровно заданные поля', async () => {
    const request = await write({ ...CARLITO_10, numberFormat: DATE_DOTTED });
    expect(maskOf(request)).toEqual([
      'userEnteredFormat.numberFormat',
      'userEnteredFormat.textFormat.fontFamily',
      'userEnteredFormat.textFormat.fontSize',
    ]);
    expect(request.cell).toStrictEqual({
      userEnteredFormat: {
        textFormat: { fontFamily: 'Carlito', fontSize: 10 },
        numberFormat: { type: 'DATE', pattern: 'dd.mm.yyyy' },
      },
    });
    expect(request.range).toEqual({
      sheetId: 4,
      startRowIndex: 4,
      endRowIndex: 5,
      startColumnIndex: 1,
      endColumnIndex: 2,
    });
  });

  it('Q12: тип без шаблона уходит без шаблона; жирность — по-прежнему одна в маске', async () => {
    const typed = await write({ numberFormat: { type: 'NUMBER' } });
    expect(typed.fields).toBe('userEnteredFormat.numberFormat');
    expect(typed.cell).toStrictEqual({ userEnteredFormat: { numberFormat: { type: 'NUMBER' } } });
    const bold = await write({ bold: true });
    expect(bold.fields).toBe('userEnteredFormat.textFormat.bold');
    expect(bold.cell).toStrictEqual({ userEnteredFormat: { textFormat: { bold: true } } });
  });

  it('Q12: сброс null — поле в маске, значения в теле нет: так Google сбрасывает к виду листа', async () => {
    const reset = await write({ fontFamily: null, fontSize: null, numberFormat: null });
    expect(maskOf(reset)).toEqual([
      'userEnteredFormat.numberFormat',
      'userEnteredFormat.textFormat.fontFamily',
      'userEnteredFormat.textFormat.fontSize',
    ]);
    expect(reset.cell).toStrictEqual({ userEnteredFormat: {} });
    // Рядом с заданным полем сброс тоже только в маске: тело несёт одну жирность.
    const mixed = await write({ bold: true, fontFamily: null });
    expect(maskOf(mixed)).toEqual([
      'userEnteredFormat.textFormat.bold',
      'userEnteredFormat.textFormat.fontFamily',
    ]);
    expect(mixed.cell).toStrictEqual({ userEnteredFormat: { textFormat: { bold: true } } });
  });
});

describe('Q12 — сравнение видов: сброс и формат числа', () => {
  it('Q12: null и «поля нет» — один вид; формат числа — по типу и шаблону, порядок ключей не важен', () => {
    expect(formatKey({ fontFamily: null, fontSize: null, numberFormat: null })).toBe(
      formatKey(undefined),
    );
    expect(formatKey({ bold: true, fontFamily: null })).toBe(formatKey({ bold: true }));
    expect(formatKey({ numberFormat: { pattern: 'dd.mm.yyyy', type: 'DATE' } })).toBe(
      formatKey({ numberFormat: { type: 'DATE', pattern: 'dd.mm.yyyy' } }),
    );
    // А другой тип, шаблон, шрифт или кегль — другой вид.
    const dotted = formatKey({ numberFormat: DATE_DOTTED });
    expect(formatKey({ numberFormat: { type: 'DATE' } })).not.toBe(dotted);
    expect(formatKey({ numberFormat: { type: 'DATE_TIME', pattern: 'dd.mm.yyyy' } })).not.toBe(
      dotted,
    );
    expect(formatKey({ fontFamily: 'Carlito' })).not.toBe(formatKey({ fontFamily: 'Arial' }));
    expect(formatKey({ fontFamily: 'Carlito' })).not.toBe(formatKey(undefined));
    expect(formatKey({ fontSize: 10 })).not.toBe(formatKey({ fontSize: 11 }));
  });
});

describe('Q12 — правка вида через gc_apply', () => {
  const args = {
    op: 'formatCells',
    target: 'registry',
    where: { Проект: 'portfolio' },
    columns: ['Запуск'],
    format: { ...CARLITO_10, numberFormat: DATE_DOTTED },
  };
  const mask = [
    'userEnteredFormat.numberFormat',
    'userEnteredFormat.textFormat.fontFamily',
    'userEnteredFormat.textFormat.fontSize',
  ];

  it('Q12: {fontFamily: Carlito} на ячейке, уже Carlito, — no_change, записи нет', async () => {
    const g = google();
    const result = await callMcp(
      gcApply,
      { ...args, where: { Проект: 'G connect' }, format: { fontFamily: 'Carlito' }, dryRun: false },
      depsOf(g),
    );
    expect(result.data).toMatchObject({ status: 'no_change' });
    expect(g.requests).toHaveLength(0);
  });

  it('Q12: дата дописанной строки — план «было → станет», запись маской, вид в журнале', async () => {
    const g = google();
    const journalled: WriteRecord[] = [];
    const preview = await callMcp(gcApply, args, depsOf(g, journalled));
    expect(preview.data).toMatchObject({ status: 'preview' });
    const planned = (preview.data as ApplyOutcome).changes[0];
    expect(planned?.a1).toBe(`${TITLE}!B4`);
    expect(planned?.beforeFormat).toBeUndefined();
    expect(planned?.afterFormat).toEqual({ ...CARLITO_10, numberFormat: DATE_DOTTED });
    expect(g.requests).toHaveLength(0);

    const written = await callMcp(gcApply, { ...args, dryRun: false }, depsOf(g, journalled));
    expect(written.data).toMatchObject({ status: 'ok' });
    expect(g.requests).toHaveLength(1);
    expect((g.requests[0]?.repeatCell?.fields ?? '').split(',').sort()).toEqual(mask);
    expect(journalled[0]?.changes[0]?.afterFormat).toEqual({
      ...CARLITO_10,
      numberFormat: DATE_DOTTED,
    });
  });
});

describe('Q12 — откат шрифта, кегля и формата числа', () => {
  /** Лист фейка: строка «portfolio» после записи вида — колонки «Проект» и «Запуск». */
  const sheet = (project: CellFormat, launch: CellFormat): SheetSnapshot => ({
    title: TITLE,
    sheetId: 4,
    rows: [
      [{ value: 'Проект' }, { value: 'Запуск' }],
      [
        { value: 'portfolio', format: project },
        { value: '2026-10-19', format: launch },
      ],
    ],
  });

  type Formats = Pick<JournalChange, 'beforeFormat' | 'afterFormat'>;
  const change = (letter: 'A' | 'B', formats: Formats): JournalChange => ({
    a1: `${TITLE}!${letter}2`,
    column: letter === 'A' ? 'Проект' : 'Запуск',
    before: letter === 'A' ? 'portfolio' : '2026-10-19',
    after: letter === 'A' ? 'portfolio' : '2026-10-19',
    ...formats,
  });
  const record = (changes: readonly JournalChange[]): WriteRecord => ({
    at: new Date().toISOString(),
    account: 'default',
    targetId: ID,
    alias: 'registry',
    sheet: TITLE,
    op: 'formatCells',
    changes,
    revisionBefore: '1',
    revisionAfter: '2',
    correlationId: 'gc-fonts-1',
  });
  const undo = (client: FakeSheetsClient, written: WriteRecord) =>
    undoLast(client, ID, { recent: () => Promise.resolve([written]) });

  it('Q12: чего до правки не было — сбрасывается null, а что было — возвращается значением', async () => {
    const dated = { ...CARLITO_10, numberFormat: DATE_DOTTED };
    const client = new FakeSheetsClient(snapshot([sheet(CARLITO_10, dated)]));
    const outcome = await undo(
      client,
      record([
        // «Проект» был Arial 10 — откат вернёт Arial, а не сброс к виду листа.
        change('A', {
          beforeFormat: { fontFamily: 'Arial', fontSize: 10 },
          afterFormat: CARLITO_10,
        }),
        // У «Запуска» вида не было вовсе — нейтрального шрифта нет, откат сбрасывает.
        change('B', { afterFormat: dated }),
      ]),
    );
    expect(outcome.status).toBe('ok');
    expect(client.formatWrites).toStrictEqual([
      {
        kind: 'format',
        sheetId: 4,
        row: 2,
        column: 1,
        format: { fontFamily: null, fontSize: null, numberFormat: null },
      },
      {
        kind: 'format',
        sheetId: 4,
        row: 2,
        column: 0,
        format: { fontFamily: 'Arial', fontSize: 10 },
      },
    ]);
  });

  it('Q12: старая запись журнала (вид без шрифта) — откат там, где теперь читается шрифт', async () => {
    // Записано до D-26: журнал знает только жирность, а чтение теперь видит и Carlito 10.
    const client = new FakeSheetsClient(
      snapshot([sheet({ bold: true, ...CARLITO_10 }, CARLITO_10)]),
    );
    const outcome = await undo(client, record([change('A', { afterFormat: { bold: true } })]));
    expect(outcome.status).toBe('ok');
    // Вернулась только жирность: шрифта запись не задавала — его откат и не трогает.
    expect(client.formatWrites).toStrictEqual([
      { kind: 'format', sheetId: 4, row: 2, column: 0, format: { bold: false } },
    ]);
  });

  it('Q12: чужая правка записанного ключа — по-прежнему revision_conflict, ни одной записи', async () => {
    // Записали Carlito, а после записи кто-то вернул Arial: откат перетёр бы чужое.
    const client = new FakeSheetsClient(
      snapshot([sheet({ fontFamily: 'Arial', fontSize: 10 }, CARLITO_10)]),
    );
    await expect(
      undo(client, record([change('A', { afterFormat: CARLITO_10 })])),
    ).rejects.toMatchObject({
      payload: { code: 'revision_conflict', cause: 'format_changed_after_write' },
    });
    expect(client.formatWrites).toHaveLength(0);
  });
});

describe('Q12 — превью словами', () => {
  it('Q12: отчёт называет шрифт, кегль и формат числа словами, сброс — «шрифт листа»', () => {
    const formatChange = (a1: string, beforeFormat: CellFormat, afterFormat: CellFormat) => ({
      kind: 'format' as const,
      a1,
      column: 'Запуск',
      before: null,
      after: null,
      beforeFormat,
      afterFormat,
    });
    const outcome: ApplyOutcome = {
      status: 'preview',
      changes: [
        formatChange(
          `${TITLE}!B4`,
          { fontFamily: 'Arial', fontSize: 11 },
          {
            ...CARLITO_10,
            numberFormat: DATE_DOTTED,
          },
        ),
        formatChange(
          `${TITLE}!B5`,
          { numberFormat: { type: 'NUMBER' } },
          {
            fontFamily: null,
            fontSize: null,
            numberFormat: null,
          },
        ),
      ],
      assumptions: [],
      notes: [],
      questions: [],
      baseRevision: '1',
      revisionAfter: null,
      planId: 'abc123',
    };
    const html = renderPreview(outcome, {
      title: 'Превью: formatCells',
      spreadsheet: 'Реестр инфраструктуры ИИ-отдела',
      sheet: TITLE,
      alias: 'registry',
      revision: '1',
    });
    expect(html).toContain('шрифт Arial, кегль 11');
    expect(html).toContain('шрифт Carlito, кегль 10, формат DATE dd.mm.yyyy');
    expect(html).toContain('>формат NUMBER<');
    expect(html).toContain('шрифт листа, кегль листа, формат числа листа');
  });
});
