/**
 * Охранники записи (фаза 2.6): подтверждение кодом плана, однократность плана и
 * предусловие по значениям «до».
 *
 * Живут отдельным модулем: `rows.ts` отвечает на «что изменится», а этот файл — на
 * «пускать ли записывать». Гейт длины файла отклонил их совместное житьё, и правильно:
 * это два разных вопроса.
 */

import { gcError } from '../errors.js';
import type { JournalSource, WriteRecord } from '../journal.js';
import { limitOf } from '../policy.js';
import { formatAt, sameCell, sameFormat, valueAt } from './a1.js';
import type { SheetMap, SheetSnapshot, SheetsClient } from './types.js';
import type { ApplyOutcome, EnvelopeDecision, PlannedChange, RowOptions } from './write-types.js';

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
 * Кто разрешил эту запись (D-16 + D-18).
 *
 * Две дороги, и обе ведут к одной проверке — «пишем ровно то, что показали»:
 *
 * 1. **Код плана.** Он есть в вызове — сверяем всегда, даже внутри конверта: код от
 *    другого плана это расхождение, а не формальность. В ответ уходит НОВЫЙ план со своим
 *    кодом, чтобы человеку было что подтвердить, а не тупик.
 * 2. **Конверт цели.** Кода нет, но человек заранее подписал, что такие правки на этой
 *    цели идут с первой фразы. Связь с показанным планом здесь даёт не строка, а один
 *    вызов: план строится, перечитывается предусловием D-17 и пишется без промежутка, в
 *    который мог бы вклиниться другой план.
 *
 * Ни того, ни другого — `confirm_required` СТАТУСОМ, с планом и кодом в том же ответе.
 * Раньше здесь летело исключение, и человек получал отказ без плана: подтверждать было
 * нечего, приходился третий вызов.
 */
