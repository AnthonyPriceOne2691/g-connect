/** Код плана (D-16): что он обязан различать и что обязан игнорировать. */

import { describe, expect, it } from 'vitest';

import { PLAN_ID_LENGTH, canonicalPlan, planId, type PlanShape } from '../src/core/plan.js';

const base: PlanShape = {
  targetId: 'SHEET1',
  sheet: 'Лист1',
  op: 'upsertRow',
  cells: [
    { a1: 'Лист1!D3', column: 'Часы', before: 2, after: 3 },
    { a1: 'Лист1!F3', column: 'Статус', before: 'в работе', after: 'готово' },
  ],
  touches: [],
};

describe('R1 — ревизии в подписи нет (D-18)', () => {
  /**
   * Оракул перевёрнут осознанно: до 2026-09-03 здесь стоял случай «меняется, если
   * изменилась ревизия». Он закреплял обещание, которое источник исполнить не мог —
   * `version` Drive растёт и без правок пользователя, — и тем самым охранял ложные
   * отказы на честном подтверждении. Форма оракула: в каноническом виде ровно пять
   * полей, и ревизия обратно не пролезет молча.
   */
  it('R1 — канонический вид: цель, лист, операция, ячейки, touches, и ничего больше', () => {
    const parsed = JSON.parse(canonicalPlan(base)) as unknown[];
    expect(parsed).toHaveLength(5);
    expect(parsed.slice(0, 3)).toEqual(['SHEET1', 'Лист1', 'upsertRow']);
  });
});

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

/**
 * Вид внутри кода плана. Мутационный гейт показал `plan.ts` 57.5% — самое слабое место
 * фазы 2.5a, и ровно там жил блокер 2026-09-03 (вид сериализовался, но не заполнялся).
 * Поэтому оракулы здесь на СВЯЗЬ, а не на концы: что именно попадает в подпись.
 */
describe('вид в коде плана', () => {
  const withFormat = (cells: PlanShape['cells']): PlanShape => ({ ...base, cells });
  const cell = (over: Partial<PlanShape['cells'][number]> = {}): PlanShape['cells'][number] => ({
    a1: 'Лист1!C3',
    column: 'Статус',
    before: 'в работе',
    after: 'в работе',
    ...over,
  });

  it('порядок ключей вида кода не меняет', () => {
    const a = withFormat([cell({ afterFormat: { bold: true, italic: true } })]);
    const b = withFormat([cell({ afterFormat: { italic: true, bold: true } })]);
    expect(planId(a)).toBe(planId(b));
  });

  it('другое ЗНАЧЕНИЕ поля вида — другой код', () => {
    const on = withFormat([cell({ afterFormat: { bold: true } })]);
    const off = withFormat([cell({ afterFormat: { bold: false } })]);
    expect(planId(on)).not.toBe(planId(off));
  });

  it('другое ПОЛЕ вида — другой код', () => {
    const bold = withFormat([cell({ afterFormat: { bold: true } })]);
    const italic = withFormat([cell({ afterFormat: { italic: true } })]);
    expect(planId(bold)).not.toBe(planId(italic));
  });

  it('вид «до» тоже входит в подпись: от него зависит откат', () => {
    const from = withFormat([
      cell({ beforeFormat: { align: 'right' }, afterFormat: { bold: true } }),
    ]);
    const clean = withFormat([cell({ afterFormat: { bold: true } })]);
    expect(planId(from)).not.toBe(planId(clean));
  });

  it('план без вида и план с пустым видом дают один код', () => {
    const none = withFormat([cell()]);
    const empty = withFormat([cell({ afterFormat: {} })]);
    expect(planId(none)).toBe(planId(empty));
  });
});
