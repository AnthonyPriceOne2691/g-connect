/** Код плана (D-16): что он обязан различать и что обязан игнорировать. */

import { describe, expect, it } from 'vitest';

import { PLAN_ID_LENGTH, canonicalPlan, planId, type PlanShape } from '../src/core/plan.js';

const base: PlanShape = {
  targetId: 'SHEET1',
  sheet: 'Лист1',
  op: 'upsertRow',
  revision: 'rev-1',
  cells: [
    { a1: 'Лист1!D3', column: 'Часы', before: 2, after: 3 },
    { a1: 'Лист1!F3', column: 'Статус', before: 'в работе', after: 'готово' },
  ],
  touches: [],
};

describe('B14 — код плана', () => {
  it('шесть символов, только hex', () => {
    expect(planId(base)).toHaveLength(PLAN_ID_LENGTH);
    expect(planId(base)).toMatch(/^[0-9a-f]{6}$/);
  });

  it('один и тот же план даёт один и тот же код', () => {
    expect(planId(base)).toBe(planId({ ...base, cells: [...base.cells] }));
  });

  it('порядок ячеек кода не меняет: иначе отказ приходил бы на честное подтверждение', () => {
    const reversed = { ...base, cells: [...base.cells].reverse() };
    expect(planId(reversed)).toBe(planId(base));
    expect(canonicalPlan(reversed)).toBe(canonicalPlan(base));
  });

  it.each([
    ['ревизия', { ...base, revision: 'rev-2' }],
    ['цель', { ...base, targetId: 'SHEET2' }],
    ['лист', { ...base, sheet: 'Лист2' }],
    ['операция', { ...base, op: 'setCells' }],
    ['значение «до»', { ...base, cells: [{ ...base.cells[0]!, before: 5 }, base.cells[1]!] }],
    ['значение «станет»', { ...base, cells: [{ ...base.cells[0]!, after: 4 }, base.cells[1]!] }],
    ['состав ячеек', { ...base, cells: [base.cells[0]!] }],
    ['что план затрагивает', { ...base, touches: ['formula'] }],
  ])('меняется, если изменилось: %s', (_name, changed) => {
    expect(planId(changed as PlanShape)).not.toBe(planId(base));
  });
});