export function confirmationOutcome(
  base: Omit<ApplyOutcome, 'status' | 'revisionAfter'>,
  options: RowOptions,
  decision: EnvelopeDecision,
): ApplyOutcome | null {
  const code = base.planId;
  // Разрушающая правка (D-20): подтверждение НАЗЫВАЕТ предмет — «да, удаляю AutoLink
  // Platform». Отдельной функцией, потому что гейт сложности отклонил тринадцатую ветвь.
  if (base.structural?.confirmToken !== undefined) return namedConfirmOutcome(base, options);
  if (options.confirm === undefined) {
    if (decision.authorized) return null;
    return {
      status: 'confirm_required',
      ...base,
      notes: [
        ...base.notes,
        `${decision.reason} Записи не было. Код плана — ${code ?? '—'}: покажи человеку ` +
          'план и код, и передай код обратно в confirm.',
      ],
      revisionAfter: null,
    };
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
  const already = (await standingWrites(options.journalSource, targetId)).find(
    (r) => r.planId === planIdValue,
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

/**
 * Повтор той же строки внутри конверта — повторённая фраза, а не второе событие (D-18).
 *
 * `appendRow` единственная операция записи, которая не идемпотентна: `upsertRow` правит ту
 * же строку по ключу, `setCells` и `formatCells` на второй раз дают `no_change`. Раньше от
 * дубля спасал код плана (`plan_already_applied`), но внутри конверта кода нет, а номер
 * строки после первой записи сдвигается — то есть план ДРУГОЙ, и прежний охранник до этого
 * случая не доходит.
 *
 * Сверяется содержимое, а не адрес: колонка плюс значение «станет». Окно берётся из правил
 * (`write.append-dedupe-window`), потому что через час та же строка может быть осмысленным
 * повтором — журналом событий, ради которого `appendRow` и существует. Осознанный дубль
 * по-прежнему возможен: он подтверждается кодом плана, то есть человеком.
 */
export async function duplicateAppendOutcome(
  base: Omit<ApplyOutcome, 'status' | 'revisionAfter'>,
  options: RowOptions,
  op: string,
  changes: readonly PlannedChange[],
  targetId: string,
): Promise<ApplyOutcome | null> {
  // Подтверждённый кодом дубль осознан — его ловит `plan_already_applied`, а не это
  // правило: человек прочитал план и назвал код именно для второй такой же строки.
  if (options.confirm !== undefined) return null;
  const duplicate = await recentDuplicateAppend(options, op, changes, targetId);
  if (duplicate === null) return null;
  return {
    status: 'no_change',
    ...base,
    notes: [...base.notes, duplicate],
    revisionAfter: null,
  };
}

async function recentDuplicateAppend(
  options: RowOptions,
  op: string,
  changes: readonly PlannedChange[],
  targetId: string,
): Promise<string | null> {
  if (op !== 'appendRow' || options.journalSource === undefined) return null;
  const windowMs = limitOf('write.append-dedupe-window', 10) * 60_000;
  const now = (options.now ?? new Date()).getTime();
  const wanted = contentOf(changes);
  for (const record of await standingWrites(options.journalSource, targetId)) {
    if (record.op !== 'appendRow') continue;
    if (now - new Date(record.at).getTime() > windowMs) continue;
    if (contentOf(record.changes) !== wanted) continue;
    return (
      `Такая строка уже дописана ${new Date(record.at).toLocaleString('ru-RU')} ` +
      `(запись ${record.correlationId}). Второй раз не дописываю: повтор той же фразы — ` +
      'это не второе событие. Нужен именно дубль — подтверди его кодом плана.'
    );
  }
  return null;
}

/** Содержимое строки как подпись: колонки и значения «станет», адрес не участвует. */
function contentOf(changes: readonly { column: string; after: unknown }[]): string {
  return JSON.stringify(
    [...changes].map((c) => [c.column, c.after]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  );
}

/**
 * Записи цели, которые ещё СТОЯТ в документе: без откаченных и без самих откатов.
 *
 * Один helper на два охранника: `plan_already_applied` и дедуп `appendRow` спрашивают одно
 * и то же — «что из этого ещё в силе». Гейт копипаста отклонил две копии этого вопроса, и
 * он прав: разъехавшись, они дали бы «план уже записан» и «дубля нет» одновременно.
 */
async function standingWrites(
  source: JournalSource,
  targetId: string,
): Promise<readonly WriteRecord[]> {
  const history = await source.recent(targetId, 50);
  const undone = new Set(
    history.filter((r) => r.op === 'undo' && r.undoOf !== undefined).map((r) => r.undoOf),
  );
  return history.filter((r) => r.op !== 'undo' && !undone.has(r.correlationId));
}

/**
 * Названо ли в подтверждении то, что правим (D-20).
 *
 * Нормализация перечислена, а не «умная»: регистр, кавычки любых видов, повторные
 * пробелы. Совпадением считается ВХОЖДЕНИЕ имени — «да, удаляю „AutoLink Platform“»
 * проходит, «да» нет. Код плана принимается тоже: у вызовов без превью названия нет.
 */
function namesTheSubject(confirm: string, token: string, code: string | null): boolean {
  const normalized = normalizeConfirm(confirm);
  if (code !== null && normalized === normalizeConfirm(code)) return true;
  return normalized.includes(normalizeConfirm(token));
}

function normalizeConfirm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[«»"'`„“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Подтверждение названием (D-20): «как очистка корзины в Windows».
 *
 * Код плана продолжает приниматься — он нужен вызовам без превью (CLI, раннер). Голое
 * «да» не проходит: это разница между диалогом «вы уверены?» и подписью под конкретной
 * правкой.
 */
function namedConfirmOutcome(
  base: Omit<ApplyOutcome, 'status' | 'revisionAfter'>,
  options: RowOptions,
): ApplyOutcome | null {
  const token = base.structural?.confirmToken ?? '';
  const code = base.planId;
  if (options.confirm !== undefined && namesTheSubject(options.confirm, token, code)) return null;
  const phrase = base.structural?.confirmPhrase ?? token;
  return {
    status: 'confirm_required',
    ...base,
    notes: [
      ...base.notes,
      `Записи не было. Подтверди правку, назвав её предмет: «${phrase}»` +
        `${code === null ? '' : ` (или кодом плана ${code})`}. Одного «да» недостаточно.`,
    ],
    revisionAfter: null,
  };
}
