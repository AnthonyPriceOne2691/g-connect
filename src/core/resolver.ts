/**
 * Резолвер имён колонок: шесть ступеней от «молча» к «вопросу» (DESIGN.md §8.2, D-7).
 *
 * Логика детерминированная и живёт здесь, а не в модели: требование «если ошибся —
 * уточни на основе тех, что есть» должно вести себя одинаково у любого провайдера
 * и от запуска к запуску.
 */

import type { ColumnProfile } from './sheets/types.ts';

export type ResolveStep = 'exact' | 'normalized' | 'alias' | 'fuzzy' | 'ambiguous' | 'missing';

export interface ResolveResult {
  readonly step: ResolveStep;
  readonly column: ColumnProfile | null;
  /** Текст для `assumptions` превью — заполнен только на ступени 4 (§8.2). */
  readonly assumption: string | null;
  readonly candidates: readonly string[];
}

/** Латинские двойники кириллицы: «c» в «Cтатус» глазом не отличить, а строки разные. */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  A: 'а',
  B: 'в',
  C: 'с',
  E: 'е',
  H: 'н',
  K: 'к',
  M: 'м',
  O: 'о',
  P: 'р',
  T: 'т',
  X: 'х',
  Y: 'у',
};

export function normalizeName(name: string): string {
  const mapped = [...name.trim()].map((ch) => HOMOGLYPHS[ch] ?? ch).join('');
  return mapped
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (name: string): string[] => normalizeName(name).split(' ').filter(Boolean);

/** Расстояние Левенштейна: нужно ровно для опечаток вида «Стаус» → «Статус». */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/**
 * Насколько запрошенное имя похоже на колонку. Два независимых основания:
 * вложенность токенов («статус проекта» ⊃ «статус») и опечатка (близость строк).
 * Порог высокий сознательно: «Бюджет» не должен «оказаться похож» на «Часы».
 */
const TYPO_THRESHOLD = 0.7;

function score(requested: string, column: string): number {
  const rq = normalizeName(requested);
  const cl = normalizeName(column);
  const rqTokens = tokens(requested);
  const clTokens = tokens(column);

  if (clTokens.length > 0 && clTokens.every((t) => rqTokens.includes(t))) return 0.95;
  if (rqTokens.length > 0 && rqTokens.every((t) => clTokens.includes(t))) return 0.9;

  const sim = similarity(rq, cl);
  return sim >= TYPO_THRESHOLD ? sim : 0;
}

export interface ResolveOptions {
  /** Подтверждённые человеком синонимы из реестра: колонка → её алиасы (§8.5). */
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
}

export function resolveColumn(
  requested: string,
  columns: readonly ColumnProfile[],
  options: ResolveOptions = {},
): ResolveResult {
  const all = columns.map((c) => c.name);
  const empty = { column: null, assumption: null } as const;

  // Ступень 1 — точное совпадение.
  const exact = columns.filter((c) => c.name === requested);
  if (exact.length === 1) {
    return { step: 'exact', column: exact[0]!, assumption: null, candidates: [] };
  }

  // Ступень 2 — нормализация: регистр, пробелы, ё/е, латинские двойники.
  const target = normalizeName(requested);
  const normalized = columns.filter((c) => normalizeName(c.name) === target);
  if (normalized.length === 1) {
    return { step: 'normalized', column: normalized[0]!, assumption: null, candidates: [] };
  }
  if (normalized.length > 1) {
    return {
      step: 'ambiguous',
      ...empty,
      candidates: normalized.map((c) => c.name),
    };
  }

  // Ступень 3 — подтверждённый алиас из реестра: молча, как точное совпадение.
  const aliases = options.aliases ?? {};
  const aliasHits = columns.filter((c) =>
    (aliases[c.name] ?? []).some((a) => normalizeName(a) === target),
  );
  if (aliasHits.length === 1) {
    return { step: 'alias', column: aliasHits[0]!, assumption: null, candidates: [] };
  }
  if (aliasHits.length > 1) {
    return { step: 'ambiguous', ...empty, candidates: aliasHits.map((c) => c.name) };
  }

  // Ступени 4 и 5 — близость: один явный кандидат пишет с оговоркой, несколько — вопрос.
  const scored = columns
    .map((column) => ({ column, value: score(requested, column.name) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  if (scored.length === 1 || (scored.length > 1 && scored[0]!.value - scored[1]!.value >= 0.1)) {
    const winner = scored[0]!.column;
    return {
      step: 'fuzzy',
      column: winner,
      assumption: `«${requested}» → колонка «${winner.name}»`,
      candidates: scored.slice(1).map((s) => s.column.name),
    };
  }
  if (scored.length > 1) {
    return { step: 'ambiguous', ...empty, candidates: scored.map((s) => s.column.name) };
  }

  // Ступень 6 — ничего похожего: вопрос со полным списком, колонку не создаём.
  return { step: 'missing', ...empty, candidates: all };
}

/** Ступени 1–3 идут молча, 4 — с оговоркой в превью, 5–6 — вопросом. */
export function isSilent(step: ResolveStep): boolean {
  return step === 'exact' || step === 'normalized' || step === 'alias';
}

export function needsClarification(step: ResolveStep): boolean {
  return step === 'ambiguous' || step === 'missing';
}
