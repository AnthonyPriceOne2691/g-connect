/**
 * Подпись плана документа (уровень 3, слайс 3): что различает код плана.
 * Класс L14: две правки, отличающиеся только стилем или только позицией, обязаны
 * давать разные коды — иначе человек подписывает не то, что читает.
 */

import { describe, expect, it } from 'vitest';

import { canonicalDocPlan, docPlanId, type DocPlanShape } from '../src/core/docs/plan.js';

const base: DocPlanShape = {
  targetId: 'DOC1',
  op: 'insertText',
  revisionId: 'rev-7',
  changes: [
    {
      kind: 'insertText',
      tab: 'Прогноз',
      startIndex: 120,
      endIndex: 120,
      anchor: 'после абзаца № 4: Основа выйдет…',
      after: 'Судья: Раморенко',
    },
  ],
};

describe('код плана документа', () => {
  it('шесть hex, стабилен для одинаковых планов', () => {
    expect(docPlanId(base)).toMatch(/^[0-9a-f]{6}$/);
    expect(docPlanId({ ...base })).toBe(docPlanId(base));
  });

  it('различает планы, отличающиеся ТОЛЬКО позицией', () => {
    const moved: DocPlanShape = {
      ...base,
      changes: [{ ...base.changes[0]!, startIndex: 121, endIndex: 121 }],
    };
    expect(docPlanId(moved)).not.toBe(docPlanId(base));
  });

  it('различает планы, отличающиеся ТОЛЬКО стилем (класс L14)', () => {
    const styled: DocPlanShape = {
      ...base,
      changes: [{ ...base.changes[0]!, afterStyle: { bold: true } }],
    };
    expect(docPlanId(styled)).not.toBe(docPlanId(base));
  });

  it('различает планы на разных ревизиях: ревизия — часть подписи, сервер сверит её же', () => {
    expect(docPlanId({ ...base, revisionId: 'rev-8' })).not.toBe(docPlanId(base));
  });

  it('порядок правок и порядок ключей стиля не меняют код', () => {
    const a: DocPlanShape = {
      ...base,
      changes: [
        {
          kind: 'x',
          tab: 'Т',
          startIndex: 5,
          endIndex: 9,
          afterStyle: { bold: true, italic: false },
        },
        { kind: 'x', tab: 'Т', startIndex: 1, endIndex: 3 },
      ],
    };
    const b: DocPlanShape = {
      ...base,
      changes: [
        { kind: 'x', tab: 'Т', startIndex: 1, endIndex: 3 },
        {
          kind: 'x',
          tab: 'Т',
          startIndex: 5,
          endIndex: 9,
          afterStyle: { italic: false, bold: true },
        },
      ],
    };
    expect(docPlanId(a)).toBe(docPlanId(b));
    expect(canonicalDocPlan(a)).toBe(canonicalDocPlan(b));
  });
});
