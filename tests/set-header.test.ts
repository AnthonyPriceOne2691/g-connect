/**
 * Подпись пустых ячеек строки шапки — `setHeader` (хотфикс, слово владельца 2026-11-11).
 *
 * Весть соседней сессии: лист создан `addSheet` и пуст, и шапку из шести колонок со строкой записать
 * было нельзя — `upsertRow` по именам отвечал «колонки нет, создавать её сама не буду», `appendRow`
 * ключами `(A)…(F)` — «в колонку без подписи и без значений не пишу — подпиши шапку», а подписать
 * шапку было нечем. Теперь шапка подписывается явной операцией с планом: только пустые ячейки,
 * текстом (RAW), откат возвращает пустоту.
 *
 * Все вызовы — через настоящий протокол (урок L26), под разрешением проекта, на фейке, применяющем
 * записи; запись текстом судит шов настоящего `GoogleSheetsClient` на заглушке Google.
 */

import type { drive_v3, sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import { GoogleSheetsClient } from '../src/core/google/sheets.js';
import { newGrant } from '../src/core/grant/document.js';
import type { WriteRecord } from '../src/core/journal.js';
import type { ApplyOutcome } from '../src/core/sheets/rows.js';
import type {
  CellValue,
  ReadOptions,
  SheetMap,
  SheetSnapshot,
  SheetsClient,
  SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import { gcApply, gcRead, gcUndo, type ToolDeps } from '../src/mcp/tools.js';
import { callMcp } from './fixtures/protocol.js';
import { MutableSheetsClient, row } from './fixtures/sheet.js';

const PROJECT = '/Users/someone/Documents/weekly-report';
const ID = '1HEADERsheetAAAAAAAAAAAAAAAAAAAAA';
/** Ссылка на таблицу вне реестра: писать в неё можно только под разрешением проекта. */
const TARGET = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
const SHEET = 'Задачи';

/** Шапка из шести колонок — как её просила соседняя сессия. */
const HEADER = ['№', 'Дата', 'Задача', 'Статус', 'Часы', 'Комментарий'];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Лист, только что созданный `addSheet`: ни одной ячейки. */
const emptySheet = (): SheetSnapshot => ({ title: SHEET, sheetId: 7, rows: [] });

/** A1 пуста, B1–F1 подписаны; в A — даты дней, как в отчёте по дням. */
function datedSheet(): SheetSnapshot {
  return {
    title: SHEET,
    sheetId: 7,
    rows: [
      row(null, 'Задача', 'Статус', 'Часы', 'Ссылка', 'Комментарий'),
      row('19.10.2026', 'Разбор писем', 'готово', 2, 'https://example.com/1', 'созвон'),
      row('20.10.2026', 'Сбор данных', 'в работе', 3, 'https://example.com/2', 'выгрузка'),
    ],
  };
}

const book = (sheet: SheetSnapshot): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Книга задач',
  revisionId: '1',
  sheets: [sheet],
});

/**
 * Фейк, применяющий записи. `onRead` — чужая правка между чтениями ОДНОГО вызова: план вызова
 * читает лист первым чтением, сверка «было» перед записью — вторым.
 */
class LiveSheets extends MutableSheetsClient {
  reads = 0;
  onRead: ((read: number) => Promise<void>) | undefined;

  override async getSpreadsheet(id?: string, options?: ReadOptions): Promise<SpreadsheetSnapshot> {
    this.reads += 1;
    await this.onRead?.(this.reads);
    return super.getSpreadsheet(id, options);
  }
}

/** Разрешение проекта и цель вне реестра: конверт по умолчанию — 50 ячеек с первой фразы. */
function harness(sheet: SheetSnapshot = emptySheet()) {
  const client = new LiveSheets(book(sheet));
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    project: PROJECT,
    grant: () =>
      Promise.resolve({ state: 'granted', grant: newGrant(PROJECT, 'default', new Date()) }),
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () => Promise.resolve({ targets: [] }),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('1'),
  };
  return { client, deps, journalled };
}

