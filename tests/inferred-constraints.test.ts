/**
 * Выведенные ограничения колонки — только по сильным признакам (D-26, Q8, Q9).
 *
 * Слабая догадка ядра превращалась в жёсткий запрет: свободный текст с одним повтором
 * становился списком (`not_in_enum`), колонка с одним «0» — числовой (`not_a_number`), и
 * «Реестр инфраструктуры» встал на 26 строках из 55 — подтвердить новое значение было нечем.
 * Настоящая проверка данных таблицы — как раньше: это решение владельца таблицы, не догадка.
 */

import { describe, expect, it } from 'vitest';

import { buildSheetMap } from '../src/core/sheets/map.js';
import type { Cell, SpreadsheetSnapshot } from '../src/core/sheets/types.js';

/** Лист из одной колонки: шапка и значения строк. */
function column(name: string, values: readonly string[]): SpreadsheetSnapshot {
  return {
    id: 'S',
    title: 'Т',
    sheets: [
      {
        title: 'Лист',
        sheetId: 0,
        rows: [[{ value: name }], ...values.map((value): Cell[] => [{ value }])],
      },
    ],
  };
}

const profile = (name: string, values: readonly string[]) =>
  buildSheetMap(column(name, values)).columns[0];

describe('Q8: выведенный список — только при сильных признаках', () => {
  it('Q8: свободный текст с повтором — не список (так встал «Реестр инфраструктуры»)', () => {
    const access = profile('Кто имеет доступ', ['Антон', 'Антон, Ира', 'Антон', 'все', 'Ира']);
    expect(access?.enumValues).toBeNull();
    expect(access?.enumSource).toBeNull();
  });

  it('Q8: короткий статус, повторённый втрое и больше на 10+ строках, — список', () => {
    const statuses = [
      'новая',
      'в работе',
      'готово',
      'новая',
      'в работе',
      'новая',
      'готово',
      'новая',
      'в работе',
      'новая',
      'готово',
      'новая',
    ];
    const status = profile('Статус', statuses);
    expect(status?.enumSource).toBe('inferred');
    expect([...(status?.enumValues ?? [])].sort()).toEqual(['в работе', 'готово', 'новая']);
  });

  it('Q8: меньше 10 строк или разных значений больше трети — не список', () => {
    expect(profile('Статус', ['да', 'нет', 'да', 'нет', 'да', 'нет'])?.enumValues).toBeNull();
    const many = ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'e', 'f', 'a', 'b'];
    expect(profile('Код', many)?.enumValues).toBeNull();
  });

  it('Q8: даты, числа и ссылки — никогда не список; длинные значения — тоже', () => {
    const dates = Array.from({ length: 12 }, (_, i) => `2026-10-0${(i % 3) + 1}`);
    expect(profile('Дата', dates)?.enumValues).toBeNull();
    const numbers = Array.from({ length: 12 }, (_, i) => String(i % 3));
    expect(profile('Стоимость', numbers)?.enumValues).toBeNull();
    const links = Array.from({ length: 12 }, (_, i) => `https://example.org/${i % 3}`);
    expect(profile('Ссылка на вход', links)?.enumValues).toBeNull();
    const long = Array.from(
      { length: 12 },
      (_, i) => `${'проект с длинным описанием и подробностями '.repeat(1)}${i % 3}`,
    );
    expect(profile('Связанные проекты', long)?.enumValues).toBeNull();
  });

  it('проверка данных таблицы — список и на двух строках: это решение владельца, не догадка', () => {
    const plain = column('Статус', ['новая', 'готово']);
    const sheet = plain.sheets[0];
    if (sheet === undefined) throw new TypeError('лист фикстуры');
    const validated: SpreadsheetSnapshot = {
      ...plain,
      sheets: [
        {
          ...sheet,
          validations: [
            {
              range: { startRow: 2, endRow: 3, startColumn: 0, endColumn: 0 },
              values: ['новая', 'готово', 'пауза'],
            },
          ],
        },
      ],
    };
    const status = buildSheetMap(validated).columns[0];
    expect(status?.enumSource).toBe('validation');
    expect(status?.enumValues).toEqual(['новая', 'готово', 'пауза']);
  });
});

describe('Q9: ограничивающий тип — не по одному значению', () => {
  it('Q9: одно «0» — не числовая колонка (так стала числовой «Стоимость/мес.»)', () => {
    expect(profile('Стоимость/мес.', ['0'])?.type).toBe('string');
    expect(profile('Стоимость/мес.', ['0', 'по запросу', 'бесплатно'])?.type).toBe('string');
  });

  it('Q9: два числа — числовая; одна дата — ещё не дата, две — дата', () => {
    expect(profile('Часы', ['2', '5'])?.type).toBe('number');
    expect(profile('Дата', ['2026-09-01'])?.type).toBe('string');
    expect(profile('Дата', ['2026-09-01', '2026-09-02'])?.type).toBe('date');
  });

  it('Q9: тип держится на 80% колонки, а не на большинстве', () => {
    expect(profile('Часы', ['1', '2', '3', '4', 'около часа'])?.type).toBe('number');
    // 3 из 5 — большинство, но не 80%: колонка остаётся текстовой.
    expect(profile('Часы', ['1', '2', '3', 'x', 'y'])?.type).toBe('string');
  });
});
