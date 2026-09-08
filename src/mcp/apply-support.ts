/**
 * Обвязка `gc_apply`: опции записи, подсказка человеку и отчёт файлом.
 *
 * Вынесено из `tools.ts` по гейту длины файла — и по делу: определения инструментов
 * отвечают на «что умеет сервер», а этот файл на «как оформить один вызов записи».
 */

import type { ApplyOutcome } from '../core/sheets/rows.js';
import { envelopeAuthorizes, parseEnvelope } from '../core/envelope.js';
import { renderPreview, writeReport } from '../core/report/html.js';
import type { parseOperation } from '../core/ops.js';
import type { RowOptions } from '../core/sheets/write-types.js';
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
    // Конверт цели (D-18): разбирается здесь, где решается запись, а не при чтении
    // реестра — битый конверт не должен ронять чтение. Судит по числу ячеек, которое
    // известно только после построения плана, поэтому колбэком.
    authorize: envelopeJudge(resolved),
    ...(operation.confirm === undefined ? {} : { confirm: operation.confirm }),
    ...(operation.expectRevision === undefined ? {} : { expectRevision: operation.expectRevision }),
    ...(resolved.entry?.aliases === undefined ? {} : { aliases: resolved.entry.aliases }),
    ...(resolved.entry?.sheet === undefined ? {} : { registrySheet: resolved.entry.sheet }),
  };
}

/**
 * Судья конверта для одной цели. Конверт разбирается один раз на вызов: битый конверт
 * отказывает записи с названной причиной (`write.envelope-invalid`), а не выбирает
 * половину того, что человек имел в виду.
 */
function envelopeJudge(resolved: ResolvedTarget): NonNullable<RowOptions['authorize']> {
  const envelope = parseEnvelope(resolved.entry?.auto, resolved.alias);
  return (op, cellCount) => envelopeAuthorizes(envelope, op, cellCount);
}

/** Что делать человеку дальше. Текст здесь, а не в обработчике: его читают, а не ветвят. */
export function applyHint(outcome: ApplyOutcome): string | undefined {
  const phrase = outcome.structural?.confirmPhrase;

  // Разрушающая правка подтверждается НАЗВАНИЕМ (D-20), и подсказка обязана говорить это
  // первой строкой: живой прогон 2026-09-04 показал, что она требовала только код плана,
  // хотя механизм ждал фразу. Модель читает подсказку, а не спеку.
  if (
    phrase !== undefined &&
    (outcome.status === 'preview' || outcome.status === 'confirm_required')
  ) {
    return (
      'Записи не было. Эта правка разрушающая: покажи человеку план целиком и попроси ' +
      `подтвердить НАЗВАНИЕМ предмета — «${phrase}». Одного «да» ядро не примет. Код плана ` +
      `(${outcome.planId ?? '—'}) тоже подойдёт, но название человеку понятнее. Придумывать ` +
      'подтверждение за человека нельзя.'
    );
  }
  if (outcome.status === 'ok') {
    return (
      'Записано. Скажи человеку, что именно записано, и что откатить можно одной фразой: ' +
      `gc_undo по этой цели${outcome.correlationId === undefined ? '' : ` (запись ${outcome.correlationId})`}.`
    );
  }
  return HINTS[outcome.status];
}

/**
 * Что делать человеку дальше — по статусу. Таблицей, а не цепочкой ветвей: гейт сложности
 * отклонил тринадцатую ветвь, и он прав — это соответствие «статус → текст», а не логика.
 */
const HINTS: Partial<Record<ApplyOutcome['status'], string>> = {
  preview:
    'Это план. Покажи человеку план И код плана (поле planId), запись — повторным ' +
    'вызовом с dryRun=false и тем же кодом в confirm. Код придумывать нельзя: он должен ' +
    'прийти от человека, который план прочитал.',
  confirm_required:
    'Записи НЕ было: эту правку конверт цели не разрешает (причина в notes). Покажи ' +
    'человеку план и код плана; запись — тем же вызовом с кодом в confirm. Код ' +
    'придумывать нельзя, он должен прийти от человека.',
  plan_mismatch:
    'Код не от этого плана, записи НЕ было. Ниже новый план со своим кодом — покажи его ' +
    'человеку и получи подтверждение заново, не подставляй код сам.',
  no_change:
    'Ничего не изменилось: значения уже такие, записи не было. Так и скажи человеку — ' +
    'не выдавай это за выполненную правку.',
  needs_clarification: 'Спроси человека, выбрав из перечисленных вариантов. Не угадывай.',
};

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
    confirm_required: 'Нужен код плана',
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