const call = (deps: ToolDeps, op: Record<string, unknown>) =>
  callMcp(gcApply, { target: TARGET, sheet: SHEET, ...op }, deps);

/** Ответ без ошибки — исход ядра. */
async function outcome(deps: ToolDeps, op: Record<string, unknown>): Promise<ApplyOutcome> {
  const result = await call(deps, op);
  expect(result.error).toBeUndefined();
  return result.data as ApplyOutcome;
}

/** Отказ — объект ошибки ядра. */
async function refusal(deps: ToolDeps, op: Record<string, unknown>) {
  const result = await call(deps, op);
  expect(result.ok).toBe(false);
  return result.error!;
}

const header = (fields: Record<string, unknown> = {}) => ({
  op: 'setHeader',
  columns: HEADER,
  ...fields,
});

/** План шапки из шести колонок: «∅ → подпись» по ячейке строки `rowNumber`. */
const planned = (rowNumber = 1) =>
  HEADER.map((label, i) => ({
    kind: 'set',
    a1: `${SHEET}!${LETTERS[i]}${rowNumber}`,
    column: label,
    before: null,
    after: label,
  }));

const mapOf = async (deps: ToolDeps): Promise<SheetMap> =>
  (await callMcp(gcRead, { target: TARGET, sheet: SHEET }, deps)).data as SheetMap;

/** Значения листа без пустых хвостов: фейк дописывает пустые ячейки, Google их не отдаёт. */
async function grid(client: SheetsClient): Promise<CellValue[][]> {
  const rows = (await client.getSpreadsheet(ID)).sheets[0]!.rows.map((cells) => {
    const values = cells.map((cell) => cell.value);
    while (values.length > 0 && values.at(-1) === null) values.pop();
    return values;
  });
  while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
  return rows;
}

const AMBIGUOUS = 'две колонки с одним именем сделали бы адресацию по имени неоднозначной';

