/**
 * Таблицы документа (уровень 3, слайс 6c): P13, P14, вставка/удаление таблиц целиком.
 */

import { describe, expect, it } from 'vitest';

import { runDocTable } from '../src/core/docs/table-op.js';
import { emptyTableWidth, newTableCellInsertionPoints } from '../src/core/docs/table-math.js';
import { undoDocLast } from '../src/core/undo-docs.js';
import type { DocRunOptions } from '../src/core/docs/write-support.js';
import type { JournalSource, WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, buildDoc, forecastDoc, p } from './fixtures/doc.js';
import { named } from './fixtures/named.js';

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
/** Ячейки так, как их видит человек: жирные прогоны — в `**…**`. */
const cellView = async (client: FakeDocsClient): Promise<string[][]> => {
  const tab = (await client.getDocument()).tabs[0]!;
  const table = tab.tables[0]!;
  return table.cells.map((row, r) =>
    row.map((_, c) =>
      tab.paragraphs
        .filter(
          (x) =>
            x.inTable?.table === table.index &&
            x.inTable.row === r + 1 &&
            x.inTable.column === c + 1,
        )
        .flatMap((x) => x.runs)
        .filter((run) => run.text !== '')
        .map((run) => (run.style?.bold === true ? `**${run.text}**` : run.text))
        .join(''),
    ),
  );
};
/** Абзацы вне таблиц — по ним видно лишний пустой абзац вокруг таблицы. */
const bodyTexts = async (client: FakeDocsClient): Promise<string[]> =>
  (await client.getDocument()).tabs[0]!.paragraphs.filter((x) => x.inTable === undefined).map(
    (x) => x.text,
  );
const bold = (text: string) => [{ text, style: { bold: true } }];

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
    // Живой прогон 2026-10-02: план говорил «ниже строки № 2» — человек просил «после
    // строки с Иванов» и не мог сверить одно с другим без карты (тот же класс, что LR3-7).
    expect(outcome.changes[0]!.anchor).toContain('Иванов');
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

    const written = await named(
      runDocTable,
      client,
      { op: 'deleteTableRow', rowWithCell: 'Иванов' },
      'да, удаляю строку Иванов в основе',
      options,
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
    await named(
      runDocTable,
      client,
      { op: 'deleteTableRow', rowIndex: 2 },
      'удаляю строку в г',
      options,
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
    await named(
      runDocTable,
      client,
      { op: 'deleteTableColumn', tab: 'Прогноз', columnTitle: 'Позиция' },
      'удаляю колонку Позиция',
      options,
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
                [bold('Шапка'), 'Ш2'],
                ['важное', 'хвост'],
              ],
            },
            p('после'),
          ],
        },
      ],
    });
    const client = fresh(doc);
    const written = await named(
      runDocTable,
      client,
      { op: 'deleteTable', table: 1 },
      'удаляю таблицу Шапка Ш2',
      options,
    );
    expect(written.status).toBe('ok');
    expect((await client.getDocument()).tabs[0]!.tables).toHaveLength(0);

    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.docUndone).toContain('восстановлена');
    // Вид, а не только текст: жирное — жирным, обычное не унаследовало жирного.
    expect(await cellView(client)).toEqual([
      ['**Шапка**', 'Ш2'],
      ['важное', 'хвост'],
    ]);
    // Соседние абзацы целы — и лишнего пустого после таблицы нет (LR3-3, живьём).
    expect(await bodyTexts(client)).toEqual(['до', 'после']);
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
          content: [
            p('х'),
            {
              table: [
                [bold('a'), 'b'],
                ['c', [{ text: 'd' }, { text: 'e', style: { bold: true } }]],
              ],
            },
            p('у'),
          ],
        },
      ],
    });
    const client = fresh(doc);
    await named(
      runDocTable,
      client,
      { op: 'deleteTable', table: 1 },
      'удаляю таблицу a b',
      options,
    );
    // Журнал держит прогоны со стилями, а не плоский текст.
    expect(journalled[0]!.doc?.table?.grid?.[0]?.[0]).toEqual(bold('a'));
    await undoDocLast(client, 'doc-fixture', source(), {});
    expect(await cellView(client)).toEqual([
      ['**a**', 'b'],
      ['c', 'd**e**'],
    ]);
    expect(await bodyTexts(client)).toEqual(['х', 'у']);
  });
});

