/**
 * Охранники записи (фаза 2.6): подтверждение кодом плана, однократность плана и
 * предусловие по значениям «до».
 *
 * Живут отдельным модулем: `rows.ts` отвечает на «что изменится», а этот файл — на
 * «пускать ли записывать». Гейт длины файла отклонил их совместное житьё, и правильно:
 * это два разных вопроса.
 */

import { gcError } from '../errors.js';
import { formatAt, sameCell, sameFormat, valueAt } from './a1.js';
import type { SheetMap, SheetSnapshot, SheetsClient } from './types.js';
import type { ApplyOutcome, PlannedChange, RowOptions } from './write-types.js';

/**
 * Предусловие для правки вида: в ячейке всё ещё тот вид, который показывало превью.
 *
 * Отдельной веткой, потому что сравнивать надо не значение (оно у такой правки не
 * меняется), а формат — иначе предусловие пропускало бы чужую правку вида молча.
 */
function assertFormatUnchanged(
  snapshot: { readonly sheets: readonly SheetSnapshot[] },
  change: PlannedChange,
): void {
  const current = formatAt(snapshot, change.a1);
  if (sameFormat(current, change.beforeFormat)) return;
  throw gcError('stale_value', {
    detail:
      `Вид ячейки ${change.a1} (${change.column}) изменился после превью. Запись не ` +
      'выполнена — перечитай и подтверди новый план.',
    cause: 'format_changed_after_preview',
  });
}

/**
 * Подтверждение как подпись (D-16).
 *
 * Без кода запись не идёт: «пиши» без кода означает «пиши что-нибудь», а между превью и
 * записью план мог измениться — именно эта дыра и закрывается. Код от другого плана —
 * не ошибка формата, а расхождение: в ответ уходит НОВЫЙ план со своим кодом, чтобы
 * человеку было что подтвердить, а не тупик.
 */
export function confirmationOutcome(
  base: Omit<ApplyOutcome, 'status' | 'revisionAfter'>,
  options: RowOptions,
): ApplyOutcome | null {
  const code = base.planId;
  if (options.confirm === undefined) {
    throw gcError('confirm_required', {
      detail:
        `Покажи человеку план и его код (${code ?? '—'}), и передай код обратно в confirm: ` +
        '«пиши» без кода не подтверждает конкретную правку.',
      cause: 'write.plan-confirmation',
    });
  }
  if (options.confirm === code) return null;
  return {
    status: 'plan_mismatch',
    ...base,
    notes: [
      ...base.notes,
      `Подтверждён код ${options.confirm}, а у этого плана код ${code ?? '—'}. ` +
        'Записи не было. Покажи человеку план ниже и подтверди его код.',
    ],
    revisionAfter: null,
  };
}

/**
 * Тот же план дважды — не повтор, а вторая правка (B20).
 *
 * Нужна именно для `appendRow`: у него нет значений «до», ревизия в код плана попадает
 * от чтения, и второе «пиши» дало бы вторую строку в таблице. Откаченные записи из счёта
 * исключаются: после `undo` та же правка снова законна, иначе повтор осознанного действия
 * стал бы невозможен.
 */
export async function assertPlanNotApplied(
  options: RowOptions,
  planIdValue: string | null,
  targetId: string,
): Promise<void> {
  if (options.journalSource === undefined || planIdValue === null) return;
  const history = await options.journalSource.recent(targetId, 50);
  const undone = new Set(
    history.filter((r) => r.op === 'undo' && r.undoOf !== undefined).map((r) => r.undoOf),
  );
  const already = history.find(
    (r) => r.planId === planIdValue && r.op !== 'undo' && !undone.has(r.correlationId),
  );
  if (already === undefined) return;
  throw gcError('plan_already_applied', {
    detail:
      `План ${planIdValue} уже записан ${new Date(already.at).toLocaleString('ru-RU')} ` +
      `(id ${already.correlationId}). Повторное «пиши» записало бы то же второй раз: ` +
      'перечитай и подтверди новый план.',
    cause: 'write.plan-once',
  });
}

/**
 * Предусловие записи: в ячейках всё ещё то, что показывало превью (D-17).
 *
 * Стоит одного лишнего чтения перед записью — и закрывает два случая, которые иначе
 * видны только по результату. Первый: значение правили после превью, и запись затёрла бы
 * чужую правку. Второй тоньше и опаснее — `appendRow` считает номер строки от границы
 * данных, и если между превью и записью кто-то дописал свою строку, наш «конец листа»
 * оказался бы занят: `before` у такой ячейки `null`, поэтому непустое текущее значение
 * ловится тем же сравнением.
 */
export async function assertBeforeValues(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
): Promise<void> {
  const snapshot = await client.getSpreadsheet(map.spreadsheetId, { sheet: map.sheet });
  for (const change of changes) {
    if (change.kind === 'format') {
      assertFormatUnchanged(snapshot, change);
      continue;
    }
    const current = valueAt(snapshot, change.a1);
    if (sameCell(current, change.before)) continue;
    throw gcError('stale_value', {
      detail:
        `Ячейка ${change.a1} (${change.column}): превью строилось на «${String(change.before ?? '')}», ` +
        `сейчас там «${String(current ?? '')}». Запись не выполнена — перечитай и подтверди новый план.`,
      cause: 'value_changed_after_preview',
    });
  }
}