// Q51: лист от addSheet пуст — шапка с первой фразы под разрешением, затем строки по именам.
describe('setHeader — шапка пустого листа (воспроизведение)', () => {
  it('превью: план A1:F1 «∅ → подпись», код плана и строка шапки; записи нет', async () => {
    const { client, deps, journalled } = harness();
    const preview = await outcome(deps, header());
    expect(preview.status).toBe('preview');
    expect(preview.changes).toEqual(planned());
    expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(preview.assumptions).toEqual([
      'Строка шапки — 1 (данных нет — шапкой считается первая строка)',
    ]);
    expect(preview.notes).toEqual([]);
    expect(await grid(client)).toEqual([]);
    expect(journalled).toEqual([]);
  });

  it('под разрешением проекта — с первой фразы: подписи в строке 1, журнал с проектом и кодом', async () => {
    const { client, deps, journalled } = harness();
    const written = await outcome(deps, header({ dryRun: false }));
    expect(written.status).toBe('ok');
    expect(written.changes).toEqual(planned());
    expect(await grid(client)).toEqual([HEADER]);
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toMatchObject({
      op: 'setHeader',
      sheet: SHEET,
      project: PROJECT,
      planId: written.planId,
      correlationId: written.correlationId,
      changes: planned().map(({ a1, column, before, after }) => ({ a1, column, before, after })),
    });
  });

  it('сквозной: до подписи строку по именам не записать; после — appendRow пишет строку 2, карта видит шапку', async () => {
    const { client, deps } = harness();
    const values = {
      '№': '1',
      Дата: 'вторник',
      Задача: 'Сверка шапки',
      Статус: 'в работе',
      Часы: 2,
      Комментарий: 'после подписи',
    };
    // Воспроизведение: колонок нет — строку по именам писать некуда, и молча они не создаются.
    const before = await outcome(deps, {
      op: 'upsertRow',
      key: { '№': '1' },
      values,
      dryRun: false,
    });
    expect(before.status).toBe('needs_clarification');
    expect(before.questions[0]?.detail).toBe(
      `Колонки «№» в листе «${SHEET}» нет. Создавать её сама не буду.`,
    );

    expect((await outcome(deps, header({ dryRun: false }))).status).toBe('ok');
    const appended = await outcome(deps, { op: 'appendRow', values, dryRun: false });
    expect(appended.status).toBe('ok');
    expect(appended.changes.map((change) => change.a1)).toEqual(
      LETTERS.map((letter) => `${SHEET}!${letter}2`),
    );
    expect(await grid(client)).toEqual([
      HEADER,
      ['1', 'вторник', 'Сверка шапки', 'в работе', 2, 'после подписи'],
    ]);

    const map = await mapOf(deps);
    expect(map).toMatchObject({ headerRow: 1, headerRowConfident: true, dataRowCount: 1 });
    expect(map.columns.map((column) => `${column.letter} ${column.name}`)).toEqual(
      HEADER.map((label, i) => `${LETTERS[i]} ${label}`),
    );
    expect(map.unlabeled).toBeUndefined();
  });

  it('headerRow вызова — подписи в эту строку: над шапкой стоит название листа', async () => {
    const { deps } = harness({ ...emptySheet(), rows: [row('Недельный отчёт')] });
    const preview = await outcome(deps, header({ headerRow: 2 }));
    expect(preview.changes).toEqual(planned(2));
    expect(preview.assumptions).toEqual(['Строка шапки — 2 (строка заголовков задана вызывающим)']);
  });

  it('подписи — без пробелов по краям; startColumn — буква в любом регистре, до ZZZ', async () => {
    const { deps } = harness();
    const trimmed = await outcome(deps, { op: 'setHeader', columns: [' № ', 'Дата  '] });
    expect(trimmed.changes.map((change) => [change.a1, change.after])).toEqual([
      [`${SHEET}!A1`, '№'],
      [`${SHEET}!B1`, 'Дата'],
    ]);
    for (const [startColumn, a1] of [
      ['c', 'C1'],
      ['az', 'AZ1'],
      ['ZZZ', 'ZZZ1'],
    ]) {
      const preview = await outcome(deps, { op: 'setHeader', columns: ['Итог'], startColumn });
      expect(preview.changes.map((change) => change.a1)).toEqual([`${SHEET}!${a1}`]);
    }
  });
});

// Q51: «A1 пуста, B1–F1 подписаны» — startColumn: "A", колонка дальше по имени.
describe('setHeader — колонка без подписи получает имя (startColumn)', () => {
  it('A1 пуста, B1–F1 подписаны: «Дата» в A — ключ (A) больше не нужен, колонка по имени', async () => {
    const { client, deps } = harness(datedSheet());
    const before = await mapOf(deps);
    expect(before.headerRow).toBe(1);
    expect(before.unlabeled?.map((column) => column.key)).toEqual(['(A)']);
    // Пустая колонка без значений подписывается без оговорки: ключ на листе был только у (A).
    const plain = await outcome(deps, { op: 'setHeader', columns: ['Итог'], startColumn: 'G' });
    expect(plain.changes.map((change) => change.a1)).toEqual([`${SHEET}!G1`]);
    expect(plain.notes).toEqual([]);

    const written = await outcome(deps, {
      op: 'setHeader',
      columns: ['Дата'],
      startColumn: 'A',
      dryRun: false,
    });
    expect(written.status).toBe('ok');
    expect(written.changes).toEqual([
      { kind: 'set', a1: `${SHEET}!A1`, column: 'Дата', before: null, after: 'Дата' },
    ]);
    expect(written.assumptions).toEqual(['Строка шапки — 1 (строка 1: 5 подписей, ниже данные)']);
    expect(written.notes).toEqual([
      '(A) — колонка без подписи со значениями: после записи это колонка «Дата», ключ (A) ' +
        'больше не нужен — пиши по имени',
    ]);

    const map = await mapOf(deps);
    expect(map.columns[0]).toMatchObject({ name: 'Дата', letter: 'A', type: 'date' });
    expect(map.unlabeled).toBeUndefined();

    // По имени — пишется; ключом — вопрос с подписью колонки, а не запись.
    const byName = await outcome(deps, {
      op: 'setCells',
      where: { Задача: 'Сбор данных' },
      values: { Дата: '21.10.2026' },
      dryRun: false,
    });
    expect(byName.status).toBe('ok');
    expect(byName.changes).toEqual([
      { kind: 'set', a1: `${SHEET}!A3`, column: 'Дата', before: '20.10.2026', after: '21.10.2026' },
    ]);
    const byKey = await outcome(deps, { op: 'appendRow', values: { '(A)': '22.10.2026' } });
    expect(byKey.status).toBe('needs_clarification');
    expect(byKey.questions[0]).toMatchObject({
      field: '(A)',
      detail:
        'У A есть подпись «Дата» — пиши по ней: ключ в скобках бывает только у колонки без ' +
        'подписи в шапке.',
      candidates: ['Дата'],
    });
    expect((await grid(client))[2]?.[0]).toBe('21.10.2026');
  });
});

