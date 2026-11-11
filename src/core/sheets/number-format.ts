/**
 * Типы формата числа Google (D-26, Q11–Q12) — ОДИН список на границу и на шов.
 *
 * Схема правки (`ops.ts`) пропускает только их, шов (`google/cell-format.ts`) только их и
 * читает: тип, которого здесь нет (`NUMBER_FORMAT_TYPE_UNSPECIFIED` или новый у Google), в домен
 * не попадает — записать такой вид обратно, а значит и откатить его, ядро не смогло бы. Таблица
 * по типу, а не второй рукописный список (урок L21): пропущенный или лишний тип TypeScript не
 * пустит.
 */

import type { NumberFormatType } from './types.js';

const TYPES: Readonly<Record<NumberFormatType, true>> = {
  TEXT: true,
  NUMBER: true,
  PERCENT: true,
  CURRENCY: true,
  DATE: true,
  TIME: true,
  DATE_TIME: true,
  SCIENTIFIC: true,
};

/** Для `z.enum`: непустой кортеж по построению — таблица выше и есть состав типов. */
export const NUMBER_FORMAT_TYPES = Object.keys(TYPES) as [NumberFormatType, ...NumberFormatType[]];

export const isNumberFormatType = (value: string): value is NumberFormatType =>
  Object.hasOwn(TYPES, value);
