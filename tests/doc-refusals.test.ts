/**
 * Отказы и вопросы doc-операций (уровень 3): ветки, которые мутационный прогон нашёл
 * НЕПОКРЫТЫМИ вовсе — 269 мутантов «no coverage» в селекторах и таблицах.
 *
 * Это не гонка за числом: каждый тест судит названное поведение — как именно ядро
 * спрашивает и отказывает. Тексты отказов и есть продукт: по ним человек понимает,
 * что делать дальше (§13.7).
 */

import { describe, expect, it } from 'vitest';

import {
  paragraphLabel,
  pickTab,
  resolveTableColumn,
  resolveTableRow,
} from '../src/core/docs/selectors.js';
import { narrowSelector } from '../src/core/docs/write-support.js';
import { runDocTable } from '../src/core/docs/table-op.js';
import { runDocStyle } from '../src/core/docs/style-op.js';
import { runDocDelete } from '../src/core/docs/delete-op.js';
import { runDocReplace } from '../src/core/docs/replace-op.js';
import { isGcError } from '../src/core/errors.js';
import { FakeDocsClient, buildDoc, forecastDoc, p } from './fixtures/doc.js';

const table = () =>
  buildDoc({
    tabs: [
      {
        title: 'Т',
        content: [
          p('до'),
          {
            table: [
              ['Игрок', 'Позиция', 'Игрок'],
              ['Иванов', 'нападающий', 'дубль'],
              ['Петров', 'защитник', 'резерв'],
            ],
          },
        ],
      },
    ],
  }).tabs[0]!;

const client = () => new FakeDocsClient(forecastDoc());
const opts = { authorize: () => ({ authorized: true as const }) };

