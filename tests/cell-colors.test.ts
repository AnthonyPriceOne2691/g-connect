/**
 * Заливка и цвет текста (D-26, Q16, Q18): в «Аккаунтах» строки данных несут заливку строк-примеров
 * шаблона (#c1e4f5, #ffffff, #f4cccc), а у образца заливки нет вовсе; белый `#ffffff` её не снимает —
 * он прячет сетку. Заголовки B2–D2 — белым текстом от шаблона без синего фона #17365D, и карта
 * этого не видела: цвета текста ядро не читало.
 *
 * Шов судится на форме ответа Google (урок L28): у Google цвет лежит в ДВУХ полях — устаревшем
 * (`backgroundColor`, `foregroundColor`) и стиле (`…ColorStyle`), и стиль главнее. Заглушка отдаёт
 * `userEnteredFormat` такой формы и принимает `repeatCell`. Откат и сравнение видов — на фейках,
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

const ID = '1COLORaccountsEEEEEEEEEEEEEEEEEEEEEEE';
const TITLE = 'Аккаунты';

type GoogleCell = sheets_v4.Schema$CellData;
type GoogleFormat = sheets_v4.Schema$CellFormat;

/** `#17365d` → доли, как цвет отдаёт и принимает Google. */
function rgb(hex: string): sheets_v4.Schema$Color {
  const part = (at: number): number => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { red: part(1), green: part(3), blue: part(5) };
}

const WHITE = { red: 1, green: 1, blue: 1 };

/** Заливка, как её ставит шаблон сегодня: цвет и в устаревшем поле, и в стиле. */
const fill = (hex: string): GoogleFormat => ({
  backgroundColor: rgb(hex),
  backgroundColorStyle: { rgbColor: rgb(hex) },
});

/** Шапка шаблона: Carlito 11, жирный, белый текст — обоими полями цвета. */
const headerText = {
  bold: true,
  fontFamily: 'Carlito',
  fontSize: 11,
  foregroundColor: WHITE,
  foregroundColorStyle: { rgbColor: WHITE },
};

const text = (value: string, format?: GoogleFormat): GoogleCell => ({
  effectiveValue: { stringValue: value },
  formattedValue: value,
  ...(format === undefined ? {} : { userEnteredFormat: format }),
});

/** Строка данных: все четыре ячейки одним видом (или без вида). */
const dataRow = (values: readonly string[], format?: GoogleFormat): GoogleCell[] =>
  values.map((value) => text(value, format));

/**
 * «Аккаунты»: баннер, шапка во второй строке — A2 по образцу (фон #17365D), B2–D2 белым текстом
 * без фона; в данных — заливка строк-примеров шаблона, у образца (Anthropic) заливки нет.
 */
function accountRows(): GoogleCell[][] {
  const header = (value: string, format: GoogleFormat): GoogleCell => text(value, format);
  return [
    [text('Аккаунты и сервисы')],
    [
      header('Сервис', { ...fill('#17365d'), textFormat: headerText }),
      ...['Логин', 'Владелец', 'Статус'].map((name) => header(name, { textFormat: headerText })),
    ],
    dataRow(['Google Workspace', 'ai@corp.ru', 'Антон', 'активен'], fill('#c1e4f5')),
    // Старый шаблон: белая заливка только в устаревшем поле.
    dataRow(['GitHub', 'ai-corp', 'Антон', 'активен'], { backgroundColor: WHITE }),
    // Новый клиент: заливка только стилем, красный текст — только устаревшим полем.
    dataRow(['OpenAI', 'ai@corp.ru', 'Антон', 'пауза'], {
      backgroundColorStyle: { rgbColor: rgb('#f4cccc') },
      textFormat: { foregroundColor: rgb('#cc0000') },
    }),
    dataRow(['Anthropic', 'ai@corp.ru', 'Антон', 'активен']),
  ];
}

/** Номера строк диапазона: «'Лист'» — весь лист, «'Лист'!A5:ZZ9» — с 5 по 9. */
function rowsOf(range: string | undefined, total: number): [number, number] {
  const match = /!A(\d+):[A-Z]+(\d+)$/.exec(range ?? '');
  return match === null ? [1, total] : [Number(match[1]), Number(match[2])];
}

