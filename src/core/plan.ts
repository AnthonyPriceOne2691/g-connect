/**
 * План записи и его код (D-16, фаза 2.6).
 *
 * Зачем: между превью и записью не было связи. Человек читал план P, говорил «пиши», а
 * вторым вызовом могло прийти P′ — и ядро записывало P′, потому что связи между вызовами
 * не существовало. Код плана делает подтверждение подписью под КОНКРЕТНОЙ правкой.
 *
 * Код считается из фактического состояния и НЕ хранится: хранилище планов было бы
 * четвёртой копией правды рядом с таблицей, журналом и снимком «до» — с TTL, ротацией и
 * молчаливым расхождением (решение от 2026-09-02).
 */

import { createHash } from 'node:crypto';

import type { CellFormat, CellValue } from './sheets/types.js';

/**
 * Длина кода — шесть символов (решение владельца 2026-09-02). Защита не от подбора: её
 * тут нет и она не заявляется. Защита от невнимательности — четыре символа человек
 * набирает «по памяти похоже», шесть уже нет.
 */
export const PLAN_ID_LENGTH = 6;

export interface PlanCell {
  readonly a1: string;
  readonly column: string;
  readonly before: CellValue;
  readonly after: CellValue;
  /** Вид «до» и «после» для правок вида — часть подписи, а не украшение. */
  readonly beforeFormat?: CellFormat;
  readonly afterFormat?: CellFormat;
}

/** Что в плане опасного: формульная колонка, защищённый диапазон. */
export type PlanTouch = 'formula' | 'protected';

export interface PlanShape {
  readonly targetId: string;
  readonly sheet: string;
  readonly op: string;
  /** Ревизия, на которой построен план: правка таблицы обязана менять код. */
  readonly revision: string | null;
  readonly cells: readonly PlanCell[];
  /**
   * Входит в код плана намеренно: подтверждая код, человек подтверждает и то, что правка
   * лезет в формульную или защищённую колонку. Иначе `force` оставался бы решением модели.
   */
  readonly touches: readonly PlanTouch[];
}

/** Вид как отсортированные пары: порядок ключей в объекте не должен менять код плана. */
function sortedFormat(format: CellFormat | undefined): readonly (readonly [string, unknown])[] {
  if (format === undefined) return [];
  return Object.entries(format)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => [key, value] as const);
}

/**
 * Канонический вид: фиксированный порядок полей и ячейки по адресу. Сортировка не
 * косметика — без неё один и тот же план, собранный в другом порядке обхода строк, дал бы
 * другой код, и человек получил бы отказ на честном подтверждении.
 */
export function canonicalPlan(plan: PlanShape): string {
  const cells = [...plan.cells]
    .sort((a, b) => (a.a1 < b.a1 ? -1 : a.a1 > b.a1 ? 1 : 0))
    .map((c) => [
      c.a1,
      c.column,
      c.before,
      c.after,
      // Вид сериализуется отсортированными парами: `{bold, italic}` и `{italic, bold}` —
      // один и тот же вид, и код плана обязан быть одним.
      sortedFormat(c.beforeFormat),
      sortedFormat(c.afterFormat),
    ]);
  const touches = [...plan.touches].sort();
  return JSON.stringify([plan.targetId, plan.sheet, plan.op, plan.revision, cells, touches]);
}

/** Код плана: первые символы sha256 от канонического вида. */
export function planId(plan: PlanShape): string {
  return createHash('sha256').update(canonicalPlan(plan)).digest('hex').slice(0, PLAN_ID_LENGTH);
}
