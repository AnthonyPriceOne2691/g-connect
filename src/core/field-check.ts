/**
 * Незнакомое поле запроса — отказ с названием, а не тишина (правило `input.no-silent-drop`).
 *
 * `z.object` по умолчанию молча срезает незнакомые ключи, и SDK MCP делал так же. Поэтому
 * опечатка в НЕОБЯЗАТЕЛЬНОМ поле исчезала без следа: `afterHeding: «Составы»` уводил вставку
 * в конец таба, а в конверте она записалась бы сразу, без плана перед человеком (converge
 * 2026-10-02, D-22). Это та же догадка, которую продукт запрещает в колонках и значениях:
 * вопрос вместо догадки. Отказ называет поле, ближайшее известное и всё, что здесь есть.
 */

import type { z } from 'zod';

/** Расстояние правки (Левенштейн): сколько вставок, удалений и замен между строками. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Ближайшее известное поле — для подсказки «возможно, afterHeading». Регистр не считается;
 * дальше одной правки на четыре буквы (и больше двух вообще) не подсказываем: ложная
 * подсказка хуже никакой — агент исправит запрос по ней.
 */
export function closestField(name: string, known: readonly string[]): string | undefined {
  const budget = Math.min(2, Math.max(1, Math.floor(name.length / 4)));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const field of known) {
    const d = editDistance(name.toLowerCase(), field.toLowerCase());
    if (d < bestDistance) {
      best = field;
      bestDistance = d;
    }
  }
  return bestDistance <= budget ? best : undefined;
}

/**
 * Текст отказа: какие поля незнакомы, что, вероятно, имелось в виду, и что здесь есть.
 * `owner` — чему поле незнакомо: «операции appendText», «инструменту gc_read».
 */
export function unknownFieldsDetail(
  unknown: readonly string[],
  known: readonly string[],
  owner: string,
): string {
  const named = unknown.map((field) => {
    const near = closestField(field, known);
    return near === undefined ? `«${field}»` : `«${field}» (возможно, «${near}»)`;
  });
  const subject =
    unknown.length === 1 ? `Поле ${named[0]!} незнакомо` : `Поля ${named.join(', ')} незнакомы`;
  return (
    `${subject} ${owner}. Ничего не сделано: незнакомое поле не пропускается молча — ` +
    `опечатка в нём увела бы правку не туда. Допустимые поля: ${known.join(', ')}.`
  );
}

/** Ключи запроса, которых нет среди известных. */
export const unknownFields = (input: unknown, known: readonly string[]): string[] =>
  input !== null && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).filter((key) => !known.includes(key))
    : [];

/**
 * Проблемы формы запроса человеческим текстом: путь и что не так. Перечисление — по-русски
 * и со списком допустимого: «значения «x» нет; допустимы: …», иначе агент угадывает.
 */
export function issuesDetail(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length === 0 ? 'корень запроса' : issue.path.join('.');
      if (issue.code === 'invalid_enum_value') {
        return `${path}: значения «${String(issue.received)}» нет; допустимы: ${issue.options.join(', ')}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