/** Google, отвечающий формой документации; правки вида — в `requests`, как их получил бы он. */
function google(rows: readonly GoogleCell[][] = accountRows()) {
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
            alias: 'accounts',
            id: ID,
            type: 'sheet',
            allow: 'write',
            sheet: TITLE,
            headerRow: 2,
            key: ['Сервис'],
            auto: { ops: ['formatCells'], maxCells: 8 },
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

/** Вид ячеек снимка — строка в строку, колонка в колонку. */
async function formatsOf(rows: readonly GoogleCell[][]): Promise<(CellFormat | undefined)[][]> {
  const book = await clientOf(google(rows)).getSpreadsheet(ID, { sheet: TITLE });
  return (book.sheets[0]?.rows ?? []).map((cells) => cells.map((cell) => cell.format));
}

describe('Q16, Q18 — шов: цвет из пары полей Google, стиль главнее', () => {
  it('Q16: шов — фон из стиля главнее устаревшего поля; без стиля — устаревшее поле', async () => {
    const formats = await formatsOf([
      [text('Сервис')],
      [
        // Поля разошлись: Google рисует стиль (документация: «takes precedence»).
        text('Google', {
          backgroundColor: WHITE,
          backgroundColorStyle: { rgbColor: rgb('#c1e4f5') },
        }),
        text('GitHub', { backgroundColor: rgb('#f4cccc') }),
        text('OpenAI', { backgroundColorStyle: { rgbColor: rgb('#17365d') } }),
      ],
    ]);
    expect(formats[1]).toEqual([
      { background: '#c1e4f5' },
      { background: '#f4cccc' },
      { background: '#17365d' },
    ]);
  });

  it('Q16: шов — фон темы (themeColor) не читается, даже рядом с устаревшим полем', async () => {
    const themed: GoogleFormat = {
      backgroundColor: rgb('#4285f4'),
      backgroundColorStyle: { themeColor: 'ACCENT1' },
      textFormat: { bold: true },
    };
    const formats = await formatsOf([[text('Сервис')], [text('Google', themed)]]);
    // Цвет темы у каждой книги свой: в #RRGGBB он не переводится, и устаревшее поле его не заменяет.
    expect(formats[1]?.[0]).toEqual({ bold: true });
  });

  it('Q18: шов — цвет текста из foregroundColorStyle, иначе из foregroundColor; тема не читается', async () => {
    const formats = await formatsOf([
      [text('Сервис')],
      [
        text('стиль', { textFormat: { foregroundColorStyle: { rgbColor: WHITE } } }),
        text('оба', {
          textFormat: { foregroundColor: {}, foregroundColorStyle: { rgbColor: WHITE } },
        }),
        text('устаревшее', { textFormat: { foregroundColor: rgb('#cc0000') } }),
        // Чёрный Google отдаёт без долей: нулевые поля цвета в ответе опускаются.
        text('чёрный', { textFormat: { foregroundColorStyle: { rgbColor: {} } } }),
        text('тема', {
          textFormat: {
            italic: true,
            foregroundColor: {},
            foregroundColorStyle: { themeColor: 'TEXT' },
          },
        }),
      ],
    ]);
    expect(formats[1]).toEqual([
      { textColor: '#ffffff' },
      { textColor: '#ffffff' },
      { textColor: '#cc0000' },
      { textColor: '#000000' },
      { italic: true },
    ]);
  });
});

describe('Q16, Q18 — запрос repeatCell: оба поля цвета в маске и в теле', () => {
  const write = async (format: CellFormat): Promise<sheets_v4.Schema$RepeatCellRequest> => {
    const g = google();
    await clientOf(g).batchUpdate(ID, [{ kind: 'format', sheetId: 4, row: 3, column: 1, format }]);
    return g.requests[0]?.repeatCell ?? {};
  };
  /** Маска как множество: порядок путей Google не важен. */
  const maskOf = (request: sheets_v4.Schema$RepeatCellRequest): string[] =>
    (request.fields ?? '').split(',').sort();
  const BACKGROUND_MASK = [
    'userEnteredFormat.backgroundColor',
    'userEnteredFormat.backgroundColorStyle',
  ];

  it('Q16: запись фона — устаревшее поле и стиль rgbColor, оба в маске и в теле', async () => {
    const request = await write({ background: '#17365D' });
    expect(maskOf(request)).toEqual(BACKGROUND_MASK);
    expect(request.cell).toStrictEqual({
      userEnteredFormat: {
        backgroundColor: rgb('#17365D'),
        backgroundColorStyle: { rgbColor: rgb('#17365D') },
      },
    });
  });

  it('Q16: сброс фона null — оба поля в маске, тело пустое: снимается и заливка стилем', async () => {
    const request = await write({ background: null });
    expect(maskOf(request)).toEqual(BACKGROUND_MASK);
    expect(request.cell).toStrictEqual({ userEnteredFormat: {} });
  });

  it('Q18: запись цвета текста — foregroundColor и foregroundColorStyle в маске и в textFormat', async () => {
    const request = await write({ bold: true, textColor: '#FFFFFF' });
    expect(maskOf(request)).toEqual([
      'userEnteredFormat.textFormat.bold',
      'userEnteredFormat.textFormat.foregroundColor',
      'userEnteredFormat.textFormat.foregroundColorStyle',
    ]);
    expect(request.cell).toStrictEqual({
      userEnteredFormat: {
        textFormat: {
          bold: true,
          foregroundColor: WHITE,
          foregroundColorStyle: { rgbColor: WHITE },
        },
      },
    });
  });

  it('Q18: сброс цвета текста null — оба пути в маске, в теле ни одного поля', async () => {
    const request = await write({ textColor: null, background: null });
    expect(maskOf(request)).toEqual([
      ...BACKGROUND_MASK,
      'userEnteredFormat.textFormat.foregroundColor',
      'userEnteredFormat.textFormat.foregroundColorStyle',
    ]);
    expect(request.cell).toStrictEqual({ userEnteredFormat: {} });
  });
});

type Payload = { code: string; cause?: string; detail: string };

/** Операция правки вида с данным `format` — как её пришлёт агент. */
const formatOp = (format: unknown) => ({
  op: 'formatCells',
  target: 'accounts',
  where: { Сервис: 'GitHub' },
  columns: ['Сервис'],
  format,
});

const parsedFormat = (format: unknown): unknown => {
  const op = parseOperation(formatOp(format));
  return op.op === 'formatCells' ? op.format : null;
};

const refusal = (format: unknown): Payload => {
  try {
    parseOperation(formatOp(format));
  } catch (error) {
    return (error as { payload: Payload }).payload;
  }
  throw new Error('ожидался отказ, а разбор прошёл');
};

describe('Q16, Q18 — граница gc_apply: слово "none" и отказы', () => {
  it('Q16: background "none" уходит в домен null — без заливки; #RRGGBB — как прислан', () => {
    expect(parsedFormat({ background: 'none' })).toStrictEqual({ background: null });
    expect(parsedFormat({ background: '#17365D', bold: true })).toStrictEqual({
      background: '#17365D',
      bold: true,
    });
  });

  it('Q18: textColor — #RRGGBB или "none" (null — цвет листа), рядом с другими полями', () => {
    expect(parsedFormat({ textColor: '#FFFFFF', bold: true })).toStrictEqual({
      textColor: '#FFFFFF',
      bold: true,
    });
    expect(parsedFormat({ textColor: 'none', background: 'none' })).toStrictEqual({
      textColor: null,
      background: null,
    });
  });

  it.each(['white', '#fff', '#17365D00', 'NONE', '', null, 0xffffff])(
    'Q16: фон %s — отказ bad_request с текстом «#RRGGBB или "none"»',
    (background) => {
      const payload = refusal({ background });
      expect(payload.code).toBe('bad_request');
      expect(payload.cause).toBe('schema_violation');
      expect(payload.detail).toContain('format.background: фон — #RRGGBB или "none" (без заливки)');
    },
  );

  it('Q18: незнакомый цвет текста — отказ; перечень допустимых полей вида называет textColor', () => {
    const payload = refusal({ textColor: 'white' });
    expect(payload.code).toBe('bad_request');
    expect(payload.detail).toContain(
      'format.textColor: цвет текста — #RRGGBB или "none" (цвет листа)',
    );
    expect(payload.detail).toContain(
      'Допустимые поля вида: bold, italic, underline, align, background, fontFamily, ' +
        'fontSize, numberFormat, textColor',
    );
  });
});

type Column = { name: string; headerFormat?: CellFormat; format?: CellFormat };

describe('Q16, Q18 — чтение через протокол: карта и values с withFormat', () => {
  it('Q18: карта — белый текст шапки без фона виден, у образца шапки — и фон', async () => {
    const result = await callMcp(gcRead, { target: 'accounts', mode: 'map' }, depsOf(google()));
    const columns = (result.data as { columns: Column[] }).columns;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    const carlito = { bold: true, fontFamily: 'Carlito', fontSize: 11, textColor: '#ffffff' };
    expect(byName['Сервис']?.headerFormat).toEqual({ ...carlito, background: '#17365d' });
    // B2–D2: белым по белому — ровно то, чего не было видно.
    for (const name of ['Логин', 'Владелец', 'Статус']) {
      expect(byName[name]?.headerFormat, name).toEqual(carlito);
    }
    expect(byName['Сервис']?.format).toEqual({ background: '#c1e4f5' });
  });

  it('Q18: gc_read values с withFormat — цвет текста и заливка стилем в formats', async () => {
    const result = await callMcp(
      gcRead,
      { target: 'accounts', mode: 'values', withFormat: true },
      depsOf(google()),
    );
    const data = result.data as { formats: { value: Record<string, CellFormat>[] } };
    const [workspace, github, openai, anthropic] = data.formats.value;
    expect(workspace?.['Логин']).toEqual({ background: '#c1e4f5' });
    expect(github?.['Логин']).toEqual({ background: '#ffffff' });
    expect(openai?.['Статус']).toEqual({ background: '#f4cccc', textColor: '#cc0000' });
    // Образец: заливки нет — и вида нет вовсе.
    expect(anthropic).toEqual({});
  });
});

describe('Q16, Q18 — правка через протокол: снять заливку, покрасить шапку', () => {
  const none = {
    op: 'formatCells',
    target: 'accounts',
    where: { Сервис: 'Google Workspace' },
    columns: ['Сервис', 'Логин'],
    format: { background: 'none' },
  };

  it('Q16: background "none" — план «фон → без заливки», запись сбросом обоих полей', async () => {
    const g = google();
    const journalled: WriteRecord[] = [];
    const preview = await callMcp(gcApply, none, depsOf(g, journalled));
    const planned = (preview.data as ApplyOutcome).changes;
    expect(planned.map((c) => c.a1)).toEqual([`${TITLE}!A3`, `${TITLE}!B3`]);
    expect(planned[0]?.beforeFormat).toEqual({ background: '#c1e4f5' });
    expect(planned[0]?.afterFormat).toStrictEqual({ background: null });
    expect(g.requests).toHaveLength(0);

    const written = await callMcp(gcApply, { ...none, dryRun: false }, depsOf(g, journalled));
    expect(written.data).toMatchObject({ status: 'ok' });
    expect(g.requests).toHaveLength(2);
    for (const request of g.requests) {
      expect(request.repeatCell?.fields).toBe(
        'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle',
      );
      expect(request.repeatCell?.cell).toStrictEqual({ userEnteredFormat: {} });
    }
    expect(journalled[0]?.changes[0]?.afterFormat).toStrictEqual({ background: null });
  });

  it('Q16: "none" там, где заливки нет (образец), — no_change, записи нет', async () => {
    const g = google();
    const result = await callMcp(
      gcApply,
      { ...none, where: { Сервис: 'Anthropic' }, dryRun: false },
      depsOf(g),
    );
    expect(result.data).toMatchObject({ status: 'no_change' });
    expect(g.requests).toHaveLength(0);
  });

  it('Q16: фон «transparent» через протокол — отказ до Google с текстом про "none"', async () => {
    const g = google();
    const result = await callMcp(
      gcApply,
      { ...none, format: { background: 'transparent' }, dryRun: false },
      depsOf(g),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.error)).toContain('#RRGGBB или \\"none\\" (без заливки)');
    expect(g.requests).toHaveLength(0);
  });

  it('Q18: шапка по образцу — фон #17365D и белый текст: план и запись обоими полями цвета', async () => {
    const g = google();
    const args = {
      ...none,
      where: { Сервис: 'Anthropic' },
      columns: ['Логин'],
      includeHeader: true,
      format: { background: '#17365D', textColor: '#FFFFFF' },
      dryRun: false,
    };
    const written = await callMcp(gcApply, args, depsOf(g));
    expect(written.data).toMatchObject({ status: 'ok' });
    const header = (written.data as ApplyOutcome).changes.find((c) => c.a1 === `${TITLE}!B2`);
    expect(header?.beforeFormat).toEqual({
      bold: true,
      fontFamily: 'Carlito',
      fontSize: 11,
      textColor: '#ffffff',
    });
    expect(header?.afterFormat).toMatchObject({ background: '#17365D', textColor: '#FFFFFF' });
    const request = g.requests.find((r) => r.repeatCell?.range?.startRowIndex === 1)?.repeatCell;
    expect((request?.fields ?? '').split(',')).toEqual(
      expect.arrayContaining([
        'userEnteredFormat.backgroundColorStyle',
        'userEnteredFormat.textFormat.foregroundColorStyle',
      ]),
    );
    expect(request?.cell?.userEnteredFormat?.textFormat?.foregroundColorStyle).toEqual({
      rgbColor: WHITE,
    });
  });
});

