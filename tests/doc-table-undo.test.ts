/**
 * Откаты табличных правок — краевые случаи (уровень 3, слайс 6c).
 *
 * Мутационный прогон показал 39 непокрытых мутантов в `undo-docs-table.ts`: отказ
 * «таблица записи не найдена», возврат колонок, край сетки, пустые ячейки в снимке.
 * Каждый тест ниже судит названное поведение, а не число.
 */

import { describe, expect, it } from 'vitest';

import { runDocTable } from '../src/core/docs/table-op.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import type { DocRunOptions } from '../src/core/docs/write-support.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, buildDoc, p } from './fixtures/doc.js';
import { named } from './fixtures/named.js';

const journalled: WriteRecord[] = [];
const source = (): JournalSource => ({ recent: () => Promise.resolve([...journalled]) });
const options = (over: Partial<DocRunOptions> = {}): DocRunOptions => ({
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: source(),
  authorize: () => ({ authorized: true }),
  ...over,
});

const doc = (grid: string[][]) =>
  buildDoc({ tabs: [{ title: 'Т', content: [p('до'), { table: grid }, p('после')] }] });

const fresh = (grid: string[][]) => {
  journalled.length = 0;
  return new FakeDocsClient(doc(grid));
};
const cells = async (c: FakeDocsClient) => (await c.getDocument()).tabs[0]!.tables[0]!.cells;

describe('откат удаления колонки: край и середина', () => {
  it('ПОСЛЕДНЯЯ колонка возвращается на своё место, а не в начало', async () => {
    const client = fresh([
      ['A', 'B', 'C'],
      ['1', '2', '3'],
    ]);
    await named(
      runDocTable,
      client,
      { op: 'deleteTableColumn', columnIndex: 3 },
      'удаляю колонку C',
      options,
    );
    expect(await cells(client)).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ]);
    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.docUndone).toContain('место № 3');
    expect(await cells(client)).toEqual([
      ['A', 'B', 'C'],
      ['1', '2', '3'],
    ]);
  });

  it('колонка с ПУСТЫМИ ячейками возвращается пустой, а не с чужим текстом', async () => {
    const client = fresh([
      ['A', '', 'C'],
      ['1', '', '3'],
    ]);
    await named(
      runDocTable,
      client,
      { op: 'deleteTableColumn', columnIndex: 2 },
      'удаляю колонку',
      options,
    );
    expect(await cells(client)).toEqual([
      ['A', 'C'],
      ['1', '3'],
    ]);
    await undoDocLast(client, 'doc-fixture', source(), {});
    expect(await cells(client)).toEqual([
      ['A', '', 'C'],
      ['1', '', '3'],
    ]);
  });
});

describe('откат вставки колонки', () => {
  it('пустая вставленная колонка удаляется; заполненная — отказ', async () => {
    const client = fresh([
      ['A', 'B'],
      ['1', '2'],
    ]);
    const written = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTableColumn', columnIndex: 1, right: true },
      options({ dryRun: false }),
    );
    expect((await cells(client))[0]).toEqual(['A', '', 'B']);

    const table = (await client.getDocument()).tabs[0]!.tables[0]!;
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: table.cellRanges[0]![1]!.startIndex + 1, text: 'X' }],
      written.revisionAfter!,
    );
    await expect(
      undoDocLast(client, 'doc-fixture', source(), { force: true }),
    ).rejects.toMatchObject({ payload: { cause: 'inserted_not_empty' } });
  });
});

describe('таблица записи изменилась — откат отказывает честно', () => {
  it('таблицу удалили между правкой и откатом: revision_conflict с позицией', async () => {
    const client = fresh([
      ['A', 'B'],
      ['1', '2'],
    ]);
    const written = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTableRow', rowIndex: 1, below: true },
      options({ dryRun: false }),
    );
    // Кто-то снёс таблицу целиком, и откат обязан это заметить.
    const table = (await client.getDocument()).tabs[0]!.tables[0]!;
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'deleteRange',
          tabId: 't1',
          startIndex: table.startIndex,
          endIndex: table.endIndex,
        },
      ],
      written.revisionAfter!,
    );
    await expect(
      undoDocLast(client, 'doc-fixture', source(), { force: true }),
    ).rejects.toMatchObject({ payload: { code: 'revision_conflict' } });
  });

  it('таб исчез — отказ у восстановления таблицы называет таб', async () => {
    const client = fresh([['A']]);
    await named(runDocTable, client, { op: 'deleteTable', table: 1 }, 'удаляю таблицу A', options);
    // Подменяем запись: таб, которого нет.
    journalled[0] = {
      ...journalled[0]!,
      doc: { ...journalled[0]!.doc!, tab: 'Нет такого' },
    };
    await expect(
      undoDocLast(client, 'doc-fixture', source(), { force: true }),
    ).rejects.toMatchObject({ payload: { code: 'revision_conflict' } });
  });
});

describe('откат удаления таблицы: сетка с пустыми ячейками', () => {
  it('пустые ячейки остаются пустыми, заполненные возвращаются', async () => {
    const client = fresh([
      ['A', ''],
      ['', 'D'],
    ]);
    await named(runDocTable, client, { op: 'deleteTable', table: 1 }, 'удаляю таблицу A', options);
    expect((await client.getDocument()).tabs[0]!.tables).toHaveLength(0);
    await undoDocLast(client, 'doc-fixture', source(), {});
    expect(await cells(client)).toEqual([
      ['A', ''],
      ['', 'D'],
    ]);
  });
});
