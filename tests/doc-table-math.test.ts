/**
 * Арифметика таблиц против фикстурной модели (слайс 6c): вычисленные точки вставки
 * обязаны совпасть с фактическими границами, которые строит та же арифметика правил
 * документации. Живой прогон сверяет обе против Google (см. live-run).
 */

import { describe, expect, it } from 'vitest';

import {
  emptyRowWidth,
  newColumnCellInsertionPoints,
  newRowCellInsertionPoints,
  newTableCellInsertionPoints,
} from '../src/core/docs/table-math.js';
import { FakeDocsClient, buildDoc, p } from './fixtures/doc.js';

const doc = () =>
  buildDoc({
    tabs: [
      {
        title: 'Т',
        content: [
          p('до'),
          {
            table: [
              ['А', 'Б'],
              ['В', 'Г'],
            ],
          },
          p('после'),
        ],
      },
    ],
  });

describe('точки вставки согласованы с моделью', () => {
  it('новая строка: вписанные по вычисленным точкам тексты попадают в свои ячейки', async () => {
    const client = new FakeDocsClient(doc());
    const before = (await client.getDocument()).tabs[0]!;
    const table = before.tables[0]!;
    const points = newRowCellInsertionPoints(table, 1); // вставка на место второй строки
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'insertTableRow',
          tabId: 't1',
          tableStart: table.startIndex,
          rowIndex: 1,
          below: false,
        },
        // С конца, чтобы сдвиги не портили предыдущие точки.
        { kind: 'insertText', tabId: 't1', at: points[1]!, text: 'Y' },
        { kind: 'insertText', tabId: 't1', at: points[0]!, text: 'X' },
      ],
      'rev-1',
    );
    const after = (await client.getDocument()).tabs[0]!;
    expect(after.tables[0]!.cells).toEqual([
      ['А', 'Б'],
      ['X', 'Y'],
      ['В', 'Г'],
    ]);
  });

  it('строка ПОСЛЕ последней (удалили последнюю — возвращаем на место)', async () => {
    const client = new FakeDocsClient(doc());
    const before = (await client.getDocument()).tabs[0]!;
    const table = before.tables[0]!;
    const points = newRowCellInsertionPoints(table, 2);
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'insertTableRow',
          tabId: 't1',
          tableStart: table.startIndex,
          rowIndex: 1,
          below: true,
        },
        { kind: 'insertText', tabId: 't1', at: points[1]!, text: 'Y' },
        { kind: 'insertText', tabId: 't1', at: points[0]!, text: 'X' },
      ],
      'rev-1',
    );
    expect((await client.getDocument()).tabs[0]!.tables[0]!.cells).toEqual([
      ['А', 'Б'],
      ['В', 'Г'],
      ['X', 'Y'],
    ]);
  });

  it('новая колонка: накопленный сдвиг по строкам учтён', async () => {
    const client = new FakeDocsClient(doc());
    const table = (await client.getDocument()).tabs[0]!.tables[0]!;
    const points = newColumnCellInsertionPoints(table, 1); // на место второй колонки
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'insertTableColumn',
          tabId: 't1',
          tableStart: table.startIndex,
          columnIndex: 1,
          right: false,
        },
        { kind: 'insertText', tabId: 't1', at: points[1]!, text: 'Н2' },
        { kind: 'insertText', tabId: 't1', at: points[0]!, text: 'Н1' },
      ],
      'rev-1',
    );
    expect((await client.getDocument()).tabs[0]!.tables[0]!.cells).toEqual([
      ['А', 'Н1', 'Б'],
      ['В', 'Н2', 'Г'],
    ]);
  });

  it('новая таблица: сетка точек совпадает с фактическими ячейками', async () => {
    const client = new FakeDocsClient(buildDoc({ tabs: [{ title: 'Т', content: [p('якорь')] }] }));
    const before = (await client.getDocument()).tabs[0]!;
    const anchor = before.paragraphs[0]!;
    // Таблица встанет следующим блоком: её вход — конец абзаца-якоря.
    const tableStart = anchor.endIndex;
    const grid = newTableCellInsertionPoints(tableStart, 2, 2);
    await client.batchUpdate(
      'd',
      [
        { kind: 'insertTable', tabId: 't1', at: anchor.endIndex - 1, rows: 2, columns: 2 },
        { kind: 'insertText', tabId: 't1', at: grid[1]![1]!, text: 'Г' },
        { kind: 'insertText', tabId: 't1', at: grid[1]![0]!, text: 'В' },
        { kind: 'insertText', tabId: 't1', at: grid[0]![1]!, text: 'Б' },
        { kind: 'insertText', tabId: 't1', at: grid[0]![0]!, text: 'А' },
      ],
      'rev-1',
    );
    const after = (await client.getDocument()).tabs[0]!;
    expect(after.tables[0]!.cells).toEqual([
      ['А', 'Б'],
      ['В', 'Г'],
    ]);
    expect(emptyRowWidth(2)).toBe(5);
  });
});