describe('Q16, Q18 — сравнение видов', () => {
  it('Q16: null и «фона нет» — один вид; белый #ffffff — не «фона нет»', () => {
    expect(formatKey({ background: null })).toBe(formatKey(undefined));
    expect(formatKey({ background: null, textColor: null, bold: true })).toBe(
      formatKey({ bold: true }),
    );
    expect(formatKey({ background: '#ffffff' })).not.toBe(formatKey(undefined));
    expect(formatKey({ background: '#ffffff' })).not.toBe(formatKey({ background: null }));
  });

  it('Q18: цвет сравнивается без регистра — #FFFFFF агента и #ffffff Google один вид', () => {
    expect(formatKey({ textColor: '#FFFFFF' })).toBe(formatKey({ textColor: '#ffffff' }));
    expect(formatKey({ background: '#17365D' })).toBe(formatKey({ background: '#17365d' }));
    // Другой цвет — другой вид; фон и цвет текста одного цвета — тоже разные виды.
    expect(formatKey({ textColor: '#ffffff' })).not.toBe(formatKey({ textColor: '#fffffe' }));
    expect(formatKey({ textColor: '#ffffff' })).not.toBe(formatKey({ background: '#ffffff' }));
  });
});

describe('Q16, Q18 — откат фона и цвета текста', () => {
  /** Лист фейка после записи: ячейка «GitHub» с данным видом. */
  const sheet = (format?: CellFormat): SheetSnapshot => ({
    title: TITLE,
    sheetId: 4,
    rows: [
      [{ value: 'Сервис' }],
      [format === undefined ? { value: 'GitHub' } : { value: 'GitHub', format }],
    ],
  });
  const change = (formats: Pick<JournalChange, 'beforeFormat' | 'afterFormat'>): JournalChange => ({
    a1: `${TITLE}!A2`,
    column: 'Сервис',
    before: 'GitHub',
    after: 'GitHub',
    ...formats,
  });
  const undo = (client: FakeSheetsClient, formats: Parameters<typeof change>[0]) =>
    undoLast(client, ID, {
      recent: () =>
        Promise.resolve([
          {
            at: new Date().toISOString(),
            account: 'default',
            targetId: ID,
            alias: 'accounts',
            sheet: TITLE,
            op: 'formatCells',
            changes: [change(formats)],
            revisionBefore: '1',
            revisionAfter: '2',
            correlationId: 'gc-colors-1',
          } satisfies WriteRecord,
        ]),
    });
  const formatWrite = (format: CellFormat) => ({
    kind: 'format',
    sheetId: 4,
    row: 2,
    column: 0,
    format,
  });

  it('Q16: фон, которого до правки не было, откат снимает (null), а не красит белым', async () => {
    const client = new FakeSheetsClient(snapshot([sheet({ background: '#17365d' })]));
    const outcome = await undo(client, { afterFormat: { background: '#17365d' } });
    expect(outcome.status).toBe('ok');
    expect(client.formatWrites).toStrictEqual([formatWrite({ background: null })]);
    // Сброс — «поля нет», как прочтёт Google: у ячейки не остаётся вида вовсе.
    expect((await client.getSpreadsheet()).sheets[0]?.rows[1]?.[0]?.format).toBeUndefined();
  });

  it('Q16: снятая заливка возвращается откатом прежним цветом шаблона', async () => {
    const client = new FakeSheetsClient(snapshot([sheet()]));
    const outcome = await undo(client, {
      beforeFormat: { background: '#c1e4f5' },
      afterFormat: { background: null },
    });
    expect(outcome.status).toBe('ok');
    expect(client.formatWrites).toStrictEqual([formatWrite({ background: '#c1e4f5' })]);
  });

  it('Q18: цвет текста, которого не было, откат сбрасывает; #FFFFFF записи и #ffffff чтения сходятся', async () => {
    // Агент прислал #FFFFFF, Google вернёт #ffffff: «вид изменили после записи» здесь ложь.
    const client = new FakeSheetsClient(snapshot([sheet({ bold: true, textColor: '#ffffff' })]));
    const outcome = await undo(client, { afterFormat: { textColor: '#FFFFFF' } });
    expect(outcome.status).toBe('ok');
    expect(client.formatWrites).toStrictEqual([formatWrite({ textColor: null })]);
    expect((await client.getSpreadsheet()).sheets[0]?.rows[1]?.[0]?.format).toEqual({ bold: true });
  });

  it('Q18: чужая правка цвета текста после записи — revision_conflict, ни одной записи', async () => {
    const client = new FakeSheetsClient(snapshot([sheet({ textColor: '#000000' })]));
    await expect(undo(client, { afterFormat: { textColor: '#FFFFFF' } })).rejects.toMatchObject({
      payload: { code: 'revision_conflict', cause: 'format_changed_after_write' },
    });
    expect(client.formatWrites).toHaveLength(0);
  });
});

