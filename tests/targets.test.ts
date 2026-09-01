import { describe, expect, it } from 'vitest';

import {
  assertWritable,
  parseTargetUrl,
  resolveTarget,
  type Registry,
} from '../src/core/targets.ts';

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

const registry: Registry = {
  targets: [
    { alias: 'log', id: ID, type: 'sheet', allow: 'write', sheet: 'Лист1', headerRow: 2 },
    { alias: 'reference', id: 'DOCID000000000000000000', type: 'doc' },
  ],
};

describe('резолв цели', () => {
  it('узнаёт тип по URL: документ, таблица, форма, папка', () => {
    expect(parseTargetUrl(`https://docs.google.com/document/d/${ID}/edit`)).toEqual({
      id: ID,
      type: 'doc',
    });
    expect(parseTargetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)?.type).toBe(
      'sheet',
    );
    expect(parseTargetUrl(`https://docs.google.com/forms/d/${ID}/edit`)?.type).toBe('form');
    expect(parseTargetUrl(`https://drive.google.com/drive/folders/${ID}`)?.type).toBe('folder');
    expect(parseTargetUrl('https://example.com/doc/1')).toBeNull();
  });

  it('alias из реестра приносит право записи и параметры листа', () => {
    const target = resolveTarget('log', registry);
    expect(target.id).toBe(ID);
    expect(target.allow).toBe('write');
    expect(target.entry?.headerRow).toBe(2);
  });

  it('произвольная ссылка даёт только чтение, даже если ID тот же (§11.2)', () => {
    const target = resolveTarget(`https://docs.google.com/spreadsheets/d/UNLISTED0000000000000/edit`);
    expect(target.allow).toBe('read');
    expect(() => {
      assertWritable(target);
    }).toThrowError(/policy_denied/);
  });

  it('ссылка на цель из реестра всё же поднимает её права: это тот же файл', () => {
    const target = resolveTarget(`https://docs.google.com/spreadsheets/d/${ID}/edit`, registry);
    expect(target.alias).toBe('log');
    expect(target.allow).toBe('write');
    expect(() => {
      assertWritable(target);
    }).not.toThrow();
  });

  it('read-only цель из реестра остаётся read-only', () => {
    expect(() => {
      assertWritable(resolveTarget('reference', registry));
    }).toThrowError(/policy_denied/);
  });

  it('голый ID принимается, мусор — нет, и в ошибке перечислены алиасы', () => {
    expect(resolveTarget(ID).id).toBe(ID);
    try {
      resolveTarget('таблица с отчётами', registry);
      expect.unreachable('должно бросить');
    } catch (error) {
      const payload = (error as { payload: { code: string; detail?: string } }).payload;
      expect(payload.code).toBe('ambiguous_target');
      expect(payload.detail).toContain('log');
      expect(payload.detail).toContain('reference');
    }
  });

  it('пустая ссылка → bad_request, а не пустой резолв', () => {
    expect(() => resolveTarget('   ')).toThrowError(/bad_request/);
  });

  it('дубль алиаса в реестре — ошибка, а не «возьму первый»', () => {
    const dup: Registry = {
      targets: [
        { alias: 'log', id: 'A'.repeat(25), type: 'sheet' },
        { alias: 'log', id: 'B'.repeat(25), type: 'sheet' },
      ],
    };
    expect(() => resolveTarget('log', dup)).toThrowError(/ambiguous_target/);
  });

  it('без реестра ядро работает: чтение произвольной таблицы (D-10)', () => {
    const target = resolveTarget(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
    expect(target.type).toBe('sheet');
    expect(target.alias).toBeNull();
    expect(target.entry).toBeNull();
  });
});
