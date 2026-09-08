/**
 * План правки документа и его код (D-16 для уровня 3).
 *
 * Отличие от плана таблиц, и оно принципиально: в подписи ЕСТЬ ревизия документа.
 * У таблиц ревизию из подписи убрали (урок L18 — `version` Drive растёт от невидимых
 * серверных изменений и рвал честные подтверждения). Здесь источник другой: `revisionId`
 * выдаёт Docs API, и сверяет его ТОТ ЖЕ сервер при записи (`writeControl`) — подпись и
 * предусловие держатся на одном механизме, расходиться нечему. Протухшая ревизия — не
 * дефект, а штатный `doc_changed`: план перестраивается на свежем чтении.
 */

import { createHash } from 'node:crypto';

import { PLAN_ID_LENGTH } from '../plan.js';
import type { DocTextStyle } from './types.js';

/** Одна правка плана: диапазон, якорь для человека, «было → станет». */
export interface DocPlanChange {
  readonly kind: string;
  readonly tab: string;
  readonly startIndex: number;
  readonly endIndex: number;
  /** Якорь, которым правку читает человек: «после абзаца № 4: Основа выйдет…». */
  readonly anchor?: string;
  readonly before?: string;
  readonly after?: string;
  readonly beforeStyle?: DocTextStyle;
  readonly afterStyle?: DocTextStyle;
}

export interface DocPlanShape {
  readonly targetId: string;
  readonly op: string;
  /** Ревизия, на которой построен план, — её же потребует запись (`writeControl`). */
  readonly revisionId: string;
  readonly changes: readonly DocPlanChange[];
}

const sortedPairs = (value: object | undefined): readonly (readonly [string, unknown])[] =>
  value === undefined
    ? []
    : Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * Канонический вид: правки в порядке позиций, стиль — отсортированными парами.
 * Две правки, отличающиеся ТОЛЬКО стилем или ТОЛЬКО позицией, обязаны давать разные
 * коды (класс L14: иначе человек подписывает не то, что читает).
 */
export function canonicalDocPlan(plan: DocPlanShape): string {
  const changes = [...plan.changes]
    .sort((a, b) => a.startIndex - b.startIndex || (a.tab < b.tab ? -1 : 1))
    .map((c) => [
      c.kind,
      c.tab,
      c.startIndex,
      c.endIndex,
      c.anchor ?? null,
      c.before ?? null,
      c.after ?? null,
      sortedPairs(c.beforeStyle),
      sortedPairs(c.afterStyle),
    ]);
  return JSON.stringify([plan.targetId, plan.op, plan.revisionId, changes]);
}

/** Код плана документа: тот же приём, что у таблиц, — sha256 канонического вида. */
export function docPlanId(plan: DocPlanShape): string {
  return createHash('sha256').update(canonicalDocPlan(plan)).digest('hex').slice(0, PLAN_ID_LENGTH);
}
