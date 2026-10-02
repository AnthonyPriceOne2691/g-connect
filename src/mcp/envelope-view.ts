/**
 * Конверт цели глазами `gc_targets` — отдельно от витрины инструментов: tools.ts уже
 * дважды перерастал лимит длины, а представление конверта — не инструмент.
 */

import { parseEnvelope } from '../core/envelope.js';

/**
 * Конверт для ответа `gc_targets`: что разрешено с первой фразы. Битый конверт не роняет
 * список целей — он назван строкой, потому что «почему по этой цели опять просят код»
 * человек должен читать здесь, а не выяснять записью.
 */
export function envelopeSummary(
  raw: unknown,
  alias: string,
  type: string | undefined,
):
  | { readonly ops: readonly string[]; readonly maxCells: number }
  | { readonly ops: readonly string[]; readonly maxChars: number }
  | string
  | null {
  try {
    const envelope = parseEnvelope(raw, alias);
    if (envelope === null) return null;
    // Мера — по виду цели: у документа граница в юнитах текста (maxChars). Живьём через
    // протокол 2026-10-02 doc-цель показывала «maxCells: 50» — агент прочитал бы границу
    // документа в ячейках таблицы.
    return type === 'doc'
      ? { ops: envelope.ops, maxChars: envelope.maxChars }
      : { ops: envelope.ops, maxCells: envelope.maxCells };
  } catch (error) {
    const detail = (error as { payload?: { detail?: string } }).payload?.detail;
    return detail ?? 'Конверт написан неверно: запись идёт через план и код.';
  }
}
