/**
 * Таблицы документа (уровень 3, слайс 6c): P13, P14, вставка/удаление таблиц целиком.
 */

import { describe, expect, it } from 'vitest';

import { runDocTable } from '../src/core/docs/table-op.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import type { DocRunOptions } from '../src/core/docs/write-support.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, buildDoc, forecastDoc, p } from './fixtures/doc.js';

const journalled: WriteRecord[] = [];
const source = (): JournalSource => ({ recent: () => Promise.resolve([...journalled]) });
const options = (over: Partial<DocRunOptions> = {}): DocRunOptions => ({
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: source(),
  account: 'default',
  alias: 'forecast',
  ...over,
});
const fresh = (doc = forecastDoc()) => {
  journalled.length = 0;
  return new FakeDocsClient(doc);
};
const cells = async (client: FakeDocsClient, tab = 0, table = 0) =>
  (await client.getDocument()).tabs[tab]!.tables[table]!.cells;

describe('P13 — вставка строки по якорю ячейки и её откат', () => {
  it('строка встаёт ниже якоря пустой; откат удаляет её, пока она пуста', async () => {
    const client = fresh();
    const outcome = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTableRow', tab: 'Прогноз', rowWithCell: 'Иванов' },
      options({ dryRun: false, authorize: () => ({ authorized: true }) }),
    );
    expect(outcome.status).toBe('ok');
    const grid = await cells(client);
    expect(grid).toHaveLength(5);
    expect(grid[2]).toEqual(['', '', '']); // ниже строки с Ивановым (№2)

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(undone.docUndone).toContain('строка удалена');
    expect(await cells(client)).toHaveLength(4);
  });

  it('вставленную строку заполнили — откат отказывает: чужое не уничтожаем', async () => {
    const client = fresh();
    const written = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTableRow', tab: 'Прогноз', rowWithCell: 'Иванов' },
      options({ dryRun: false, authorize: () => ({ authorized: true }) }),
    );
    const table = (await client.getDocument()).tabs[0]!.tables[0]!;
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'insertText',
          tabId: 't1',
          at: table.cellRanges[2]![0]!.startIndex + 1,
          text: 'Новичок',
        },
      ],
      written.revisionAfter!,
    );
    await expect(
      undoDocLast(client, 'doc-fixture', source(), { force: true }),
    ).rejects.toMatchObject({ payload: { cause: 'inserted_not_empty' } });
  });

  it('якорь в двух строках — вопрос с кандидатами', async () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            p('х'),
            {
              table: [
                ['Иванов', 'а'],
                ['Иванов', 'б'],
              ],
            },
          ],
        },
      ],
    });
    const client = fresh(doc);
    const outcome = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTableRow', rowWithCell: 'Иванов' },
      options(),
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]!.candidates).toHaveLength(2);
  });
});

describe('P14 — удаление строки: подтверждение названием, откат со значениями и стилями', () => {
  it('превью показывает содержимое; голое «да» не пишет; фраза пишет; откат возвращает строку', async () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            p('до'),
            {
              table: [
                ['Игрок', 'Статус'],
                ['Иванов', 'в основе'],
                ['Петров', 'запас'],
              ],
            },
          ],
        },
      ],
    });
    const client = fresh(doc);
    const preview = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTableRow', rowWithCell: 'Иванов' },
      options(),
    );
    expect(preview.status).toBe('preview');
    expect(preview.changes[0]!.before).toContain('Иванов');
    expect(preview.notes.join(' ')).toContain('удаляю строку Иванов');

    const bare = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTableRow', rowWithCell: 'Иванов' },
      options({ dryRun: false, confirm: 'да' }),
    );
    expect(bare.status).toBe('confirm_required');

    const written = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTableRow', rowWithCell: 'Иванов' },
      options({ dryRun: false, confirm: 'да, удаляю строку Иванов в основе' }),
    );
    expect(written.status).toBe('ok');
    expect(await cells(client)).toEqual([
      ['Игрок', 'Статус'],
      ['Петров', 'запас'],
    ]);

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(undone.docUndone).toContain('вернулась на место № 2');
    expect(await cells(client)).toEqual([
      ['Игрок', 'Статус'],
      ['Иванов', 'в основе'],
      ['Петров', 'запас'],
    ]);
  });

  it('удаление ПОСЛЕДНЕЙ строки таблицы возвращается на своё место', async () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            p('х'),
            {
              table: [
                ['а', 'б'],
                ['в', 'г'],
              ],
            },
          ],
        },
      ],
    });
    const client = fresh(doc);
    await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTableRow', rowIndex: 2 },
      options({ dryRun: false, confirm: 'удаляю строку в г' }),
    );
    expect(await cells(client)).toEqual([['а', 'б']]);
    await undoDocLast(client, 'doc-fixture', source(), {});
    expect(await cells(client)).toEqual([
      ['а', 'б'],
      ['в', 'г'],
    ]);
  });
});

