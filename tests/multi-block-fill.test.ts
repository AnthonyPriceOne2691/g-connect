/**
 * Лист из нескольких таблиц одна под другой — хотфикс 16.11 (весть сессии профиля work, слово
 * владельца «должно все срабатывать автоматически»).
 *
 * Случай сессии: смета, где под шапкой блока работ стоят пустые ячейки ввода часов, ниже — блок
 * сервисов с буквами вариантов и блок «Итоги» с формулами в той же колонке B. Шапка работ «владеет»
 * строками до конца листа, и запись трёх чисел в пустые ячейки отказывала дважды: колонку B держали
 * формулы «Итогов» (`write_blocked` без кода), колонку C — список «Вариант, A, B, C, D», выведенный
 * из блока сервисов (`not_in_enum`: ни плана, ни кода, и `force` не помогал).
 *
 * Теперь формулы судятся у ячеек записи (в ней или строкой выше), выведенный список — подсказка в
 * заметке, а поиск по условию формулами не держится. Ячейка с формулой и список из проверки данных
 * таблицы по-прежнему спрашивают человека. Все вызовы — через настоящий протокол (урок L26).
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { appendRow, type ApplyOutcome } from '../src/core/sheets/rows.js';
import { setCells } from '../src/core/sheets/set-cells-op.js';
import type {
  Cell,
  CellValue,
  SheetSnapshot,
  SpreadsheetSnapshot,
} from '../src/core/sheets/types.js';
import type { Registry } from '../src/core/targets.js';
import { gcApply, gcRead, type ToolDeps } from '../src/mcp/tools.js';
import { callMcp } from './fixtures/protocol.js';
import {
  FakeSheetsClient,
  formulaSheet,
  MutableSheetsClient,
  row,
  snapshot,
} from './fixtures/sheet.js';

const ID = '1MULTIblockAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHEET = 'Смета';
const formula = (text: string, value: CellValue = null): Cell => ({ value, formula: text });

/** Смета: параметры, работы (шапка в строке 6), сервисы с буквами вариантов, итоги с формулами в B. */
function estimate(): SheetSnapshot {
  const letters = ['A', 'B', 'C', 'D'];
  return {
    title: SHEET,
    sheetId: 5,
    rows: [
      row('Смета проекта'),
      row('Параметр', 'Значение', 'Единица'),
      row('Срок расчёта', 12, 'мес'),
      row(),
      row('Оценка работ'),
      row('Этап', 'Оптимистично, ч', 'Реалистично, ч', 'Пессимистично, ч', 'Оценка PERT, ч'),
      ...[7, 8, 9].map((n) =>
        row(
          ['Уточнение вводных и ТЗ', 'Сборка прототипа', 'Тесты'][n - 7]!,
          null,
          null,
          null,
          formula(`=(B${n}+4*C${n}+D${n})/6`, 0),
        ),
      ),
      row('Итого, ч', null, null, null, formula('=SUM(E7:E9)', 0)),
      row(),
      row('Сервисы'),
      row('Сервис', 'Тариф', 'Вариант'),
      ...Array.from({ length: 20 }, (_, i) => row(`сервис ${i + 1}`, 'месяц', letters[i % 4]!)),
      row(),
      row('Итоги'),
      ...[36, 37, 38].map((n) => row(`итог ${n}`, formula(`=SUM(B$7:B$9)*${n}`, 0))),
    ],
  };
}

const book = (sheet: SheetSnapshot): SpreadsheetSnapshot => ({
  id: ID,
  title: 'Книга',
  revisionId: '1',
  sheets: [sheet],
});

/** Цель реестра с конвертом на `setCells` — как разрешение проекта сессии: 50 ячеек с первой фразы. */
function harness(sheet: SheetSnapshot = estimate()) {
  const client = new MutableSheetsClient(book(sheet));
  const journalled: WriteRecord[] = [];
  const registry = {
    targets: [
      {
        alias: 'смета',
        id: ID,
        type: 'sheet',
        allow: 'write',
        sheet: SHEET,
        auto: { ops: ['setCells'] },
      },
    ],
  };
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => Promise.reject(new TypeError('Drive в этом сьюте нет')),
    registry: () => Promise.resolve(registry as Registry),
    journal: (record) => {
      journalled.push(record);
      return Promise.resolve();
    },
    journalSource: { recent: () => Promise.resolve([...journalled]) },
    revision: () => Promise.resolve('1'),
  };
  return { client, deps };
}

