/**
 * Перенос содержимого: копирование, вырезание, автозаполнение, дублирование листа
 * (фаза 2.5b). Фейк применяет перенос к снимку, поэтому оракулы проверяют «значения
 * переехали» и «откат вернул», а не «метод вызвали» (урок L3).
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import { autoFill, copyRange, cutRange, duplicateSheet } from '../src/core/sheets/range-op.js';
import { undoLast } from '../src/core/undo.js';
import { MutableSheetsClient, instructionSheet, reportSheet, snapshot } from './fixtures/sheet.js';

const book = () => snapshot([reportSheet(), instructionSheet()]);
const data = () => buildSheetData(book());

const written = async (
  run: (options: Parameters<typeof copyRange>[3]) => Promise<unknown>,
  journalled: WriteRecord[],
  confirm?: string,
): Promise<void> => {
  const preview = (await run({})) as { planId: string | null };
  await run({
    dryRun: false,
    confirm: confirm ?? preview.planId ?? '',
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
  });
};

describe('копирование колонки', () => {
  it('превью показывает «было → станет» по каждой ячейке получателя', async () => {
    const client = new MutableSheetsClient(book());
    const preview = await copyRange(client, data(), { column: 'Часы', toColumn: 'Статус' }, {});
    expect(preview.status).toBe('preview');
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes[0]).toMatchObject({ column: 'Статус', before: 'в работе', after: 2 });
    expect(preview.structural?.anchor).toContain('Часы');
  });

  it('запись переносит значения, откат возвращает получателя', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    await written(
      (options) => copyRange(client, data(), { column: 'Часы', toColumn: 'Статус' }, options),
      journalled,
    );
    const after = await client.getSpreadsheet();
    expect(after.sheets[0]?.rows[2]?.[2]?.value).toBe(2);

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.structureUndone).toContain('получатель');
    expect((await client.getSpreadsheet()).sheets[0]?.rows[2]?.[2]?.value).toBe('в работе');
  });

  it('копировать колонку в себя же — отказ, а не пустая правка', async () => {
    const client = new MutableSheetsClient(book());
    await expect(
      copyRange(client, data(), { column: 'Часы', toColumn: 'Часы' }, {}),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
  });
});

describe('вырезание колонки', () => {
  it('требует названия источника: это разрушающая правка', async () => {
    const client = new MutableSheetsClient(book());
    const outcome = await cutRange(
      client,
      data(),
      { column: 'Часы', toColumn: 'Статус' },
      {
        dryRun: false,
        confirm: 'да',
      },
    );
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('Часы');
  });

  it('откат возвращает ОБА прямоугольника — и источник, и получателя', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    await written(
      (options) => cutRange(client, data(), { column: 'Часы', toColumn: 'Статус' }, options),
      journalled,
      'вырезаю колонку Часы',
    );
    const afterCut = await client.getSpreadsheet();
    expect(afterCut.sheets[0]?.rows[2]?.[2]?.value).toBe(2);
    expect(afterCut.sheets[0]?.rows[2]?.[3]?.value).toBeNull();
    expect(journalled[0]?.snapshots).toHaveLength(2);

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.structureUndone).toContain('обе колонки');
    const afterUndo = await client.getSpreadsheet();
    expect(afterUndo.sheets[0]?.rows[2]?.[3]?.value).toBe(2);
    expect(afterUndo.sheets[0]?.rows[2]?.[2]?.value).toBe('в работе');
  });
});

describe('автозаполнение и дублирование листа', () => {
  /** Лист, где колонка «Часы» заполнена только в первой строке данных. */
  const partial = () => {
    const base = book();
    const sheet = base.sheets[0]!;
    const rows = sheet.rows.map((row, index) =>
      index === 3 ? row.map((cell, column) => (column === 3 ? { value: null } : cell)) : row,
    );
    return { ...base, sheets: [{ ...sheet, rows }, base.sheets[1]!] };
  };

  it('автозаполнение продолжает по образцу и откатывается в пустоту', async () => {
    const client = new MutableSheetsClient(partial());
    const journalled: WriteRecord[] = [];
    const preview = await autoFill(client, buildSheetData(partial()), 'Часы', {});
    expect(preview.structural).toMatchObject({ kind: 'autoFill', count: 1 });
    expect(preview.structural?.anchor).toContain('образец из 1');

    await written(
      (options) => autoFill(client, buildSheetData(partial()), 'Часы', options),
      journalled,
    );
    expect((await client.getSpreadsheet()).sheets[0]?.rows[3]?.[3]?.value).toBe(2);

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.structureUndone).toContain('снято');
    expect((await client.getSpreadsheet()).sheets[0]?.rows[3]?.[3]?.value).toBeNull();
  });

  it('нечего продолжать — отказ с числами, а не пустая запись', async () => {
    const client = new MutableSheetsClient(book());
    await expect(autoFill(client, data(), 'Часы', {})).rejects.toMatchObject({
      payload: { cause: 'nothing_to_fill' },
    });
  });

  it('копия листа появляется, откат её удаляет — если её не правили', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    await written((options) => duplicateSheet(client, data(), 'Лист1 копия', options), journalled);
    expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).toContain('Лист1 копия');

    await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).not.toContain('Лист1 копия');
  });

  it('копию правили после создания — откат отказывает, а не уносит чужую работу', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    await written((options) => duplicateSheet(client, data(), 'Лист1 копия', options), journalled);
    await client.updateValues('SHEET', 'Лист1 копия!A9', [['чужая работа']]);

    await expect(
      undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) }),
    ).rejects.toMatchObject({ payload: { cause: 'copy_changed' } });
  });
});