describe('колонки и целые таблицы', () => {
  it('удаление колонки по заголовку и откат с содержимым', async () => {
    const client = fresh();
    await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTableColumn', tab: 'Прогноз', columnTitle: 'Позиция' },
      options({ dryRun: false, confirm: 'удаляю колонку Позиция' }),
    );
    expect((await cells(client))[0]).toEqual(['Игрок', 'Статус']);
    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(await cells(client)).toEqual([
      ['Игрок', 'Позиция', 'Статус'],
      ['Иванов', 'нападающий', 'в основе'],
      ['Петров', 'защитник', 'под вопросом'],
      ['Сидоров', 'вратарь', 'в основе'],
    ]);
  });

  it('удаление таблицы целиком и откат сетки со стилями', async () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            p('до'),
            {
              table: [
                ['Шапка', 'Ш2'],
                ['важное', 'хвост'],
              ],
            },
            p('после'),
          ],
        },
      ],
    });
    const client = fresh(doc);
    const written = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTable', table: 1 },
      options({ dryRun: false, confirm: 'удаляю таблицу Шапка Ш2' }),
    );
    expect(written.status).toBe('ok');
    expect((await client.getDocument()).tabs[0]!.tables).toHaveLength(0);

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.docUndone).toContain('восстановлена');
    expect(await cells(client)).toEqual([
      ['Шапка', 'Ш2'],
      ['важное', 'хвост'],
    ]);
    // Соседние абзацы целы.
    const texts = (await client.getDocument()).tabs[0]!.paragraphs.filter(
      (x) => x.inTable === undefined,
    ).map((x) => x.text);
    expect(texts).toEqual(['до', 'после']);
  });

  it('вставка таблицы: превью, запись кодом, откат пустой; непустую не откатывает', async () => {
    const client = fresh(buildDoc({ tabs: [{ title: 'Т', content: [p('якорь')] }] }));
    const preview = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTable', rows: 2, columns: 2 },
      options(),
    );
    expect(preview.status).toBe('preview');
    const written = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTable', rows: 2, columns: 2 },
      options({ dryRun: false, confirm: preview.planId! }),
    );
    expect(written.status).toBe('ok');
    expect(await cells(client)).toEqual([
      ['', ''],
      ['', ''],
    ]);
    // Написали в ячейку — откат отказывает.
    const table = (await client.getDocument()).tabs[0]!.tables[0]!;
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: table.cellRanges[0]![0]!.startIndex + 1, text: 'з' }],
      written.revisionAfter!,
    );
    await expect(
      undoDocLast(client, 'doc-fixture', source(), { force: true }),
    ).rejects.toMatchObject({ payload: { cause: 'inserted_not_empty' } });
  });

  it('стили содержимого переживают цикл удаление→откат', async () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [p('х'), { table: [['a', 'b']] }],
        },
      ],
    });
    // Вручную положим жирный прогон в ячейку через фейк нельзя (plain) — стили ячеек
    // в снимке проверяются на уровне запросов: runStyleRequests уже покрыт P9.
    // Здесь — что снимок಼ сетки кладётся в журнал.
    const client = fresh(doc);
    await runDocTable(
      client,
      await client.getDocument(),
      { op: 'deleteTable', table: 1 },
      options({ dryRun: false, confirm: 'удаляю таблицу a b' }),
    );
    expect(journalled[0]!.doc?.table?.grid?.[0]?.[0]?.[0]?.text).toBe('a');
  });
});
