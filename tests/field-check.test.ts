/**
 * Незнакомое поле — отказ с названием и подсказкой (D-22, правило `input.no-silent-drop`).
 * Живой прогон 2026-10-02: опечатка `afterHeding` молча уводила вставку в конец таба.
 */

import { describe, expect, it } from 'vitest';

import { closestField, unknownFieldsDetail } from '../src/core/field-check.js';
import { fieldsOfOperation, parseOperation } from '../src/core/ops.js';

const refusal = (input: unknown): { code?: string; cause?: string; detail?: string } => {
  try {
    parseOperation(input);
  } catch (error) {
    return (error as { payload: { code?: string; cause?: string; detail?: string } }).payload;
  }
  throw new Error('разбор прошёл, а должен был отказать');
};

describe('подсказка «возможно, …»', () => {
  it('ловит опечатки, которые реально делают', () => {
    expect(closestField('afterHeding', fieldsOfOperation('appendText'))).toBe('afterHeading');
    expect(closestField('recrd', ['target', 'force', 'record'])).toBe('record');
    expect(closestField('limt', ['target', 'mode', 'limit'])).toBe('limit');
    expect(closestField('TAB', fieldsOfOperation('insertText'))).toBe('tab');
  });

  it('не подсказывает далёкое: ложная подсказка хуже никакой', () => {
    expect(closestField('zzz', fieldsOfOperation('appendText'))).toBeUndefined();
    expect(closestField('afterHeading', fieldsOfOperation('insertText'))).toBeUndefined();
  });

  it('текст отказа называет все незнакомые поля и всё допустимое', () => {
    const detail = unknownFieldsDetail(['txt', 'qq'], ['text', 'tab'], 'операции appendText');
    expect(detail).toContain('«txt» (возможно, «text»)');
    expect(detail).toContain('«qq»');
    expect(detail).toContain('Ничего не сделано');
    expect(detail).toContain('Допустимые поля: text, tab');
  });
});

describe('граница ядра: parseOperation не срезает поля молча', () => {
  it('опечатка в необязательном поле — отказ unknown_field с подсказкой', () => {
    const payload = refusal({
      op: 'appendText',
      target: 'forecast',
      text: 'Судья',
      afterHeding: 'Составы',
    });
    expect(payload).toMatchObject({ code: 'bad_request', cause: 'unknown_field' });
    expect(payload.detail).toContain('«afterHeding» (возможно, «afterHeading»)');
  });

  it('поле ДРУГОЙ операции — тоже отказ: afterHeading у insertText не работает', () => {
    // Транспорт это поле знает (оно есть у appendText), поэтому без проверки ядра оно
    // молча исчезло бы и здесь: вставка встала бы после якоря where, а не в конец раздела.
    const payload = refusal({
      op: 'insertText',
      target: 'forecast',
      text: 'Судья',
      where: { paragraphIndex: 3 },
      afterHeading: 'Составы',
    });
    expect(payload).toMatchObject({ cause: 'unknown_field' });
    expect(payload.detail).toContain('операции insertText');
    expect(payload.detail).toContain('where');
  });

  it('известные поля проходят как прежде', () => {
    const op = parseOperation({ op: 'appendText', target: 'forecast', text: 'Судья' });
    expect(op).toMatchObject({ op: 'appendText', text: 'Судья', dryRun: true });
  });
});