// Q52: занятая ячейка шапки и повтор подписи — отказ, записи нет.
describe('setHeader — отказы до плана: ничего не записано', () => {
  it('занятая ячейка шапки — bad_request с адресами и текстом всех занятых', async () => {
    const { client, deps, journalled } = harness(datedSheet());
    const before = await grid(client);
    const error = await refusal(deps, {
      op: 'setHeader',
      columns: ['Дата', 'Тема', 'Итог'],
      dryRun: false,
    });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'header_cell_occupied' });
    expect(error.detail).toBe(
      'Ячейки шапки заняты: B1 «Задача», C1 «Статус» (лист «Задачи», строка шапки 1). Ничего не ' +
        'записано: setHeader подписывает только пустые ячейки, занятую не перезаписывает. Колонки ' +
        'шапки с буквами — в карте (gc_read mode=map): сдвинь startColumn к пустым ячейкам или ' +
        'спроси человека, что делать с занятыми.',
    );
    expect(await grid(client)).toEqual(before);
    expect(journalled).toEqual([]);
  });

  it('повтор подписи между собой — отказ с повторами, первым написанием, без учёта регистра', async () => {
    const { client, deps } = harness();
    const error = await refusal(deps, {
      op: 'setHeader',
      columns: ['Дата', 'Тема', 'дата', 'Итог', 'ИТОГ', 'итог'],
      dryRun: false,
    });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'header_label_duplicate' });
    expect(error.detail).toBe(
      'Подписи в columns повторяются (без учёта регистра): «Дата», «Итог». Ничего не записано: ' +
        `${AMBIGUOUS} — у каждой колонки своё имя.`,
    );
    expect(await grid(client)).toEqual([]);
  });

  it('повтор подписи, которая уже стоит в шапке, — отказ с её ячейкой, без учёта регистра', async () => {
    const { client, deps } = harness(datedSheet());
    const before = await grid(client);
    const error = await refusal(deps, {
      op: 'setHeader',
      columns: ['статус', 'Итог', 'ЧАСЫ'],
      startColumn: 'G',
      dryRun: false,
    });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'header_label_duplicate' });
    expect(error.detail).toBe(
      'Подпись уже есть в шапке (без учёта регистра): «статус» — уже C1 «Статус», «ЧАСЫ» — уже D1 ' +
        `«Часы». Ничего не записано: ${AMBIGUOUS} — спроси человека, как назвать новую колонку.`,
    );
    expect(await grid(client)).toEqual(before);
  });

  it('пустая подпись — отказ с её номером', async () => {
    const { client, deps } = harness();
    const error = await refusal(deps, { op: 'setHeader', columns: ['№', '   '], dryRun: false });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'header_label_empty' });
    expect(error.detail).toBe(
      'Подпись 2 в columns пустая — одни пробелы. Ничего не записано: пустой подписью ячейку шапки ' +
        'не подписать — убери её или спроси человека, как назвать колонку.',
    );
    expect(await grid(client)).toEqual([]);
  });

  it.each([
    ['пустой список подписей', { columns: [] }],
    ['пустая строка подписи', { columns: [''] }],
    ['startColumn — пусто', { startColumn: '' }],
    ['startColumn — цифра', { startColumn: '1' }],
    ['startColumn — адрес ячейки', { startColumn: 'A1' }],
    ['startColumn — цифра впереди', { startColumn: '1A' }],
    ['startColumn — правее ZZZ', { startColumn: 'ABCD' }],
  ])('схема: %s — schema_violation до чтения листа', async (_, fields) => {
    const { client, deps } = harness();
    const error = await refusal(deps, { ...header(), ...fields });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(client.reads).toBe(0);
  });

  it('startColumn не по форме — отказ называет форму', async () => {
    const { deps } = harness();
    const error = await refusal(deps, header({ startColumn: 'A1' }));
    expect(error.detail).toBe(
      'Запрос операции «setHeader» не проходит проверку — startColumn: буква колонки — от A до ZZZ.',
    );
  });

  it('expectRevision старше листа — revision_conflict, записи нет', async () => {
    const { client, deps } = harness();
    const error = await refusal(deps, header({ dryRun: false, expectRevision: '0' }));
    expect(error).toMatchObject({ code: 'revision_conflict' });
    expect(await grid(client)).toEqual([]);
  });
});

