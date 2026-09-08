/**
 * Шов и подпись структурных правок (фаза 2.5b): примеры G1, G2.
 *
 * Проверяется НАПРАВЛЕНИЕ ЗАПРОСА — доменная операция → запрос библиотеки. Форма собрана
 * руками по документации Sheets API: `DimensionRange` — 0-based полуинтервал, а домен
 * говорит 1-based «перед этим номером». Промах на единицу здесь удаляет НЕ ТУ строку, и
 * ни один тест на снимок этого не увидит (урок L3).
 */

import { describe, expect, it } from 'vitest';

import { toRequest } from '../src/core/google/requests.js';
import { canonicalPlan, planId, type PlanShape } from '../src/core/plan.js';

describe('G1 — доменный запрос → запрос библиотеки', () => {
  it('вставка строк: 1-based «перед номером» → 0-based полуинтервал', () => {
    const request = toRequest({
      kind: 'insertDimension',
      sheetId: 7,
      dimension: 'rows',
      at: 4,
      count: 1,
    });
    expect(request.insertDimension?.range).toEqual({
      sheetId: 7,
      dimension: 'ROWS',
      startIndex: 3,
      endIndex: 4,
    });
    // Наследование вида от строки выше выключено осознанно: иначе вставленная строка
    // приезжает с чужим оформлением, которого человек в плане не видел.
    expect(request.insertDimension?.inheritFromBefore).toBe(false);
  });

  it('удаление колонок: три колонки со второй → startIndex 1, endIndex 4', () => {
    const request = toRequest({
      kind: 'deleteDimension',
      sheetId: 2,
      dimension: 'columns',
      at: 2,
      count: 3,
    });
    expect(request.deleteDimension?.range).toEqual({
      sheetId: 2,
      dimension: 'COLUMNS',
      startIndex: 1,
      endIndex: 4,
    });
  });

  it('лист: добавление по имени, удаление по id, переименование полем title', () => {
    expect(toRequest({ kind: 'addSheet', title: 'Октябрь' }).addSheet?.properties?.title).toBe(
      'Октябрь',
    );
    expect(toRequest({ kind: 'deleteSheet', sheetId: 5 }).deleteSheet?.sheetId).toBe(5);
    const renamed = toRequest({ kind: 'renameSheet', sheetId: 5, title: 'Проекты 2026' });
    expect(renamed.updateSheetProperties?.properties).toEqual({
      sheetId: 5,
      title: 'Проекты 2026',
    });
    // `fields` обязателен: без него Google молча обнулит остальные свойства листа.
    expect(renamed.updateSheetProperties?.fields).toBe('title');
  });
});

describe('G2 — структура входит в код плана', () => {
  const base: PlanShape = {
    targetId: 'SHEET1',
    sheet: 'Проекты',
    op: 'insertRows',
    cells: [],
    touches: [],
    structural: { kind: 'insertRows', sheet: 'Проекты', at: 4, count: 1 },
  };

  it('вставка и удаление на одной позиции — разные коды', () => {
    const remove: PlanShape = {
      ...base,
      op: 'deleteRows',
      structural: { kind: 'deleteRows', sheet: 'Проекты', at: 4, count: 1 },
    };
    // Без структуры в подписи обе правки дали бы ОДИН код: у вставки ячеек в плане нет,
    // а у удаления они те же, что были. Тот же класс, что блокер 2.5a (урок L14).
    expect(planId(remove)).not.toBe(planId(base));
  });

  it('позиция и количество меняют код, порядок полей — нет', () => {
    expect(planId({ ...base, structural: { ...base.structural!, at: 5 } })).not.toBe(planId(base));
    expect(planId({ ...base, structural: { ...base.structural!, count: 2 } })).not.toBe(
      planId(base),
    );
    const reordered: PlanShape = {
      ...base,
      structural: { count: 1, at: 4, sheet: 'Проекты', kind: 'insertRows' },
    };
    expect(canonicalPlan(reordered)).toBe(canonicalPlan(base));
  });

  it('якорь входит в подпись: «строка проекта X» — часть того, что подтверждают', () => {
    const anchored: PlanShape = {
      ...base,
      structural: { ...base.structural!, anchor: 'строка проекта G connect' },
    };
    expect(planId(anchored)).not.toBe(planId(base));
  });

  it('ячеечные планы код не меняют: у них структуры нет вовсе', () => {
    const cellPlan: PlanShape = {
      targetId: 'SHEET1',
      sheet: 'Проекты',
      op: 'upsertRow',
      cells: [{ a1: 'Проекты!F4', column: 'Статус', before: 'а', after: 'б' }],
      touches: [],
    };
    expect(planId(cellPlan)).toMatch(/^[0-9a-f]{6}$/);
    expect(JSON.parse(canonicalPlan(cellPlan))).toHaveLength(6);
  });
});
