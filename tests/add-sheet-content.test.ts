/**
 * Новый лист со шапкой и строками (D-23, хотфикс 2026-11-11): «создай лист, сделай там шапку,
 * занеси данные» и «просто создай лист и внеси данные — без шапки, с A1 вниз».
 *
 * Запись — через настоящий протокол (урок L26), под разрешением проекта: таблица вне реестра
 * пишется с первой фразы в конверте по умолчанию (50 ячеек), больше — кодом плана. Фейк таблицы
 * применяет и геометрию, и значения (`MutableSheetsClient`), поэтому «лист появился со шапкой» и
 * «лист удалён откатом» — факты снимка, а не «метод вызвали». Журнал, как настоящий, отдаёт записи
 * ПО ЦЕЛИ.
 */

import { describe, expect, it } from 'vitest';

import { newGrant } from '../src/core/grant/document.js';
import type { WriteRecord } from '../src/core/journal.js';
import { planId } from '../src/core/plan.js';
import type { CellValue } from '../src/core/sheets/types.js';
import { gcApply, gcUndo, type ToolDeps } from '../src/mcp/tools.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp, protocolSession } from './fixtures/protocol.js';
import { MutableSheetsClient, reportSheet, snapshot } from './fixtures/sheet.js';

const PROJECT = '/Users/someone/Documents/reports';
/** Id книги фикстуры: ядро пишет и журналирует под id, который назвал снимок Google. */
const BOOK_ID = snapshot().id;
/** Таблица по ссылке, вне реестра: писать её даёт только разрешение проекта. */
const BOOK = `https://docs.google.com/spreadsheets/d/${BOOK_ID}/edit`;
const TITLE = 'Новый лист';

const HEADER = ['Дата', 'Сумма', 'Комментарий'];
/** Две строки по ширине шапки; пустая строка — пустая ячейка: она не в счёте непустых. */
const ROWS: CellValue[][] = [
  ['2026-11-01', 120, 'аванс'],
  ['2026-11-02', 80, ''],
];

interface Outcome {
  readonly status: string;
  readonly planId: string | null;
  readonly notes: readonly string[];
  readonly structural?: Record<string, unknown>;
  readonly correlationId?: string;
}

interface UndoData {
  readonly status: string;
  readonly structureUndone?: string;
}

interface Harness {
  readonly deps: ToolDeps;
  readonly client: MutableSheetsClient;
  readonly drive: FakeDriveClient;
  readonly journalled: WriteRecord[];
}

function harness(): Harness {
  const client = new MutableSheetsClient(snapshot([reportSheet()]));
  const drive = new FakeDriveClient();
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    project: PROJECT,
    grant: () =>
      Promise.resolve({ state: 'granted', grant: newGrant(PROJECT, 'default', new Date()) }),
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve({ targets: [] }),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: {
      recent: (targetId, limit) =>
        Promise.resolve(journalled.filter((r) => r.targetId === targetId).slice(-limit)),
    },
    revision: () => Promise.resolve('rev-1'),
  };
  return { deps, client, drive, journalled };
}

const addSheet = (fields: Record<string, unknown>) => ({
  op: 'addSheet',
  target: BOOK,
  title: TITLE,
  ...fields,
});

async function apply(h: Harness, fields: Record<string, unknown>): Promise<Outcome> {
  const result = await callMcp(gcApply, addSheet(fields), h.deps);
  expect(result.error).toBeUndefined();
  return result.data as Outcome;
}

async function refused(h: Harness, fields: Record<string, unknown>) {
  const result = await callMcp(gcApply, addSheet(fields), h.deps);
  expect(result.ok).toBe(false);
  return result.error;
}

async function undo(h: Harness, fields: Record<string, unknown> = {}) {
  return callMcp(gcUndo, { target: BOOK, ...fields }, h.deps);
}

const titles = async (h: Harness): Promise<string[]> =>
  (await h.client.sheetTitles()).map((sheet) => sheet.title);

/** Значения листа строка в строку, как их прочтёт Google; листа нет — `undefined`. */
async function grid(h: Harness, title = TITLE): Promise<CellValue[][] | undefined> {
  const book = await h.client.getSpreadsheet(BOOK_ID);
  return book.sheets.find((sheet) => sheet.title === title)?.rows.map((r) => r.map((c) => c.value));
}

