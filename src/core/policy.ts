/**
 * Правила как механизм (DESIGN.md §12.4, D-12).
 *
 * `rules.json` читается ЯДРОМ и исполняется независимо от того, прочитала ли его модель.
 * `rules.md` объясняет то же человеку и уходит клиенту как ресурс — но объяснение это
 * вежливость, а запрет здесь.
 *
 * Инвариант, который держит тест: у каждого правила из `rules.json` есть точка отказа
 * в коде. Добавить правило и не исполнить его — значит объявить защиту, которой нет.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gcError } from './errors.ts';

export type RuleKind = 'deny' | 'limit' | 'ask' | 'default' | 'invariant';

export interface PolicyRule {
  readonly id: string;
  readonly title: string;
  readonly kind: RuleKind;
  readonly value?: number | boolean;
  /** Где именно правило отказывает — читается человеком и сверяется тестом. */
  readonly enforced_in: string;
  readonly probe: string;
}

interface PolicyFile {
  readonly version: number;
  readonly rules: readonly PolicyRule[];
}

const POLICY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy');

let cached: PolicyFile | null = null;

function load(): PolicyFile {
  if (cached !== null) return cached;
  try {
    cached = JSON.parse(readFileSync(join(POLICY_DIR, 'rules.json'), 'utf8')) as PolicyFile;
    return cached;
  } catch (error) {
    // Без правил ядро не работает: молча продолжить значило бы работать без ограничений.
    throw gcError('internal', {
      detail: 'Файл правил src/policy/rules.json не читается — ядро без правил не работает.',
      cause: (error as Error).message,
    });
  }
}

export function policyRules(): readonly PolicyRule[] {
  return load().rules;
}

export function policyVersion(): number {
  return load().version;
}

export function ruleById(id: string): PolicyRule {
  const rule = policyRules().find((r) => r.id === id);
  if (rule === undefined) {
    throw gcError('internal', {
      detail: `Правила «${id}» нет в rules.json.`,
      cause: 'unknown_rule',
    });
  }
  return rule;
}

/** Числовой лимит правила. Дефолт в коде — только страховка, источник истины — файл. */
export function limitOf(id: string, fallback: number): number {
  const value = ruleById(id).value;
  return typeof value === 'number' ? value : fallback;
}

/** Отказ по правилу: в тексте всегда есть его id — иначе непонятно, что менять. */
export function denyByRule(id: string, detail: string): never {
  const rule = ruleById(id);
  throw gcError('policy_denied', {
    detail: `${detail} Правило «${rule.id}»: ${rule.title}.`,
    cause: rule.id,
  });
}

/** Бюджет изменений за вызов (`write.max-changes`). */
export function assertChangeBudget(changeCount: number): void {
  const max = limitOf('write.max-changes', 200);
  if (changeCount <= max) return;
  denyByRule(
    'write.max-changes',
    `План содержит ${changeCount} изменений, разрешено ${max} за вызов. Раздели правку.`,
  );
}

/** Человекочитаемая политика для `instructions` сервера и ресурса `policy://rules`. */
export function policyText(): string {
  try {
    return readFileSync(join(POLICY_DIR, 'rules.md'), 'utf8');
  } catch (error) {
    throw gcError('internal', {
      detail: 'Файл политики src/policy/rules.md не читается.',
      cause: (error as Error).message,
    });
  }
}

/**
 * Пометка прочитанного как ДАННЫХ (`content.is-data`).
 *
 * Обёртка нужна не для красоты: она делает невозможным случайно передать содержимое
 * документа туда, где ждут инструкцию, — тип не совпадёт. Инструкции внутри чужого
 * документа остаются текстом и ничего не инициируют (§9.7, §11.6).
 */
export interface UntrustedData<T> {
  readonly kind: 'data';
  readonly origin: string;
  readonly value: T;
}

export function asData<T>(origin: string, value: T): UntrustedData<T> {
  return { kind: 'data', origin, value };
}
