/**
 * Только шапка и `rows` строкой JSON (D-26, примеры Q17 и Q19).
 *
 * Q17. «Реестр инфраструктуры» выровнен по шрифту, кеглю и датам, но в «Аккаунтах» у заголовков
 * B2–D2 нет фона шапки #17365D: `includeHeader` красил шапку И данные одним видом, а оформить
 * одну строку шапки было нечем. Четвёртый способ выбора строк — `headerOnly: true`.
 *
 * Q19. У клиента сессии, выравнивающей реестр, после Reconnect осталась старая схема `gc_apply`:
 * `rows: {from, to}` уходил строкой, и ядро отвечало «rows: Expected object, received string».
 * Строка JSON разбирается и судится той же схемой, что объект; кривая строка — прежний отказ, с
 * названием ожидаемой формы.
 *
 * Граница судится через настоящий протокол MCP (`callMcp`): разбор ядра, схема `gc_apply` в
 * `tools/list`, конверт; запись — на фейке, который применяет вид к своему снимку.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { WriteRecord } from '../src/core/journal.js';
import { parseOperation } from '../src/core/ops.js';
import { formatRows } from '../src/core/sheets/format-op.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { rowSelectionOf } from '../src/core/sheets/row-selection.js';
import type {
  Cell,
  CellFormat,
  SheetSnapshot,
  SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import type { Registry } from '../src/core/targets.js';
import { applyInput, operationOf } from '../src/mcp/apply-schema.js';
import { gcApply, type ToolDeps } from '../src/mcp/tools.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp, protocolSession } from './fixtures/protocol.js';
import { FakeSheetsClient, row } from './fixtures/sheet.js';

const ID = '1ACCOUNTSheaderEEEEEEEEEEEEEEEEEEEE';
const TITLE = 'Аккаунты';
const NAVY = '#17365D';

/** Вид шапки шаблона: у A2 он есть, у B2–D2 — нет (так стоял лист живьём). */
const HEADER: CellFormat = { background: NAVY, bold: true };

const book = (sheet: SheetSnapshot): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Реестр инфраструктуры ИИ-отдела',
  revisionId: 'rev-1',
  sheets: [sheet],
});

/**
 * «Аккаунты»: название таблицы в строке 1, шапка во второй — фон только у A2, — и `count` строк
 * данных с третьей.
 */
function accountsSheet(count = 3): SheetSnapshot {
  const rows: Cell[][] = [
    row('Аккаунты ИИ-отдела', null, null, null),
    [{ value: 'Сервис', format: HEADER }, ...row('Логин', 'Владелец', 'Статус')],
  ];
  for (let n = 1; n <= count; n += 1) {
    rows.push(row(`сервис ${n}`, `login${n}`, 'Антон', 'активен'));
  }
  return { title: TITLE, sheetId: 4, rows };
}

/** Цель с конвертом правки вида; `maxCells` не задан — граница по умолчанию, 50. */
const registry = (maxCells?: number): Registry => ({
  targets: [
    {
      alias: 'acc',
      id: ID,
      type: 'sheet',
      allow: 'write',
      sheet: TITLE,
      headerRow: 2,
      key: ['Сервис'],
      auto: { ops: ['formatCells'], ...(maxCells === undefined ? {} : { maxCells }) },
    },
  ],
});

function harness(sheet: SheetSnapshot = accountsSheet(), maxCells?: number) {
  const client = new FakeSheetsClient(book(sheet));
  const drive = new FakeDriveClient();
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve(registry(maxCells)),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('rev-1'),
  };
  return { client, drive, deps, journalled };
}

/** Google недоступен: отказ обязан случиться на границе ядра, ДО чтения листа (урок L11). */
const withoutGoogle = (): ToolDeps => ({
  ...harness().deps,
  sheets: () => Promise.reject(new TypeError('Google тронут: отказ опоздал до чтения листа')),
});

/** Фон шапки на все четыре заголовка — без способа выбора строк. */
const NAVY_HEADERS = {
  op: 'formatCells',
  target: 'acc',
  columns: ['Сервис', 'Логин', 'Владелец', 'Статус'],
  format: { background: NAVY },
};

/** Вызов из Q17: тот же фон, только строка шапки. */
const headerCall = (extra: Record<string, unknown> = {}) => ({
  ...NAVY_HEADERS,
  headerOnly: true,
  ...extra,
});

/** Правка вида «Статус» жирным по номерам строк — `rows` в той форме, что прислал клиент. */
const spanCall = (rows: unknown, extra: Record<string, unknown> = {}) => ({
  op: 'formatCells',
  target: 'acc',
  columns: ['Статус'],
  format: { bold: true },
  rows,
  ...extra,
});