describe('Q16, Q18 — превью словами', () => {
  const html = (beforeFormat: CellFormat, afterFormat: CellFormat): string => {
    const outcome: ApplyOutcome = {
      status: 'preview',
      changes: [
        {
          kind: 'format',
          a1: `${TITLE}!B2`,
          column: 'Логин',
          before: 'Логин',
          after: 'Логин',
          beforeFormat,
          afterFormat,
        },
      ],
      assumptions: [],
      notes: [],
      questions: [],
      baseRevision: '1',
      revisionAfter: null,
      planId: 'abc123',
    };
    return renderPreview(outcome, {
      title: 'Превью: formatCells',
      spreadsheet: 'Реестр инфраструктуры ИИ-отдела',
      sheet: TITLE,
      alias: 'accounts',
      revision: '1',
    });
  };

  it('Q16: отчёт называет снятую заливку «без заливки», прежнюю — «фон #c1e4f5»', () => {
    const page = html({ background: '#c1e4f5' }, { background: null });
    expect(page).toContain('>фон #c1e4f5<');
    expect(page).toContain('>без заливки<');
  });

  it('Q18: отчёт — «цвет текста #FFFFFF», сброс — «цвет текста листа»', () => {
    const page = html(
      { bold: true, textColor: '#FFFFFF' },
      { bold: true, textColor: null, background: '#17365D' },
    );
    expect(page).toContain('жирный, цвет текста #FFFFFF');
    expect(page).toContain('жирный, фон #17365D, цвет текста листа');
  });
});