// Q52: откат setHeader — ячейки шапки снова пусты.
describe('setHeader — конверт, предусловие и откат', () => {
  it('больше 50 ячеек — confirm_required с планом и кодом; запись — этим кодом', async () => {
    const { client, deps } = harness();
    const labels = Array.from({ length: 51 }, (_, i) => `Колонка ${i + 1}`);
    const asked = await outcome(deps, { op: 'setHeader', columns: labels, dryRun: false });
    expect(asked.status).toBe('confirm_required');
    expect(asked.changes).toHaveLength(51);
    expect(asked.changes.at(-1)?.a1).toBe(`${SHEET}!AY1`);
    expect(asked.notes).toEqual([
      'Правка трогает 51 ячеек, конверт цели разрешает 50 за раз (maxCells) — показан план, ' +
        `записать можно кодом плана. Записи не было. Код плана — ${asked.planId}: покажи человеку ` +
        'план и код, и передай код обратно в confirm.',
    ]);
    expect(await grid(client)).toEqual([]);

    const confirm = asked.planId;
    const written = await outcome(deps, {
      op: 'setHeader',
      columns: labels,
      dryRun: false,
      confirm,
    });
    expect(written.status).toBe('ok');
    expect(await grid(client)).toEqual([labels]);
  });

  it('откат возвращает пустоту: ячейки шапки снова пусты, строка журнала — откат этой записи', async () => {
    const { client, deps, journalled } = harness();
    await outcome(deps, header({ dryRun: false }));
    const undone = await callMcp(gcUndo, { target: TARGET }, deps);
    expect(undone.data).toMatchObject({
      status: 'ok',
      restored: planned()
        .reverse()
        .map(({ a1, column }) => ({ a1, column, kind: 'value', value: null })),
    });
    expect(await grid(client)).toEqual([]);
    expect(journalled.at(-1)).toMatchObject({ op: 'undo', undoOf: journalled[0]?.correlationId });
  });

  it('ячейку заняли между превью и записью — план строится заново: отказ с занятой, записи нет', async () => {
    const { client, deps, journalled } = harness();
    const preview = await outcome(deps, header());
    await client.updateValues(ID, `${SHEET}!C1`, [['Тема']]);
    const error = await refusal(deps, header({ dryRun: false, confirm: preview.planId }));
    expect(error).toMatchObject({ code: 'bad_request', cause: 'header_cell_occupied' });
    expect(error.detail).toContain(
      'Ячейки шапки заняты: C1 «Тема» (лист «Задачи», строка шапки 1).',
    );
    expect(await grid(client)).toEqual([[null, null, 'Тема']]);
    expect(journalled).toEqual([]);
  });

  it('ячейку заняли между планом и записью одного вызова — stale_value, ничего не записано', async () => {
    const { client, deps, journalled } = harness();
    // Второе чтение вызова — сверка «было» перед записью: человек как раз подписал C1 сам.
    client.onRead = async (read) => {
      if (read === 2) await client.updateValues(ID, `${SHEET}!C1`, [['Тема']]);
    };
    const error = await refusal(deps, header({ dryRun: false }));
    expect(error).toMatchObject({ code: 'stale_value', cause: 'value_changed_after_preview' });
    expect(error.detail).toBe(
      `Ячейка ${SHEET}!C1 (Задача): превью строилось на «», сейчас там «Тема». Запись не ` +
        'выполнена — перечитай и подтверди новый план.',
    );
    expect(client.reads).toBe(2);
    expect(await grid(client)).toEqual([[null, null, 'Тема']]);
    expect(journalled).toEqual([]);
  });
});

