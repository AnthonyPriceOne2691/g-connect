/**
 * Перемещение строк и сортировка (фаза 2.5b): G11, G12 и арифметика обратного хода.
 *
 * Главный оракул здесь — на ЧИСЛАХ: `destinationIndex` у Google считается по координатам
 * ДО удаления блока, ответ на запрос пустой, и промах виден только на живой таблице как
 * «переехало не туда». Пример взят из документации Google дословно.
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { inverseMove, movedStart } from '../src/core/sheets/move-math.js';
import { moveRows, sortRange } from '../src/core/sheets/order-op.js';
import { undoLast } from '../src/core/undo.js';
import { MutableSheetsClient, instructionSheet, reportSheet, snapshot } from './fixtures/sheet.js';

describe('арифметика перемещения', () => {
  it('пример из документации Google: блок [1,3) на 4 → 0,3,1,2,4', () => {
    // Значения 0..4 в строках; блок из двух строк уезжает на индекс 4 и встаёт на 2.
    expect(movedStart(1, 2, 4)).toBe(2);
  });

  it('вниз: блок [2,5) на 9 → встаёт на 6, обратно берётся с 6 и едет на 2', () => {
    expect(movedStart(2, 3, 9)).toBe(6);
    expect(inverseMove(2, 3, 9)).toEqual({ from: 6, to: 2 });
    // Обратный ход возвращает блок ровно на прежнее место — проверяем формулой же.
    expect(movedStart(6, 3, 2)).toBe(2);
  });

  it('вверх: блок [7,9) на 1 → встаёт на 1, обратно едет на at+count', () => {
    expect(movedStart(7, 2, 1)).toBe(1);
    expect(inverseMove(7, 2, 1)).toEqual({ from: 1, to: 9 });
    expect(movedStart(1, 2, 9)).toBe(7);
  });

  it('назначение внутри блока — блок не двигается', () => {
    expect(movedStart(3, 4, 5)).toBe(3);
  });
});

describe('G11, G12 — перемещение строк и сортировка на листе', () => {
  const book = () => snapshot([reportSheet(), instructionSheet()]);
  const data = () => buildSheetData(book());

  const written = async (
    run: (options: Parameters<typeof sortRange>[3]) => Promise<{ planId: string | null }>,
    journalled: WriteRecord[],
    confirm: string,
  ): Promise<void> => {
    await run({});
    await run({
      dryRun: false,
      confirm,
      journal: async (record) => {
        journalled.push(record);
      },
      journalSource: { recent: () => Promise.resolve(journalled) },
    });
  };

  it('перемещение требует названия и откатывается на прежнее место', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const denied = await moveRows(
      client,
      data(),
      { Проект: 'lash-try-on' },
      { Проект: 'G connect' },
      { dryRun: false, confirm: 'да' },
    );
    expect(denied.status).toBe('confirm_required');

    await written(
      (options) =>
        moveRows(client, data(), { Проект: 'lash-try-on' }, { Проект: 'G connect' }, options),
      journalled,
      'перемещаю lash-try-on',
    );
    const after = await client.getSpreadsheet();
    expect(after.sheets[0]?.rows[2]?.[1]?.value).toBe('lash-try-on');
    expect(journalled[0]?.structure).toMatchObject({ kind: 'moveRows', to: 2 });

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.structureUndone).toContain('прежнее место');
    expect((await client.getSpreadsheet()).sheets[0]?.rows[2]?.[1]?.value).toBe('G connect');
  });

  it('ориентир внутри перемещаемого блока — отказ, а не тихий no-op', async () => {
    const client = new MutableSheetsClient(book());
    await expect(
      moveRows(client, data(), { Проект: 'G connect' }, { Проект: 'G connect' }, {}),
    ).rejects.toMatchObject({ payload: { cause: 'move_into_itself' } });
  });

  it('сортировка меняет порядок и откатывается снимком, а не обратной сортировкой', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const preview = await sortRange(client, data(), 'Проект', {});
    expect(preview.structural).toMatchObject({ kind: 'sortRange', count: 2 });
    expect(preview.structural?.confirmPhrase).toContain('Проект');

    await written(
      (options) => sortRange(client, data(), 'Проект', options),
      journalled,
      'сортирую по Проект',
    );
    const after = await client.getSpreadsheet();
    // «G connect» < «lash-try-on» по алфавиту — порядок сохранился; проверяем обратную.
    expect(after.sheets[0]?.rows[2]?.[1]?.value).toBe('G connect');
    expect(journalled[0]?.snapshots?.[0]?.rows).toHaveLength(2);

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.structureUndone).toContain('снимка');
  });

  it('сортировать нечего при одной строке — отказ с числом', async () => {
    const single = snapshot([
      { ...reportSheet(), rows: reportSheet().rows.slice(0, 3) },
      instructionSheet(),
    ]);
    const client = new MutableSheetsClient(single);
    await expect(sortRange(client, buildSheetData(single), 'Проект', {})).rejects.toMatchObject({
      payload: { cause: 'nothing_to_sort' },
    });
  });
});