/** Колонка `Компания` и `n` строк: ячеек — n + 1 (шапка тоже пишется). */
const tall = (n: number) => ({
  columns: ['Компания'],
  rows: Array.from({ length: n }, (_, i) => [`Компания ${i + 1}`]),
});

// Q49: addSheet с columns и rows — превью с шапкой и строками, код плана.
describe('превью нового листа со шапкой и строками', () => {
  it('шапка и строки — в заметках, сверка и число непустых — в плане, код плана; записи нет', async () => {
    const h = harness();
    const preview = await apply(h, { columns: HEADER, rows: ROWS });
    expect(preview.status).toBe('preview');
    expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(preview.notes).toEqual([
      'Шапка: Дата | Сумма | Комментарий',
      'Строк: 2, текстом (RAW):',
      '  2026-11-01 | 120 | аванс',
      '  2026-11-02 | 80 | ',
    ]);
    // Восемь непустых из девяти: пустая строка ячейку очищает, в листе её не будет.
    expect(preview.structural).toEqual({
      kind: 'addSheet',
      sheet: TITLE,
      title: TITLE,
      content: expect.stringMatching(/^[0-9a-f]{12}$/),
      count: 8,
    });
    expect(await titles(h)).toEqual(['Лист1']);
    expect(h.client.writes).toEqual([]);
    expect(h.journalled).toEqual([]);
  });

  it('код плана — от содержимого: другие строки, другой режим ввода, лист без содержимого — другой код', async () => {
    const h = harness();
    const base = await apply(h, { columns: HEADER, rows: ROWS });
    const codes = [
      base,
      await apply(h, { columns: HEADER, rows: [ROWS[0]!] }),
      await apply(h, { columns: HEADER, rows: ROWS, asText: false }),
      await apply(h, {}),
    ].map((outcome) => outcome.planId);
    expect(new Set(codes).size).toBe(4);
    // Строки строкой JSON (Q19) — то же содержимое и тот же код, что массивом.
    const asJson = await apply(h, { columns: HEADER, rows: JSON.stringify(ROWS) });
    expect(asJson.planId).toBe(base.planId);
  });

  it('сверка содержимого одна с новой таблицей: те же шапка и строки — та же сверка', async () => {
    const h = harness();
    const sheet = await apply(h, { columns: HEADER, rows: ROWS });
    const created = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'Мой диск', name: TITLE, columns: HEADER, rows: ROWS },
      h.deps,
    );
    const table = created.data as Outcome;
    expect(table.structural?.['content']).toBe(sheet.structural?.['content']);
    expect(table.notes).toEqual(sheet.notes);
  });

  it('tools/list называет columns, rows и asText полями addSheet', async () => {
    const session = await protocolSession(harness().deps);
    try {
      const { tools } = await session.client.listTools();
      const schema = tools.find((tool) => tool.name === 'gc_apply')?.inputSchema as {
        properties: Record<string, { description?: string } | undefined>;
      };
      for (const field of ['columns', 'rows', 'asText', 'title']) {
        expect(schema.properties[field]?.description, field).toContain('addSheet');
      }
    } finally {
      await session.close();
    }
  });
});