/**
 * Google, отвечающий формой документации: сетка листа — строки текста; запросы `values.batchUpdate`
 * — в `bodies` и в сетку, иначе вторая правка не увидела бы подписанную шапку.
 */
function google() {
  const cells: string[][] = [];
  const bodies: unknown[] = [];
  const properties = {
    sheetId: 7,
    title: SHEET,
    gridProperties: { rowCount: 1000, columnCount: 26 },
  };
  const cell = (value: string | undefined) =>
    value === undefined ? {} : { effectiveValue: { stringValue: value }, formattedValue: value };
  const sheets = {
    spreadsheets: {
      get: (params: { includeGridData?: boolean }) =>
        Promise.resolve({
          data: {
            properties: { title: 'Книга задач' },
            sheets: [
              params.includeGridData === true
                ? {
                    properties,
                    data: [
                      {
                        startRow: 0,
                        rowData: cells.map((line) => ({ values: Array.from(line, cell) })),
                      },
                    ],
                  }
                : { properties },
            ],
          },
        }),
      values: {
        batchUpdate: (params: {
          requestBody: { data: { range: string; values: string[][] }[] };
        }) => {
          bodies.push(params.requestBody);
          for (const { range, values } of params.requestBody.data) {
            const [, letter = 'A', number = '1'] = /!([A-Z])(\d+)$/.exec(range) ?? [];
            const line = (cells[Number(number) - 1] ??= []);
            line[letter.charCodeAt(0) - 65] = String(values[0]?.[0]);
          }
          return Promise.resolve({ data: {} });
        },
      },
    },
  } as unknown as sheets_v4.Sheets;
  const drive = {
    files: { get: () => Promise.resolve({ data: { version: '1' } }) },
  } as unknown as drive_v3.Drive;
  return { client: new GoogleSheetsClient({ accessToken: 'нет', api: { sheets, drive } }), bodies };
}

describe('setHeader — шов: подписи уходят текстом (RAW), строки — как набрал бы человек', () => {
  it('«2026» и «=итог» — подписями (RAW); строка по этим именам — USER_ENTERED', async () => {
    const stub = google();
    const deps: ToolDeps = { ...harness().deps, sheets: () => Promise.resolve(stub.client) };
    const labels = ['Дата', '2026', '=итог'];
    expect((await outcome(deps, { op: 'setHeader', columns: labels, dryRun: false })).status).toBe(
      'ok',
    );
    const values = { Дата: 'вторник', '2026': 'план', '=итог': 'семь' };
    expect((await outcome(deps, { op: 'appendRow', values, dryRun: false })).status).toBe('ok');
    expect(stub.bodies).toEqual([
      {
        valueInputOption: 'RAW',
        data: labels.map((label, i) => ({ range: `${SHEET}!${LETTERS[i]}1`, values: [[label]] })),
      },
      {
        // Имя-число идёт первым: так JavaScript перечисляет ключи объекта значений.
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${SHEET}!B2`, values: [['план']] },
          { range: `${SHEET}!A2`, values: [['вторник']] },
          { range: `${SHEET}!C2`, values: [['семь']] },
        ],
      },
    ]);
  });
});