describe('живой прогон 2026-10-01: откат возвращает вид, а не только текст (LR3-2, LR3-3)', () => {
  it('откат последней строки не наследует жирный строки-образца', async () => {
    const client = fresh(
      buildDoc({
        tabs: [
          {
            title: 'Т',
            content: [
              p('х'),
              {
                table: [
                  [bold('Игрок'), bold('Клуб')],
                  ['Иванов', 'Fluminense'],
                ],
              },
              p('у'),
            ],
          },
        ],
      }),
    );
    await named(
      runDocTable,
      client,
      { op: 'deleteTableRow', rowIndex: 2 },
      'удаляю строку Иванов Fluminense',
      options,
    );
    await undoDocLast(client, 'doc-fixture', source(), {});
    // Живьём новая строка копирует стиль образца: без явного сброса «Иванов» стал жирным.
    expect(await cellView(client)).toEqual([
      ['**Игрок**', '**Клуб**'],
      ['Иванов', 'Fluminense'],
    ]);
  });

  it('откат колонки не наследует жирный колонки-образца', async () => {
    const client = fresh(
      buildDoc({
        tabs: [
          {
            title: 'Т',
            content: [
              p('х'),
              {
                table: [
                  [bold('Игрок'), 'Клуб'],
                  [bold('Иванов'), 'Fluminense'],
                ],
              },
              p('у'),
            ],
          },
        ],
      }),
    );
    await named(
      runDocTable,
      client,
      { op: 'deleteTableColumn', columnTitle: 'Клуб' },
      'удаляю колонку Клуб',
      options,
    );
    await undoDocLast(client, 'doc-fixture', source(), {});
    expect(await cellView(client)).toEqual([
      ['**Игрок**', 'Клуб'],
      ['**Иванов**', 'Fluminense'],
    ]);
  });

  it('откат вставки таблицы не оставляет пустого абзаца, который поставил Google', async () => {
    const client = fresh(buildDoc({ tabs: [{ title: 'Т', content: [p('якорь'), p('дальше')] }] }));
    const preview = await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTable', rows: 2, columns: 2 },
      options(),
    );
    await runDocTable(
      client,
      await client.getDocument(),
      { op: 'insertTable', rows: 2, columns: 2 },
      options({ dryRun: false, confirm: preview.planId! }),
    );
    // Вставка в конец абзаца: хвост абзаца (пустой) остаётся ПОСЛЕ таблицы — как у Google.
    expect(await bodyTexts(client)).toEqual(['якорь', 'дальше', '']);
    const undone = await undoDocLast(client, 'doc-fixture', source(), {});
    expect(undone.status).toBe('ok');
    expect(await bodyTexts(client)).toEqual(['якорь', 'дальше']);
  });

  it('геометрия таблицы — живые числа 2026-10-01, а не прочтение документации', async () => {
    const client = fresh(
      buildDoc({ tabs: [{ title: 'Т', content: [p('Before ⚽🔥 end'), p('After')] }] }),
    );
    await client.batchUpdate(
      'd',
      [{ kind: 'insertTable', tabId: 't1', at: 15, rows: 3, columns: 3 }],
      'rev-1',
    );
    const tab = (await client.getDocument()).tabs[0]!;
    const table = tab.tables[0]!;
    expect([table.startIndex, table.endIndex]).toEqual([16, 39]);
    expect(table.rowRanges.map((r) => [r.startIndex, r.endIndex])).toEqual([
      [17, 24],
      [24, 31],
      [31, 38],
    ]);
    const starts = table.cellRanges.map((row, r) =>
      row.map(
        (_, c) =>
          tab.paragraphs.find((x) => x.inTable?.row === r + 1 && x.inTable.column === c + 1)!
            .startIndex,
      ),
    );
    expect(starts).toEqual([
      [19, 21, 23],
      [26, 28, 30],
      [33, 35, 37],
    ]);
    expect(newTableCellInsertionPoints(16, 3, 3)).toEqual(starts);
    expect(emptyTableWidth(3, 3)).toBe(39 - 16);
    expect(
      tab.paragraphs
        .filter((x) => x.inTable === undefined)
        .map((x) => [x.text, x.startIndex, x.endIndex]),
    ).toEqual([
      ['Before ⚽🔥 end', 1, 16],
      ['', 39, 40],
      ['After', 40, 46],
    ]);
  });
});