// Q49, Q50: шапка в строке 1 и строки под ней; только rows — данные с A1 без шапки.
describe('под разрешением проекта, в конверте — с первой фразы', () => {
  it('шапка — в строке 1, строки — со второй, текстом (RAW) в лист по имени в кавычках', async () => {
    const h = harness();
    const written = await apply(h, { columns: HEADER, rows: ROWS, dryRun: false });
    expect(written.status).toBe('ok');
    expect(written.notes).toContain('Шапка: Дата | Сумма | Комментарий');
    expect(await titles(h)).toEqual(['Лист1', TITLE]);
    expect(await grid(h)).toEqual([
      ['Дата', 'Сумма', 'Комментарий'],
      ['2026-11-01', 120, 'аванс'],
      ['2026-11-02', 80, null],
    ]);
    expect(h.client.writes).toEqual([
      { id: BOOK_ID, range: `'${TITLE}'!A1`, values: [HEADER, ...ROWS], input: 'raw' },
    ]);
    expect(h.journalled).toHaveLength(1);
    expect(h.journalled[0]).toMatchObject({
      op: 'addSheet',
      project: PROJECT,
      structure: { kind: 'addSheet', sheet: TITLE, title: TITLE, count: 8 },
    });
  });

  it('только rows — данные с A1 вниз, без шапки; null ячейку пропускает и в счёт не идёт', async () => {
    const h = harness();
    const rows = [
      ['a.com', 3],
      [null, 5],
    ];
    const written = await apply(h, { title: 'Данные', rows, dryRun: false });
    expect(written).toMatchObject({ status: 'ok', structural: { count: 3 } });
    expect(written.notes).toEqual(['Строк: 2, текстом (RAW):', '  a.com | 3', '   | 5']);
    expect(await grid(h, 'Данные')).toEqual(rows);
    expect(h.client.writes.map(({ range }) => range)).toEqual([`'Данные'!A1`]);
  });

  it('только columns — лист со шапкой и без строк', async () => {
    const h = harness();
    const written = await apply(h, { columns: ['Имя', 'Почта'], dryRun: false });
    expect(written).toMatchObject({ status: 'ok', notes: ['Шапка: Имя | Почта'] });
    expect(await grid(h)).toEqual([['Имя', 'Почта']]);
  });

  it('asText: false — как набрал бы человек (USER_ENTERED)', async () => {
    const h = harness();
    const written = await apply(h, { columns: HEADER, rows: ROWS, asText: false, dryRun: false });
    expect(written.status).toBe('ok');
    expect(written.notes).toContain('Строк: 2:');
    expect(h.client.writes.map(({ input }) => input)).toEqual(['user']);
  });

  it('имя с пробелом и апострофом: в кавычках, апостроф удвоен — значения ложатся в этот лист', async () => {
    const h = harness();
    const title = "План 'Б' на ноябрь";
    const written = await apply(h, { title, columns: ['Шаг'], rows: [['первый']], dryRun: false });
    expect(written.status).toBe('ok');
    expect(h.client.writes.map(({ range }) => range)).toEqual(["'План ''Б'' на ноябрь'!A1"]);
    expect(await grid(h, title)).toEqual([['Шаг'], ['первый']]);
  });
});

describe('конверт судит записываемые ячейки: 50 — с первой фразы, больше — кодом плана', () => {
  it('ровно 50 ячеек (шапка и 49 строк) — с первой фразы', async () => {
    const h = harness();
    expect((await apply(h, { ...tall(49), dryRun: false })).status).toBe('ok');
    expect(await grid(h)).toHaveLength(50);
  });

  it('51 ячейка — confirm_required с кодом плана и без записи; код человека — запись', async () => {
    const h = harness();
    const asked = await apply(h, { ...tall(50), dryRun: false });
    expect(asked.status).toBe('confirm_required');
    expect(asked.notes.at(-1)).toContain('51 ячеек, конверт цели разрешает 50');
    expect(asked.notes).toContain('  …и ещё 40');
    expect(await titles(h)).toEqual(['Лист1']);
    expect(h.client.writes).toEqual([]);
    const written = await apply(h, { ...tall(50), dryRun: false, confirm: asked.planId });
    expect(written.status).toBe('ok');
    expect(await grid(h)).toHaveLength(51);
  });

  it('ровно бюджет правки (200 ячеек) — не отказ, а план и код', async () => {
    const h = harness();
    expect((await apply(h, { ...tall(199), dryRun: false })).status).toBe('confirm_required');
  });
});