describe('строка таблицы: как ядро спрашивает', () => {
  it('номер вне диапазона называет, сколько строк есть', () => {
    const result = resolveTableRow(table().tables[0]!, { rowIndex: 9 });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.field).toBe('rowIndex');
    expect(result.question.detail).toContain('их 3');
  });

  it('номер в диапазоне возвращает 0-based индекс', () => {
    const result = resolveTableRow(table().tables[0]!, { rowIndex: 2 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toBe(1);
  });

  it('пустой селектор просит назвать способ адресации', () => {
    const result = resolveTableRow(table().tables[0]!, {});
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.detail).toContain('rowWithCell');
    expect(result.question.detail).toContain('rowIndex');
  });

  it('якорь не найден — кандидаты со ВСЕМИ строками, а не пустой список', () => {
    const result = resolveTableRow(table().tables[0]!, { rowWithCell: 'Сидоров' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('no_match');
    expect(result.question.candidates).toHaveLength(3);
    expect(result.question.candidates[0]).toContain('Игрок | Позиция');
  });

  it('якорь в ДВУХ РАЗНЫХ строках — ambiguous; дважды в одной строке — это одна строка', () => {
    // Тонкость, которую этот оракул и фиксирует: «Игрок» стоит в первой строке дважды
    // (колонки 1 и 3) — строка одна, и ядро обязано её вернуть, а не спрашивать.
    const one = resolveTableRow(table().tables[0]!, { rowWithCell: 'Игрок' });
    expect(one.status).toBe('ok');

    const twoRows = buildDoc({
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
    }).tabs[0]!.tables[0]!;
    const result = resolveTableRow(twoRows, { rowWithCell: 'Иванов' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('ambiguous');
    expect(result.question.detail).toContain('2 строках');
  });
});

describe('колонка таблицы: как ядро спрашивает', () => {
  it('номер вне диапазона называет число колонок; в диапазоне даёт 0-based', () => {
    const t = table().tables[0]!;
    const bad = resolveTableColumn(t, { columnIndex: 7 });
    expect(bad.status).toBe('question');
    if (bad.status === 'question') expect(bad.question.detail).toContain('их 3');
    const ok = resolveTableColumn(t, { columnIndex: 3 });
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') expect(ok.value).toBe(2);
  });

  it('пустой селектор перечисляет доступные заголовки', () => {
    const result = resolveTableColumn(table().tables[0]!, {});
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.available).toEqual(['Игрок', 'Позиция', 'Игрок']);
  });

  it('заголовок повторяется — ambiguous с номерами, чтобы выбрать номером', () => {
    const result = resolveTableColumn(table().tables[0]!, { columnTitle: 'Игрок' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('ambiguous');
    expect(result.question.candidates).toEqual(['№ 1: Игрок', '№ 2: Позиция', '№ 3: Игрок']);
  });

  it('заголовка нет — no_match со списком того, что есть', () => {
    const result = resolveTableColumn(table().tables[0]!, { columnTitle: 'Возраст' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('no_match');
    expect(result.question.detail).toContain('шапке');
  });
});

describe('таб и селектор абзаца: границы', () => {
  it('pickTab: единственный таб без имени берётся; несуществующее имя перечисляет свои', () => {
    const single = buildDoc({ tabs: [{ title: 'Один', content: [p('х')] }] });
    expect(pickTab(single, undefined).title).toBe('Один');
    expect(() => pickTab(single, 'Нет')).toThrow();
    try {
      pickTab(single, 'Нет');
    } catch (error) {
      expect(isGcError(error)).toBe(true);
      if (isGcError(error)) expect(error.payload.detail).toContain('Есть: Один');
    }
  });

  it('narrowSelector: пустой и двойной селектор дают разные тексты', () => {
    const empty = narrowSelector({});
    const double = narrowSelector({ paragraphIndex: 1, textContains: 'х' });
    expect('field' in empty && empty.detail).toContain('пуст');
    expect('field' in double && double.detail).toContain('оставь одно');
    expect('field' in double && double.available).toContain('textStartsWith');
  });

  it('paragraphLabel: короткий абзац без усечения', () => {
    const doc = buildDoc({ tabs: [{ title: 'Т', content: [p('два слова')] }] });
    expect(paragraphLabel(doc.tabs[0]!.paragraphs[0]!)).toBe('№ 1: два слова');
  });
});

describe('таблицы: отказы операций', () => {
  it('insertTable без размеров отклоняется', async () => {
    const c = client();
    await expect(
      runDocTable(c, await c.getDocument(), { op: 'insertTable', tab: 'Прогноз' }, opts),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
  });

  it('несуществующий номер таблицы называет, сколько их, с шапками', async () => {
    const c = client();
    const outcome = await runDocTable(
      c,
      await c.getDocument(),
      { op: 'deleteTable', tab: 'Прогноз', table: 5 },
      opts,
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]!.detail).toContain('их 1');
  });

  it('таблица по якорю ячейки: deleteTable находит её без номера', async () => {
    const c = client();
    const outcome = await runDocTable(
      c,
      await c.getDocument(),
      { op: 'deleteTable', tab: 'Прогноз', tableWithCell: 'Сидоров' },
      opts,
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.changes[0]!.anchor).toContain('4×3');
  });

  it('вставка колонки ЛЕВЕЕ якоря: превью называет сторону и место', async () => {
    const c = client();
    const outcome = await runDocTable(
      c,
      await c.getDocument(),
      { op: 'insertTableColumn', tab: 'Прогноз', columnTitle: 'Статус', right: false },
      opts,
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.changes[0]!.anchor).toContain('левее колонки № 3');
    expect(outcome.changes[0]!.after).toContain('на месте № 3');
  });

  it('без конверта и без кода вставка строки просит код плана', async () => {
    const c = client();
    const outcome = await runDocTable(
      c,
      await c.getDocument(),
      { op: 'insertTableRow', tab: 'Прогноз', rowWithCell: 'Иванов' },
      { dryRun: false },
    );
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('по коду плана');
  });
});

describe('стили и удаления: отказы', () => {
  it('updateTextStyle без полей и setParagraphStyle без стиля отклоняются', async () => {
    const c = client();
    const snapshot = await c.getDocument();
    await expect(
      runDocStyle(
        c,
        snapshot,
        { op: 'updateTextStyle', tab: 'Черновики', where: { firstParagraph: true }, style: {} },
        opts,
      ),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
    await expect(
      runDocStyle(
        c,
        snapshot,
        { op: 'setParagraphStyle', tab: 'Черновики', where: { firstParagraph: true } },
        opts,
      ),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
  });

  it('deleteRange с перевёрнутым интервалом отклоняется', async () => {
    const c = client();
    await expect(
      runDocDelete(
        c,
        await c.getDocument(),
        { op: 'deleteRange', tab: 'Прогноз', startIndex: 50, endIndex: 10 },
        {},
      ),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
  });

  it('пустая строка поиска отклоняется до всякой работы', async () => {
    const c = client();
    await expect(
      runDocReplace(c, await c.getDocument(), { op: 'replaceAllText', find: '', replace: 'х' }, {}),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
  });

  it('replaceText по абзацу в ячейке таблицы — отказ с советом', async () => {
    const c = client();
    await expect(
      runDocReplace(
        c,
        await c.getDocument(),
        {
          op: 'replaceText',
          tab: 'Прогноз',
          where: { textStartsWith: 'Иванов' },
          find: 'Иванов',
          replace: 'Смирнов',
        },
        {},
      ),
    ).rejects.toMatchObject({ payload: { code: 'bad_request' } });
  });
});