const call = (deps: ToolDeps, op: Record<string, unknown>) =>
  callMcp(gcApply, { target: 'смета', ...op }, deps);

const hours = {
  op: 'setCells',
  headerRow: 6,
  where: { Этап: 'Уточнение вводных и ТЗ' },
  values: { 'Оптимистично, ч': 16, 'Реалистично, ч': 24, 'Пессимистично, ч': 32 },
};

describe('лист из нескольких таблиц: числа в пустые ячейки блока — сами, в конверте', () => {
  it('Y1: карта видит то же, что видела сессия: формулы «Итогов» в B и выведенный список в C', async () => {
    const { deps } = harness();
    const read = await callMcp(gcRead, { target: 'смета', mode: 'map', headerRow: 6 }, deps);
    const map = read.data as { columns: Record<string, unknown>[] };
    const byName = new Map(map.columns.map((c) => [c['name'], c]));
    expect(byName.get('Оптимистично, ч')).toMatchObject({ hasFormula: true });
    expect(byName.get('Реалистично, ч')).toMatchObject({
      enumSource: 'inferred',
      enumValues: expect.arrayContaining(['A', 'B', 'C', 'D']) as unknown,
    });
  });

  it('Y1: B, C, D пишутся с первой фразы; превью называет чужие формулы и выведенный список', async () => {
    const { client, deps } = harness();
    const preview = await call(deps, hours);
    expect(preview.error).toBeUndefined();
    const plan = preview.data as ApplyOutcome;
    expect(plan.status).toBe('preview');
    expect(plan.changes.map((c) => [c.a1, c.after])).toEqual([
      ['Смета!B7', 16],
      ['Смета!C7', 24],
      ['Смета!D7', 32],
    ]);
    expect(plan.notes).toContain(
      'В колонке «Оптимистично, ч» формулы есть в других строках — у ячеек записи и строк над ними ' +
        'формул нет, запись их не затрагивает',
    );
    expect(plan.notes.join('\n')).toMatch(/«24» нет в списке, выведенном по уже записанному/);

    const written = await call(deps, { ...hours, dryRun: false });
    expect(written.error).toBeUndefined();
    expect((written.data as ApplyOutcome).status).toBe('ok');
    const after = (await client.getSpreadsheet(ID)).sheets[0]!.rows;
    expect(after[6]!.slice(1, 4).map((c) => c?.value)).toEqual([16, 24, 32]);
    // Формулы «Итогов» в B36:B38 на месте.
    expect(after.slice(35, 38).map((r) => r[1]?.formula)).toEqual([
      '=SUM(B$7:B$9)*36',
      '=SUM(B$7:B$9)*37',
      '=SUM(B$7:B$9)*38',
    ]);
  });
});

describe('настоящие защиты — как раньше', () => {
  it('Y2: ячейка с формулой (E7) — write_blocked; с force — только кодом плана', async () => {
    const { deps } = harness();
    const pert = { ...hours, values: { 'Оценка PERT, ч': 5 } };
    const blocked = await call(deps, pert);
    expect(blocked.error).toMatchObject({ code: 'write_blocked', cause: 'formula_column' });
    const forced = await call(deps, { ...pert, force: true, dryRun: false });
    // `force` снимает отказ, но не конверт: формулу затирает только код плана человека.
    const outcome = forced.data as ApplyOutcome;
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join('\n')).toMatch(/задевает формулу — это решает человек кодом плана/);
  });

  it('Y2: дозапись в вычисляемую колонку — формула строкой выше держит запись', async () => {
    const data = buildSheetData(snapshot([formulaSheet()]));
    await expect(
      appendRow(new FakeSheetsClient(snapshot([formulaSheet()])), data, { Проект: 'x', Итого: 3 }),
    ).rejects.toMatchObject({ payload: { code: 'write_blocked', cause: 'formula_column' } });
  });

  it('Y2: поиск по формульной колонке не пишет в неё — условие на «Итого» не отказ', async () => {
    const book = snapshot([formulaSheet()]);
    const outcome = await setCells(
      new FakeSheetsClient(book),
      buildSheetData(book),
      { Итого: 2 },
      {
        Часы: 3,
      },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.changes.map((c) => c.a1)).toEqual(['Итоги!B2']);
  });
});