describe('отказы до создания листа', () => {
  it('rows не той формы — отказ схемы с ожидаемой формой, а не «незнакомое поле», как было до хотфикса', async () => {
    const h = harness();
    const error = await refused(h, { columns: ['a'], rows: [1, 2] });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(error?.detail).toContain(
      'rows у addSheet — массив строк, каждая — массив значений в порядке колонок шапки',
    );
    expect(await titles(h)).toEqual(['Лист1']);
  });

  it('имя из одних пробелов — отказ до чтения книги, листа нет', async () => {
    const h = harness();
    const error = await refused(h, { title: '   ', columns: HEADER, rows: ROWS, dryRun: false });
    expect(error).toMatchObject({ code: 'bad_request', detail: 'Имя листа не может быть пустым.' });
    expect(await titles(h)).toEqual(['Лист1']);
  });

  it('имя заняли между планом и записью — stale_value: второго листа нет, значения не писались', async () => {
    const h = harness();
    // Чужая сессия добавила лист с тем же именем, а проверка имени видела книгу до неё.
    await h.client.batchUpdate(BOOK_ID, [{ kind: 'addSheet', title: TITLE }]);
    const fresh = h.client.sheetTitles.bind(h.client);
    h.client.sheetTitles = async () => (await fresh()).filter((sheet) => sheet.title !== TITLE);
    const error = await refused(h, { columns: HEADER, rows: ROWS, dryRun: false });
    expect(error).toMatchObject({ code: 'stale_value', cause: 'anchor_moved' });
    const book = await h.client.getSpreadsheet(BOOK_ID);
    expect(book.sheets.map((sheet) => sheet.title)).toEqual(['Лист1', TITLE]);
    expect(h.client.writes).toEqual([]);
  });

  it('первая же строка длиннее шапки — вопрос человеку, а не догадка; листа нет', async () => {
    const h = harness();
    const error = await refused(h, { columns: ['a', 'b'], rows: [['1', '2', '3']], dryRun: false });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'row_wider_than_header' });
    expect(error?.detail).toContain('Строка 1 длиннее шапки (2 колонок)');
    expect(await titles(h)).toEqual(['Лист1']);
    expect(h.client.writes).toEqual([]);
  });

  it('сверх бюджета правки — отказ с советом дописать после; у новой таблицы совет прежний', async () => {
    const h = harness();
    const error = await refused(h, { ...tall(200), dryRun: false });
    expect(error).toMatchObject({ code: 'bad_request', cause: 'change_budget' });
    expect(error?.detail).toBe(
      'Содержимое — 201 ячеек при бюджете 200 на одну правку: создай лист с шапкой и допиши ' +
        'строки после (appendRow).',
    );
    expect(await titles(h)).toEqual(['Лист1']);
    const table = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'Мой диск', name: 'Таблица', ...tall(200) },
      h.deps,
    );
    expect(table.error?.detail).toContain('создай таблицу с шапкой');
  });
});

describe('сбой записи значений после создания листа', () => {
  it('лист удаляется, ответ — ошибка записи, строки журнала нет', async () => {
    const h = harness();
    h.client.updateValues = () => Promise.reject(new Error('квота'));
    const error = await refused(h, { columns: HEADER, rows: ROWS, dryRun: false });
    expect(error).toMatchObject({ code: 'internal', cause: 'квота' });
    // Удалён ИМЕННО новый лист: прежний на месте.
    expect(await titles(h)).toEqual(['Лист1']);
    expect(h.journalled).toEqual([]);
  });

  it('и удалить не вышло — write_outcome_unknown с именем листа, лист остался', async () => {
    const h = harness();
    h.client.updateValues = () => Promise.reject(new Error('квота'));
    const batch = h.client.batchUpdate.bind(h.client);
    h.client.batchUpdate = (id, requests) =>
      requests.some((request) => request.kind === 'deleteSheet')
        ? Promise.reject(new Error('сеть оборвалась'))
        : batch(id, requests);
    const error = await refused(h, { columns: HEADER, rows: ROWS, dryRun: false });
    expect(error).toMatchObject({
      code: 'write_outcome_unknown',
      cause: 'add_sheet_content_failed',
    });
    expect(error?.detail).toBe(
      `Лист «${TITLE}» добавлен, а шапка и строки в него не записались, и удалить лист не вышло. ` +
        'Проверь книгу: удали лист руками или допиши содержимое.',
    );
    expect(await titles(h)).toEqual(['Лист1', TITLE]);
    expect(h.journalled).toEqual([]);
  });

  it('у новой таблицы та же запись с уборкой: корзина не приняла — прежние текст и причина', async () => {
    const h = harness();
    h.client.updateValues = () => Promise.reject(new Error('квота'));
    h.drive.trash = () => Promise.reject(new Error('корзина недоступна'));
    const created = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'Мой диск', name: 'Таблица', columns: HEADER, dryRun: false },
      h.deps,
    );
    expect(created.error).toMatchObject({
      code: 'write_outcome_unknown',
      cause: 'create_content_failed',
      detail:
        'Таблица создана, а шапка и строки не записались, и в корзину она не ушла: ' +
        'https://drive.google.com/open?id=FILE1. Удали её руками или допиши содержимое.',
    });
  });
});

