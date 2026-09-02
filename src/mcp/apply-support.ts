/**
 * Обвязка `gc_apply`: опции записи, подсказка человеку и отчёт файлом.
 *
 * Вынесено из `tools.ts` по гейту длины файла — и по делу: определения инструментов
 * отвечают на «что умеет сервер», а этот файл на «как оформить один вызов записи».
 */

import type { ApplyOutcome } from '../core/sheets/rows.js';
import { renderPreview, writeReport } from '../core/report/html.js';
import type { parseOperation } from '../core/ops.js';
import type { ResolvedTarget } from '../core/targets.js';
import type { ToolDeps } from './deps.js';

/** Опции записи из разобранной операции. Вынесено: в обработчике копило сложность. */
export function applyOptions(
  deps: ToolDeps,
  resolved: ResolvedTarget,
  operation: ReturnType<typeof parseOperation>,
) {
  return {
    dryRun: operation.dryRun,
    force: operation.force,
    journal: deps.journal,
    journalSource: deps.journalSource,
    account: deps.account,
    alias: resolved.alias,
    readRevision: () => deps.revision(resolved.id),
    ...(operation.confirm === undefined ? {} : { confirm: operation.confirm }),
    ...(operation.expectRevision === undefined ? {} : { expectRevision: operation.expectRevision }),
    ...(resolved.entry?.aliases === undefined ? {} : { aliases: resolved.entry.aliases }),
  };
}

/** Что делать человеку дальше. Текст здесь, а не в обработчике: его читают, а не ветвят. */
export function applyHint(status: ApplyOutcome['status']): string | undefined {
  if (status === 'preview') {
    return (
      'Это план. Покажи человеку план И код плана (поле planId), запись — повторным ' +
      'вызовом с dryRun=false и тем же кодом в confirm. Код придумывать нельзя: он должен ' +
      'прийти от человека, который план прочитал.'
    );
  }
  if (status === 'plan_mismatch') {
    return (
      'Код не от этого плана, записи НЕ было. Ниже новый план со своим кодом — покажи его ' +
      'человеку и получи подтверждение заново, не подставляй код сам.'
    );
  }
  if (status === 'no_change') {
    return (
      'Ничего не изменилось: значения уже такие, записи не было. Так и скажи человеку — ' +
      'не выдавай это за выполненную правку.'
    );
  }
  if (status === 'needs_clarification') {
    return 'Спроси человека, выбрав из перечисленных вариантов. Не угадывай.';
  }
  return undefined;
}

/** Отчёт файлом, если попросили. Вынесено: ветка в обработчике поднимала сложность до 11. */
export async function maybeReport(
  wanted: boolean,
  outcome: ApplyOutcome,
  meta: {
    spreadsheet: string;
    sheet: string;
    alias: string | null;
    revision: string | null;
    op: string;
  },
): Promise<string | null> {
  if (!wanted) return null;
  const applied = outcome.status === 'ok';
  const labels: Record<ApplyOutcome['status'], string> = {
    ok: 'Записано',
    preview: 'Превью',
    no_change: 'Без изменений',
    plan_mismatch: 'Код не совпал',
    needs_clarification: 'Нужен ответ человека',
  };
  const label = labels[outcome.status];
  return writeReport(
    renderPreview(outcome, {
      title: `${label}: ${meta.op}`,
      spreadsheet: meta.spreadsheet,
      sheet: meta.sheet,
      alias: meta.alias,
      revision: meta.revision,
    }),
    applied ? 'applied' : 'preview',
  );
}
