/**
 * Схема транспорта `gc_apply` против схем ядра — по ПОЛЯМ, а не только по именам операций.
 *
 * Живой прогон 2026-10-02 через протокол: ни одна правка документа не доходила до ядра.
 * SDK MCP собирает из `applyInput` объект zod, молча выбрасывает незнакомые ключи и отдаёт
 * обработчику уже обрезанный запрос, а doc-полей (`tab`, `text`, `uri`, …) в схеме не было.
 * Остальные тесты этого не видят в принципе: они зовут `handle` напрямую, мимо транспорта.
 * Поэтому здесь транспорт воспроизведён буквально — `z.object(applyInput)`, как в SDK.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DOC_OPERATION_NAMES,
  OPERATION_NAMES,
  operationSchema,
  parseOperation,
  type OperationName,
} from '../src/core/ops.js';
import { applyInput, operationOf } from '../src/mcp/apply-schema.js';

/** Транспорт ровно так, как его применяет `McpServer.validateToolInput`. */
const transport = z.object(applyInput);

const shapeOf = (op: OperationName): Record<string, z.ZodTypeAny> => {
  const schema = operationSchema.options.find((o) => o.shape.op.value === op);
  if (schema === undefined) throw new Error(`в ядре нет схемы ${op}`);
  return schema.shape as Record<string, z.ZodTypeAny>;
};

/**
 * Значение на КАЖДОЕ поле ядра. Где у поля есть значение по умолчанию, взято другое: иначе
 * потерянное поле вернулось бы умолчанием, и сравнение его бы не заметило.
 */
const SAMPLE: Record<string, unknown> = {
  target: 'doc-test',
  sheet: 'Лист1',
  headerRow: 2,
  dryRun: false,
  force: true,
  confirm: 'удаляю строку Иванов',
  planId: 'a1b2c3',
  expectRevision: 'rev-7',
  key: { Проект: 'G connect' },
  values: { Статус: 'готово' },
  format: { bold: true },
  includeHeader: true,
  find: 'Fluminense',
  replace: 'Fluminense FC',
  matchCase: true,
  matchEntireCell: true,
  searchByRegex: true,
  count: 2,
  below: false,
  column: 'Статус',
  toColumn: 'Итог',
  paste: 'values',
  before: { Проект: 'AutoLink' },
  descending: true,
  title: 'Октябрь',
  name: 'Отчёт',
  tab: 'Прогноз',
  text: 'Судья: Раморенко',
  afterHeading: 'Составы',
  uri: 'https://example.com/lineup.png',
  style: { bold: true, fontSize: 12, color: '#112233' },
  namedStyle: 'HEADING_2',
  rows: 2,
  table: 1,
  tableWithCell: 'Иванов',
  rowWithCell: 'Иванов',
  rowIndex: 2,
  columnTitle: 'Игрок',
  columnIndex: 2,
  right: false,
  startIndex: 5,
  endIndex: 9,
};

/** Поля, чей смысл зависит от вида цели: у документа `where` — селектор абзаца. */
function sampleFor(op: OperationName): Record<string, unknown> {
  const isDoc = DOC_OPERATION_NAMES.includes(op);
  const special: Record<string, unknown> = {
    where: isDoc ? { textStartsWith: 'Составы' } : { Проект: 'G connect' },
    columns: op === 'insertTable' ? 3 : ['Статус'],
  };
  const sample: Record<string, unknown> = { op };
  for (const field of Object.keys(shapeOf(op))) {
    if (field === 'op') continue;
    sample[field] = field in special ? special[field] : SAMPLE[field];
  }
  return sample;
}

describe('схема транспорта gc_apply против ядра — по полям (живой прогон 2026-10-02)', () => {
  it('каждое поле каждой операции ядра объявлено в схеме транспорта', () => {
    const declared = new Set(Object.keys(applyInput));
    const missing = OPERATION_NAMES.flatMap((op) =>
      Object.keys(shapeOf(op))
        .filter((field) => !declared.has(field))
        .map((field) => `${op}.${field}`),
    );
    expect(missing).toEqual([]);
  });

  it('образец каждой операции заполняет ВСЕ её поля и сам проходит ядро', () => {
    // Оракул ниже пуст, если образец неполон или ядро его отклоняет: проверяем сам образец.
    for (const op of OPERATION_NAMES) {
      const sample = sampleFor(op);
      expect(Object.keys(sample).sort(), op).toEqual(Object.keys(shapeOf(op)).sort());
      expect(Object.values(sample).includes(undefined), `${op}: поле без образца`).toBe(false);
      const core = operationSchema.safeParse(sample);
      expect(core.success, `${op}: ${core.success ? '' : core.error.message}`).toBe(true);
    }
  });

  it('каждая операция ядра проходит транспорт без потерь: ядро получает тот же запрос', () => {
    for (const op of OPERATION_NAMES) {
      const sample = sampleFor(op);
      const carried = transport.safeParse(sample);
      expect(carried.success, `${op}: транспорт отклонил — ${carried.error?.message ?? ''}`).toBe(
        true,
      );
      // Тем же путём, что обработчик: поля транспорта сняты, ядро разбирает строго.
      expect(operationOf(carried.data!), op).toEqual(parseOperation(sample));
    }
  });

  it('у каждого doc-поля транспорта есть описание: его читает модель, а не человек', () => {
    const docFields = new Set(
      DOC_OPERATION_NAMES.flatMap((op) => Object.keys(shapeOf(op))).filter(
        (field) => !(field in shapeOf('appendRow')),
      ),
    );
    const silent = [...docFields].filter(
      (field) => (applyInput as Record<string, z.ZodTypeAny>)[field]?.description === undefined,
    );
    expect(silent).toEqual([]);
  });
});