// Q52: откат addSheet — лист удалён; после правки человека — revision_conflict.
describe('откат нового листа с содержимым', () => {
  it('лист не правили — откат удаляет его вместе с записанным', async () => {
    const h = harness();
    await apply(h, { columns: HEADER, rows: ROWS, dryRun: false });
    const undone = await undo(h);
    expect(undone.data).toMatchObject({
      status: 'ok',
      structureUndone: `Лист «${TITLE}» удалён вместе с содержимым, записанным при создании (8 непустых ячеек).`,
    });
    expect(await titles(h)).toEqual(['Лист1']);
  });

  it.each([
    ['дописал ячейку', `'${TITLE}'!D4`, 'проверить', 9],
    ['стёр ячейку', `'${TITLE}'!A2`, '', 7],
  ])(
    'человек %s — revision_conflict, лист на месте; с force — удалён',
    async (_, a1, value, now) => {
      const h = harness();
      await apply(h, { columns: HEADER, rows: ROWS, dryRun: false });
      await h.client.updateValues(BOOK_ID, a1, [[value]]);
      const conflict = await undo(h);
      expect(conflict.error).toMatchObject({ code: 'revision_conflict', cause: 'sheet_changed' });
      expect(conflict.error?.detail).toBe(
        `На лист «${TITLE}» мы записали 8 непустых ячеек, сейчас их ${now}: лист правили после ` +
          'создания. Откат удалил бы его вместе с этой работой, поэтому не выполнен: перечитай и ' +
          'реши, что вернуть. Если удалить всё равно — откат с force.',
      );
      expect(await titles(h)).toEqual(['Лист1', TITLE]);
      const forced = await undo(h, { force: true });
      expect((forced.data as UndoData).status).toBe('ok');
      expect(await titles(h)).toEqual(['Лист1']);
    },
  );
});

describe('addSheet без содержимого — как раньше', () => {
  const plain = { title: 'Октябрь' };

  it('план прежний до байта кода: ни сверки, ни счёта, ни заметок', async () => {
    const h = harness();
    const preview = await apply(h, plain);
    const structural = { kind: 'addSheet', sheet: 'Октябрь', title: 'Октябрь' };
    expect(preview).toMatchObject({ status: 'preview', notes: [] });
    expect(preview.structural).toEqual(structural);
    expect(preview.planId).toBe(
      planId({
        targetId: BOOK_ID,
        sheet: 'Лист1',
        op: 'addSheet',
        cells: [],
        touches: [],
        structural,
      }),
    );
  });

  it('пустые rows — как без содержимого: тот же план, значения не пишутся', async () => {
    const h = harness();
    const plainPlan = await apply(h, plain);
    const empty = await apply(h, { ...plain, rows: [] });
    expect(empty).toMatchObject({ notes: [], structural: plainPlan.structural });
    expect(empty.planId).toBe(plainPlan.planId);
    expect((await apply(h, { ...plain, rows: [], dryRun: false })).status).toBe('ok');
    expect(h.client.writes).toEqual([]);
  });

  it('запись — пустой лист без записи значений; откат пустого — удалён, «он был пуст»', async () => {
    const h = harness();
    expect((await apply(h, { ...plain, dryRun: false })).status).toBe('ok');
    expect(h.client.writes).toEqual([]);
    expect(h.journalled[0]?.structure).toEqual({
      kind: 'addSheet',
      sheet: 'Октябрь',
      title: 'Октябрь',
    });
    const undone = await undo(h);
    expect((undone.data as UndoData).structureUndone).toBe('Лист «Октябрь» удалён — он был пуст.');
    expect(await titles(h)).toEqual(['Лист1']);
  });

  it('лист заполнили после создания — откат отказывает sheet_not_empty, с force — удаляет', async () => {
    const h = harness();
    await apply(h, { ...plain, dryRun: false });
    await h.client.updateValues(BOOK_ID, 'Октябрь!A1', [['итоги']]);
    const conflict = await undo(h);
    expect(conflict.error).toMatchObject({
      code: 'revision_conflict',
      cause: 'sheet_not_empty',
      detail:
        'На листе «Октябрь» после создания появились данные (1 непустых ячеек). Откат удалил бы ' +
        'лист вместе с ними, поэтому не выполнен.',
    });
    expect(await titles(h)).toEqual(['Лист1', 'Октябрь']);
    expect(((await undo(h, { force: true })).data as UndoData).status).toBe('ok');
    expect(await titles(h)).toEqual(['Лист1']);
  });
});
