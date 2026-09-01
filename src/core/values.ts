/**
 * Нормализация значений под колонку (DESIGN.md §8.3).
 *
 * Разделение, которое здесь главное: **опечатка правится молча, новое значение
 * спрашивается**. «в работе» при допустимых «В работе» — регистр. «почти готово» —
 * не опечатка, а решение человека, и решать его за него нельзя.
 */

import { gcError } from './errors.js';
import { normalizeName } from './resolver.js';
import type { CellValue, ColumnProfile } from './sheets/types.js';

export type ValueOutcome =
  | { readonly status: 'ok'; readonly value: CellValue; readonly note: string | null }
  | {
      readonly status: 'clarify';
      readonly reason: 'not_in_enum' | 'not_a_number' | 'not_a_date';
      readonly candidates: readonly string[];
      readonly detail: string;
    };

export interface NormalizeOptions {
  /** Инжектируется, чтобы «сегодня» было проверяемым. */
  readonly now?: Date;
}

const MONTHS = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
];

const pad = (n: number): string => String(n).padStart(2, '0');

function formatDate(date: Date, format: 'iso' | 'dotted' | null): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  return format === 'dotted' ? `${d}.${m}.${y}` : `${y}-${m}-${d}`;
}

function parseDate(raw: string, now: Date): Date | null {
  const lower = normalizeName(raw);
  if (lower === 'сегодня' || lower === 'today') return now;
  if (lower === 'вчера' || lower === 'yesterday') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  }
  if (lower === 'завтра' || lower === 'tomorrow') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (iso !== null) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const dotted = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(raw.trim());
  if (dotted !== null) {
    const year = Number(dotted[3]);
    return new Date(year < 100 ? 2000 + year : year, Number(dotted[2]) - 1, Number(dotted[1]));
  }
  // «1 сентября» и «1 сентября 2026»: без года берётся год из `now`.
  const words = /^(\d{1,2})\s+([а-яё]+)\s*(\d{4})?$/.exec(lower);
  if (words !== null) {
    const monthIndex = MONTHS.findIndex((m) => (words[2] ?? '').startsWith(m));
    if (monthIndex !== -1) {
      const year = words[3] === undefined ? now.getFullYear() : Number(words[3]);
      return new Date(year, monthIndex, Number(words[1]));
    }
  }
  return null;
}

function parseNumber(raw: string): number | null {
  // «3ч», «3 ч», «3ч.», «3,5», «1 200» — единицы отбрасываются, но только если в остатке
  // нет цифр. Так «много» числом не станет, а «3.5.6» и «2026-09-01» будут отвергнуты.
  // Первая версия срезала хвост регуляркой `[^\d.-]+$` и спотыкалась на «3ч.»: точка
  // входила в разрешённый набор, поэтому хвост не срезался вовсе. Нашёл property-тест.
  const compact = raw.replace(/\s+/g, '').replace(/,/g, '.');
  const head = /^-?\d+(?:\.\d+)?/.exec(compact);
  if (head === null) return null;
  const rest = compact.slice(head[0].length);
  if (/\d/.test(rest)) return null;
  return Number(head[0]);
}

export function normalizeValue(
  raw: unknown,
  column: ColumnProfile,
  options: NormalizeOptions = {},
): ValueOutcome {
  if (raw === null || raw === undefined || raw === '') {
    return { status: 'ok', value: null, note: null };
  }
  // Объект или массив в ячейку не пишем: `String({})` даёт «[object Object]», и это
  // уехало бы в таблицу молча. Нашёл гейт линтера (no-base-to-string).
  if (typeof raw === 'object' || typeof raw === 'function' || typeof raw === 'symbol') {
    throw gcError('bad_request', {
      detail:
        `В колонку «${column.name}» передано значение типа ${typeof raw}, ` +
        'а в ячейку пишется одно простое значение. Разложи его по колонкам.',
      cause: 'non_primitive_value',
    });
  }
  // Приведение по типу, а не общий String(): так линтер (и читатель) видит, что
  // «[object Object]» в ячейку попасть не может ни при каком входе.
  const asText =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean'
        ? String(raw)
        : '';

  if (column.enumValues !== null && column.enumValues.length > 0) {
    const target = normalizeName(asText);
    const hit = column.enumValues.find((v) => normalizeName(v) === target);
    if (hit !== undefined) {
      return {
        status: 'ok',
        value: hit,
        note: hit === asText ? null : `«${asText}» приведено к «${hit}»`,
      };
    }
    return {
      status: 'clarify',
      reason: 'not_in_enum',
      candidates: column.enumValues,
      detail:
        `«${asText}» нет среди допустимых значений колонки «${column.name}»` +
        (column.enumSource === 'validation'
          ? ' (список задан проверкой данных в таблице).'
          : ' (список выведен по тому, что уже записано).'),
    };
  }

  if (column.type === 'number') {
    if (typeof raw === 'number') return { status: 'ok', value: raw, note: null };
    const parsed = parseNumber(asText);
    if (parsed === null) {
      return {
        status: 'clarify',
        reason: 'not_a_number',
        candidates: [],
        detail: `Колонка «${column.name}» числовая, а «${asText}» числом не является.`,
      };
    }
    return {
      status: 'ok',
      value: parsed,
      note: String(parsed) === asText ? null : `«${asText}» разобрано как ${parsed}`,
    };
  }

  if (column.type === 'date') {
    const parsed = parseDate(asText, options.now ?? new Date());
    if (parsed === null) {
      return {
        status: 'clarify',
        reason: 'not_a_date',
        candidates: [],
        detail: `Колонка «${column.name}» с датами, а «${asText}» датой не читается.`,
      };
    }
    const formatted = formatDate(parsed, column.dateFormat);
    return {
      status: 'ok',
      value: formatted,
      note: formatted === asText ? null : `«${asText}» записано как ${formatted}`,
    };
  }

  if (column.type === 'boolean') {
    if (typeof raw === 'boolean') return { status: 'ok', value: raw, note: null };
    const yes = /^(да|true|yes|1)$/i.test(asText);
    const no = /^(нет|false|no|0)$/i.test(asText);
    if (yes || no) {
      return {
        status: 'ok',
        value: yes,
        note: `«${asText}» записано как ${yes ? 'да' : 'нет'}`,
      };
    }
  }

  return { status: 'ok', value: typeof raw === 'number' ? raw : asText, note: null };
}