const addresses = (data: unknown): string[] =>
  (data as { changes: { a1: string }[] }).changes.map((change) => change.a1);

const planIdOf = (data: unknown): unknown => (data as { planId?: unknown }).planId;

const B2_D2 = ['Аккаунты!B2', 'Аккаунты!C2', 'Аккаунты!D2'];

describe('Q17 — только строка шапки: четвёртый способ выбора строк (D-26)', () => {
  it('Q17: headerOnly — правятся ровно ячейки шапки названных колонок (B2–D2), данные и строка над шапкой не тронуты', async () => {
    const { deps, client, journalled } = harness();
    const result = await callMcp(gcApply, headerCall({ dryRun: false }), deps);
    expect(result.data).toMatchObject({ status: 'ok' });
    // A2 уже с фоном шапки: ячейка, чей вид уже такой, в план не попадает.
    expect(addresses(result.data)).toEqual(B2_D2);
    expect((result.data as { changes: unknown[] }).changes[0]).toMatchObject({
      kind: 'format',
      column: 'Логин',
      // У заголовка значение — имя колонки, и правка вида его не меняет.
      before: 'Логин',
      after: 'Логин',
      afterFormat: { background: NAVY },
    });
    expect(client.formatWrites).toEqual(
      [1, 2, 3].map((column) => ({
        kind: 'format',
        sheetId: 4,
        row: 2,
        column,
        format: { background: NAVY },
      })),
    );
    expect(client.writes).toHaveLength(0);
    expect(journalled.map((record) => record.changes.length)).toEqual([3]);
    const sheet = (await client.getSpreadsheet()).sheets[0]!;
    expect(sheet.rows[1]!.map((cell) => cell.format?.background)).toEqual([NAVY, NAVY, NAVY, NAVY]);
    for (const line of [sheet.rows[0]!, ...sheet.rows.slice(2)]) {
      expect(line.map((cell) => cell.format)).toEqual([undefined, undefined, undefined, undefined]);
    }
  });

  it('Q17: headerOnly вместе с where, allRows или rows — отказ row_selection до обращения к Google, оба способа названы', async () => {
    const others: [Record<string, unknown>, string][] = [
      [{ where: { Сервис: 'сервис 1' } }, '(where, headerOnly)'],
      [{ allRows: true }, '(allRows, headerOnly)'],
      [{ rows: { from: 3, to: 4 } }, '(rows, headerOnly)'],
    ];
    for (const [other, named] of others) {
      const result = await callMcp(gcApply, headerCall(other), withoutGoogle());
      expect(result.error, named).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
      expect(result.error?.detail, named).toContain(named);
    }
  });

  it('Q17: headerOnly: true — ровно этот способ; headerOnly: false — не способ, и отказ без способа перечисляет четвёртый', async () => {
    expect(rowSelectionOf({ headerOnly: true })).toEqual({ headerOnly: true });
    expect(rowSelectionOf({ headerOnly: false, allRows: true })).toEqual({ allRows: true });
    for (const call of [NAVY_HEADERS, headerCall({ headerOnly: false })]) {
      const result = await callMcp(gcApply, call, withoutGoogle());
      expect(result.error, JSON.stringify(call)).toMatchObject({
        code: 'bad_request',
        cause: 'row_selection',
      });
      expect(result.error?.detail).toContain('headerOnly: true');
    }
  });

  it('Q17: headerOnly с includeHeader — то же самое, что без него: шапка одна, ячейки не двоятся', async () => {
    const { deps } = harness();
    const both = await callMcp(gcApply, headerCall({ includeHeader: true }), deps);
    const alone = await callMcp(gcApply, headerCall(), deps);
    expect(both.data).toMatchObject({ status: 'preview' });
    expect(addresses(both.data)).toEqual(B2_D2);
    expect(planIdOf(both.data)).toBe(planIdOf(alone.data));
    // Ядро без границы — то же: строка шапки в плане один раз.
    const sheet = book(accountsSheet());
    const data = buildSheetData(sheet, { sheet: TITLE, headerRow: 2 });
    const outcome = await formatRows(
      new FakeSheetsClient(sheet),
      data,
      { headerOnly: true },
      ['Логин'],
      { background: NAVY },
      { includeHeader: true },
    );
    expect(outcome.changes.map((change) => change.a1)).toEqual(['Аккаунты!B2']);
  });

  it('Q17: конверт — ячеек шапки столько, сколько колонок: 3 при maxCells 2 — код плана, записи нет', async () => {
    const tight = harness(accountsSheet(), 2);
    const over = await callMcp(gcApply, headerCall({ dryRun: false }), tight.deps);
    const data = over.data as { status: string; changes: unknown[]; planId: string | null };
    expect(data.status).toBe('confirm_required');
    expect(data.changes).toHaveLength(3);
    expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(JSON.stringify(over.data)).toContain('конверт цели разрешает 2');
    expect(tight.client.formatWrites).toHaveLength(0);
    expect(tight.journalled).toHaveLength(0);
    // Две колонки — в границе: пишутся с первой фразы.
    const within = await callMcp(
      gcApply,
      headerCall({ columns: ['Логин', 'Владелец'], dryRun: false }),
      tight.deps,
    );
    expect(within.data).toMatchObject({ status: 'ok' });
    expect(tight.client.formatWrites).toHaveLength(2);
  });

  it('Q17: лист из одной шапки — шапка правится: вопроса «нет строк данных» у headerOnly нет', async () => {
    const { deps } = harness(accountsSheet(0));
    const result = await callMcp(gcApply, headerCall(), deps);
    expect(result.data).toMatchObject({ status: 'preview' });
    expect(addresses(result.data)).toEqual(B2_D2);
  });

  it('Q17: строка над шапкой (название таблицы) не адресуется — rows с ней отказывает и называет headerOnly', async () => {
    const { deps, client } = harness();
    const result = await callMcp(
      gcApply,
      spanCall({ from: 1, to: 2 }, { columns: ['Логин'] }),
      deps,
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
    expect(result.error?.detail).toContain('headerOnly: true');
    expect(result.error?.detail).toContain('includeHeader');
    expect(client.formatWrites).toHaveLength(0);
  });

  it('Q17: tools/list — gc_apply объявляет headerOnly; allRows и includeHeader о нём знают', async () => {
    const session = await protocolSession(harness().deps);
    try {
      const { tools } = await session.client.listTools();
      const schema = tools.find((tool) => tool.name === 'gc_apply')?.inputSchema as {
        properties: Record<string, { type?: string; description?: string } | undefined>;
      };
      expect(schema.properties['headerOnly']).toMatchObject({ type: 'boolean' });
      expect(schema.properties['headerOnly']?.description).toContain('formatCells');
      expect(schema.properties['allRows']?.description).toContain('headerOnly');
      expect(schema.properties['includeHeader']?.description).toContain('headerOnly');
    } finally {
      await session.close();
    }
  });
});

describe('Q19 — rows строкой JSON: та же схема, что у формы (D-26)', () => {
  it('Q19: rows строкой JSON — та же правка, что объектом: план, код плана и запись', async () => {
    const { deps } = harness(accountsSheet(5));
    const asObject = await callMcp(gcApply, spanCall({ from: 3, to: 4 }), deps);
    const asText = await callMcp(gcApply, spanCall('{"from": 3, "to": 4}'), deps);
    expect(asText.data).toMatchObject({ status: 'preview' });
    expect(addresses(asText.data)).toEqual(['Аккаунты!D3', 'Аккаунты!D4']);
    expect(planIdOf(asText.data)).toBe(planIdOf(asObject.data));
    const written = harness(accountsSheet(5));
    const ok = await callMcp(
      gcApply,
      spanCall(' {"to": 4, "from": 3} ', { dryRun: false }),
      written.deps,
    );
    expect(ok.data).toMatchObject({ status: 'ok' });
    expect(written.client.formatWrites).toMatchObject([
      { row: 3, column: 3 },
      { row: 4, column: 3 },
    ]);
  });

  it('Q19: createSheet — rows строкой с массивом: то же превью и тот же код плана, что массивом', async () => {
    const X7 = {
      op: 'createSheet',
      target: 'Мой диск',
      name: 'Тест G connect',
      columns: ['domain', 'period_start'],
      rows: [['x.com', '2025-06-01']],
    };
    const { deps, drive } = harness();
    const asArray = await callMcp(gcApply, X7, deps);
    const asText = await callMcp(gcApply, { ...X7, rows: JSON.stringify(X7.rows) }, deps);
    expect(asText.data).toMatchObject({
      status: 'preview',
      notes: (asArray.data as { notes: string[] }).notes,
    });
    expect(planIdOf(asText.data)).toBe(planIdOf(asArray.data));
    expect(drive.created).toHaveLength(0);
  });

  it('Q19: кривая строка — прежний отказ bad_request до Google, с ожидаемой формой {from, to}', async () => {
    const form =
      ' rows у formatCells — {from, to}: номера строк листа включительно; объектом или той же ' +
      'формой строкой JSON.';
    // Не JSON — одна проблема, названная прямо, и форма: схема дальше строку не судит.
    const text = await callMcp(gcApply, spanCall('from 3 to 12'), withoutGoogle());
    expect(text.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(text.error?.detail).toBe(
      'Запрос операции «formatCells» не проходит проверку — rows: строка не разбирается как ' +
        `JSON.${form}`,
    );
    const crooked: [string, string][] = [
      ['[3, 12]', 'rows: Expected object, received array'],
      ['{"from": 3}', 'rows.to: Required'],
      ['{"from": 3, "to": 12, "step": 1}', "Unrecognized key(s) in object: 'step'"],
    ];
    for (const [rows, problem] of crooked) {
      const result = await callMcp(gcApply, spanCall(rows), withoutGoogle());
      expect(result.error, rows).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
      expect(result.error?.detail, rows).toContain(problem);
      expect(result.error?.detail, rows).toContain(form);
    }
    // Подсказка о форме rows — только при отказе про rows: отказ вида её не несёт.
    const aboutFormat = await callMcp(
      gcApply,
      spanCall({ from: 3, to: 4 }, { format: { bold: 'да' } }),
      withoutGoogle(),
    );
    expect(aboutFormat.error?.detail).toContain('Допустимые поля вида');
    expect(aboutFormat.error?.detail).not.toContain('rows у');
  });

  it('Q19: createSheet — строка не той формы: отказ с ожидаемой формой массива строк', async () => {
    const result = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'Мой диск', name: 'x', columns: ['a'], rows: '{"a": 1}' },
      withoutGoogle(),
    );
    expect(result.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(result.error?.detail).toContain('rows: Expected array, received object');
    expect(result.error?.detail).toContain('rows у createSheet — массив строк');
  });

  it('Q19: строка верной формы судится правилами ядра, как объект: from больше to, строки вне данных', async () => {
    const reversed = await callMcp(gcApply, spanCall('{"from": 10, "to": 5}'), withoutGoogle());
    expect(reversed.error).toMatchObject({ code: 'bad_request', cause: 'rows_reversed' });
    const { deps } = harness(accountsSheet(5));
    const outside = await callMcp(gcApply, spanCall('{"from": 3, "to": 70}'), deps);
    expect(outside.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
    expect(outside.error?.detail).toContain('данные — строки 3–7');
  });

  it('Q19: схема транспорта принимает rows строкой и отдаёт ядру ту же операцию; tools/list строку не предлагает', async () => {
    const transport = z.object(applyInput);
    const base = { op: 'formatCells', target: 'acc', columns: ['Статус'], format: { bold: true } };
    const carried = transport.safeParse({ ...base, rows: '{"from": 3, "to": 4}' });
    expect(carried.success, carried.error?.message).toBe(true);
    expect(operationOf(carried.data!)).toEqual(
      parseOperation({ ...base, rows: { from: 3, to: 4 } }),
    );
    const created = transport.safeParse({
      op: 'createSheet',
      target: 'root',
      name: 'x',
      columns: ['a'],
      rows: '[["x.com"]]',
    });
    expect(created.success, created.error?.message).toBe(true);
    // Модели формы называются прежние — число, строки таблицы, {from, to}: строка — запасной
    // путь для клиента со старой схемой, а не четвёртая форма.
    const session = await protocolSession(harness().deps);
    try {
      const { tools } = await session.client.listTools();
      const schema = tools.find((tool) => tool.name === 'gc_apply')?.inputSchema as {
        properties: Record<string, { anyOf?: { type?: string }[] } | undefined>;
      };
      expect(schema.properties['rows']?.anyOf?.map((form) => form.type)).toEqual([
        'integer',
        'array',
        'object',
      ]);
    } finally {
      await session.close();
    }
  });

  it('Q19: строкой принимается только rows — columns строкой и число строк insertTable строкой отклоняются, как прежде', async () => {
    const columns = await callMcp(
      gcApply,
      { ...spanCall({ from: 3, to: 4 }), columns: '["Статус"]' },
      withoutGoogle(),
    );
    expect(columns.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(columns.error?.detail).toContain('columns: Expected array, received string');
    const table = await callMcp(
      gcApply,
      { op: 'insertTable', target: 'acc', rows: '3', columns: 2 },
      withoutGoogle(),
    );
    expect(table.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
    expect(table.error?.detail).toContain('rows: Expected number, received string');
  });
});
