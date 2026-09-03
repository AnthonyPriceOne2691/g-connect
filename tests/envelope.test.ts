/**
 * Конверт разрешений (D-18): примеры K2, K3, K10 из delivery/active/spec.md.
 *
 * Оракул на белый СПИСОК, а не на «всё, кроме»: если однажды конверт начнёт принимать
 * любое имя операции, структурные из 2.5b попадут в него молча — и откат для них нечем
 * построить, потому что журнал хранит ячейки, а не строки.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_CELLS,
  ENVELOPE_OPS,
  NAMED_CONFIRM_OPS,
  envelopeAuthorizes,
  parseEnvelope,
  type AutoEnvelope,
} from '../src/core/envelope.js';

const envelope = (over: Partial<AutoEnvelope> = {}): AutoEnvelope => ({
  ops: ['upsertRow', 'setCells', 'formatCells', 'appendRow'],
  maxCells: DEFAULT_MAX_CELLS,
  ...over,
});

describe('K10 — что вообще нельзя положить в конверт', () => {
  it('G13 — разрушающая операция отклонена при разборе, с названной причиной', () => {
    // Переведён с 2.5b: раньше причиной было «журнал хранит ячейки, а не строки», теперь
    // снимок строки есть — и причина другая, проверяемая: такая правка уничтожает то,
    // чего в ответе не видно целиком, и требует подтверждения названием (D-20).
    expect(() => parseEnvelope({ ops: ['upsertRow', 'deleteRows'] }, 'infra-test')).toThrow();
    try {
      parseEnvelope({ ops: ['deleteRows'] }, 'infra-test');
    } catch (error) {
      const payload = (error as { payload: { detail: string; cause: string } }).payload;
      expect(payload.cause).toBe('write.envelope-invalid');
      expect(payload.detail).toContain('deleteRows');
      expect(payload.detail).toContain('названием');
      expect(payload.detail).toContain('upsertRow');
    }
  });

  it('в конверт можно позиционные структурные, но ни одной разрушающей', () => {
    expect([...ENVELOPE_OPS]).toEqual([
      'appendRow',
      'upsertRow',
      'setCells',
      'formatCells',
      'findReplace',
      'insertRows',
      'insertColumns',
      'addSheet',
      'renameSheet',
      'copyRange',
      'autoFill',
      'duplicateSheet',
      'createFile',
    ]);
    // В конверте только добавляющее и обратимое: ни одного удаления, ни перемещения,
    // ни сортировки, ни вырезания — они уничтожают или перемешивают.
    for (const op of ['deleteRows', 'deleteSheet', 'cutRange', 'moveRows', 'sortRange']) {
      expect(ENVELOPE_OPS).not.toContain(op);
    }
    // Два списка не пересекаются — иначе одна операция была бы и разрешаемой, и требующей
    // подтверждения, и какая ветвь сработает, зависело бы от порядка проверок.
    for (const op of NAMED_CONFIRM_OPS) expect(ENVELOPE_OPS).not.toContain(op);
  });

  it('разрушающую операцию конверт не авторизует, даже если она в него попала', () => {
    const forced = { ops: ['deleteRows'], maxCells: 20 } as unknown as AutoEnvelope;
    const verdict = envelopeAuthorizes(forced, 'deleteRows', 1);
    expect(verdict.authorized).toBe(false);
    expect(verdict.authorized === false && verdict.reason).toContain('назвать');
  });

  it('битый конверт отказывает с причиной, а не выбирает половину', () => {
    expect(() => parseEnvelope({ ops: [] }, 'x')).toThrow();
    expect(() => parseEnvelope({ ops: 'upsertRow' }, 'x')).toThrow();
    expect(() => parseEnvelope(['upsertRow'], 'x')).toThrow();
    expect(() => parseEnvelope({ ops: ['upsertRow'], maxCells: 0 }, 'x')).toThrow();
    expect(() => parseEnvelope({ ops: ['upsertRow'], maxCells: 1.5 }, 'x')).toThrow();
    // Граница выше общего бюджета изменений ничего не значит — и об этом говорится.
    // Текст причины живёт в payload.detail: message у типизированных ошибок — из каталога.
    try {
      parseEnvelope({ ops: ['upsertRow'], maxCells: 500 }, 'x');
      expect.unreachable('конверт с границей выше бюджета обязан быть отклонён');
    } catch (error) {
      const { detail } = (error as { payload: { detail: string } }).payload;
      expect(detail).toContain('write.max-changes');
      expect(detail).toContain('500');
    }
  });

  it('конверта нет — это отсутствие разрешения, а не дефолт', () => {
    expect(parseEnvelope(undefined, 'x')).toBeNull();
    expect(parseEnvelope(null, 'x')).toBeNull();
  });

  it('граница по умолчанию — 50 ячеек, если конверт её не назвал', () => {
    expect(parseEnvelope({ ops: ['setCells'] }, 'x')?.maxCells).toBe(DEFAULT_MAX_CELLS);
  });
});

describe('K2, K3 — суждение конверта', () => {
  it('K2: цели без конверта разрешения нет, и причина названа', () => {
    const verdict = envelopeAuthorizes(null, 'upsertRow', 1);
    expect(verdict.authorized).toBe(false);
    expect(verdict.authorized === false && verdict.reason).toContain('нет конверта');
  });

  it('операция вне конверта: причина перечисляет, что в нём есть', () => {
    const verdict = envelopeAuthorizes(envelope(), 'findReplace', 1);
    expect(verdict.authorized).toBe(false);
    expect(verdict.authorized === false && verdict.reason).toContain('findReplace');
    expect(verdict.authorized === false && verdict.reason).toContain('upsertRow');
  });

  it('K3: выход за границу называет оба числа — сколько трогаем и сколько можно', () => {
    const verdict = envelopeAuthorizes(envelope({ maxCells: 50 }), 'setCells', 60);
    expect(verdict.authorized).toBe(false);
    expect(verdict.authorized === false && verdict.reason).toContain('60');
    expect(verdict.authorized === false && verdict.reason).toContain('50');
  });

  it('внутри конверта и внутри границы — разрешено', () => {
    expect(envelopeAuthorizes(envelope(), 'upsertRow', 1).authorized).toBe(true);
    expect(envelopeAuthorizes(envelope({ maxCells: 50 }), 'setCells', 50).authorized).toBe(true);
  });
});
