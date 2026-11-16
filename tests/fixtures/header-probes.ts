/**
 * Пробы правил шапки (хотфикс PR #23, D-26) — отдельным модулем, как `upload-probes.ts`: реестр
 * проб в policy.test.ts у предела длины. Структурный оракул «у КАЖДОГО правила есть проба — и
 * наоборот» судит реестр целиком.
 */

import { expect } from 'vitest';

import type { WriteRecord } from '../../src/core/journal.js';
import { buildSheetData } from '../../src/core/sheets/map.js';
import { appendRow } from '../../src/core/sheets/rows.js';
import { setHeader } from '../../src/core/sheets/set-header-op.js';
import type { Cell, SpreadsheetSnapshot } from '../../src/core/sheets/types.js';
import { undoStructure } from '../../src/core/undo-structure.js';
import { FakeSheetsClient } from './sheet.js';

const cell = (value: string): Cell => ({ value });

const book = (rows: Cell[][]): SpreadsheetSnapshot => ({
  id: 'SHEET',
  title: 'Т',
  sheets: [
    { title: 'Лист', sheetId: 1, rows: [[cell('Имя')]] },
    { title: 'Вопросы', sheetId: 9, rows },
  ],
});

/** Запись журнала о листе «Вопросы», созданном `addSheet` с тремя непустыми ячейками. */
const added: WriteRecord = {
  at: new Date().toISOString(),
  account: 'me',
  targetId: 'SHEET',
  alias: null,
  sheet: 'Вопросы',
  op: 'addSheet',
  changes: [],
  structure: { kind: 'addSheet', sheet: 'Вопросы', title: 'Вопросы', count: 3 },
  revisionBefore: null,
  revisionAfter: null,
  correlationId: 'probe-add-sheet',
};

export const headerProbes: Record<string, () => Promise<void>> = {
  // Шапка — только явной операцией и только в пустые ячейки: занятая не перезаписывается, повтор
  // подписи — отказ; в обоих случаях записи нет.
  'write.header-empty-cells-only': async () => {
    const snapshot = book([]);
    const data = buildSheetData(snapshot, { sheet: 'Лист' });
    const refused = [
      [{ columns: ['№', 'Статус'], startColumn: 'A' }, 'header_cell_occupied'],
      [{ columns: ['Статус', 'статус'], startColumn: 'B' }, 'header_label_duplicate'],
      [{ columns: ['имя'], startColumn: 'B' }, 'header_label_duplicate'],
    ] as const;
    for (const [request, cause] of refused) {
      const client = new FakeSheetsClient(snapshot);
      await expect(setHeader(client, data, request, { dryRun: false })).rejects.toMatchObject({
        payload: { code: 'bad_request', cause },
      });
      expect(client.writes).toHaveLength(0);
    }
    const plan = await setHeader(new FakeSheetsClient(snapshot), data, {
      columns: ['Статус'],
      startColumn: 'B',
    });
    expect(plan.changes.map((change) => change.a1)).toEqual(['Лист!B1']);
  },

  // Лист, созданный с содержимым, откат удаляет, только пока непустых ячеек столько, сколько
  // записали мы: ячейку дописали — `revision_conflict`, лист на месте.
  'write.add-sheet-content-undo': async () => {
    const ours = [[cell('№'), cell('Тема')], [cell('1')]];
    const client = new FakeSheetsClient(book(ours));
    await undoStructure(client, 'SHEET', added, {}, async () => {});
    expect(client.formatWrites).toContainEqual(
      expect.objectContaining({ kind: 'deleteSheet', sheetId: 9 }),
    );
    const edited = new FakeSheetsClient(book([...ours, [cell('2')]]));
    await expect(undoStructure(edited, 'SHEET', added, {}, async () => {})).rejects.toMatchObject({
      payload: { code: 'revision_conflict', cause: 'sheet_changed' },
    });
    expect(edited.formatWrites).toHaveLength(0);
  },

  // Две таблицы одна под другой: данные первой шапки кончаются на второй, и карта её называет;
  // таблица с пропуском и текстом после него границы не получает (§9.3, 16.11).
  'map.block-bound': async () => {
    const two = stacked();
    const data = buildSheetData(two, { headerRow: 1 });
    expect(data.map.nextTable).toEqual({ row: 6, headerRow: 7, blankRows: 1 });
    expect(data.rows).toHaveLength(3);
    const gapped = {
      ...two,
      sheets: [
        {
          title: 'Т',
          sheetId: 1,
          rows: [
            [cell('Имя'), cell('Город')],
            [cell('Анна'), cell('Пермь')],
            [],
            [cell('Вера'), cell('Омск')],
          ],
        },
      ],
    };
    const whole = buildSheetData(gapped, { headerRow: 1 });
    expect(whole.map.nextTable).toBeUndefined();
    expect(whole.rows).toHaveLength(3);
    await Promise.resolve();
  },

  // Единственная пустая строка перед следующей таблицей — разделитель: дозапись его не занимает.
  'write.append-keeps-block-gap': async () => {
    const two = stacked();
    const client = new FakeSheetsClient(two);
    await expect(
      appendRow(client, buildSheetData(two, { headerRow: 1 }), { Дата: '05.10.2026', Сумма: 4 }),
    ).rejects.toMatchObject({ payload: { code: 'bad_request', cause: 'block_gap' } });
    expect(client.writes).toHaveLength(0);
  },
};

/** Даты и суммы (строки 2–4), пустая строка 5, заголовок «Склад» и шапка «Товар | Цена» в строке 7. */
function stacked(): SpreadsheetSnapshot {
  const day = (d: number, sum: number): Cell[] => [cell(`0${d}.10.2026`), { value: sum }];
  return {
    id: 'SHEET',
    title: 'Т',
    sheets: [
      {
        title: 'Лист',
        sheetId: 1,
        rows: [
          [cell('Дата'), cell('Сумма')],
          day(1, 1),
          day(2, 2),
          day(3, 3),
          [],
          [cell('Склад')],
          [cell('Товар'), cell('Цена')],
          [cell('стол'), { value: 10 }],
        ],
      },
    ],
  };
}
