/**
 * Контур записи: один на все формы правки (D-16, D-17, D-18, D-19).
 *
 * Здесь живёт последовательность, которая обязана быть одинаковой для ячеек, вида и
 * геометрии: код плана → кто разрешил → однократность → предусловие → запись → журнал.
 * Вынесено из `rows.ts` не только по длине файла: со структурными операциями (2.5b)
 * появилась вторая ФОРМА правки, и второй путь записи разъехался бы с первым первой же
 * правкой — как разъехались бы две копии «истории без откаченного», которые уже поймал
 * гейт копипаста.
 *
 * Что различается между формами — только две функции: чем применить правку и чем
 * проверить предусловие. Они приходят снаружи в `WriteShape`, а не ветвлением здесь.
 */

import { gcError, newCorrelationId } from '../errors.js';
import type { RangeSnapshot, StructuralChange, WriteRecord } from '../journal.js';
import { planId as planCode, type PlanCell, type PlanShape, type PlanTouch } from '../plan.js';
import { assertChangeBudget } from '../policy.js';
import { parseA1 } from './a1.js';
import {
  assertPlanNotApplied,
  confirmationOutcome,
  duplicateAppendOutcome,
} from './write-guards.js';
import type {
  CellFormat,
  CellValue,
  ColumnProfile,
  FormatRequest,
  SheetMap,
  SheetsClient,
} from './types.js';
import {
  noChangeNote,
  type ApplyOutcome,
  type EnvelopeDecision,
  type OperationKind,
  type PlannedChange,
  type Question,
  type RowOptions,
  type StructuralPlan,
} from './write-types.js';

/**
 * Чем эта правка отличается от записи значений.
 *
 * Пусто — значит правятся ячейки: применяем `writeCells`, предусловие сверяет значения и
 * вид (D-17). Структурная правка приносит своё применение (запрос геометрии) и своё
 * предусловие (якорь на месте), а также то, чего у ячеечной нет вовсе: описание геометрии
 * для плана и снимок содержимого для отката.
 */
export interface WriteShape {
  readonly structural?: StructuralPlan;
  readonly snapshots?: readonly RangeSnapshot[];
  /**
   * Сколько ячеек трогает правка, если по `changes` этого не видно.
   *
   * Читатель без прогона нашёл дыру: граница конверта по числу ячеек судила
   * `changes.length`, а у вставки, автозаполнения, дублирования листа и создания файла
   * `changes` пуст — значит `maxCells: 1` разрешал вставку 200 строк с первой фразы.
   * D-18 обещает границу, и она обязана судить их тоже.
   */
  readonly cells?: number;
  /**
   * Чем применить правку. Может вернуть факты, известные ТОЛЬКО по факту записи: id
   * созданного файла Drive появляется в ответе Google, а не в плане, и без него откат
   * не знал бы, что отправлять в корзину.
   */
  readonly apply?: (client: SheetsClient, context: WriteContext) => Promise<StructuralFacts | void>;
  readonly precondition?: (client: SheetsClient, context: WriteContext) => Promise<void>;
}

/**
 * Куда пишем, глазами контура записи: id цели, лист, ревизия.
 *
 * Не `SheetMap` намеренно. Со слайса 8 через тот же контур идёт создание файлов Drive, у
 * которого никакой карты листа нет вовсе — а журнал, код плана и подтверждение нужны те
 * же. Карта сужается до контекста одной функцией, и это единственное место перевода.
 */
export interface WriteContext {
  readonly targetId: string;
  readonly sheet: string;
  readonly sheetId: number;
  readonly revisionId: string | null;
}

export const contextOf = (map: SheetMap): WriteContext => ({
  targetId: map.spreadsheetId,
  sheet: map.sheet,
  sheetId: map.sheetId,
  revisionId: map.revisionId,
});

/** Что стало известно при записи, а не при планировании. */
export interface StructuralFacts {
  readonly fileId?: string;
}

type Base = Omit<ApplyOutcome, 'status' | 'revisionAfter'>;

/** Есть ли что записывать: у структурной правки ячеек может не быть вовсе. */
function hasWork(changes: readonly PlannedChange[], shape: WriteShape): boolean {
  return changes.length > 0 || shape.structural !== undefined;
}

export interface Prepared {
  readonly resolved: { column: ColumnProfile; value: CellValue }[];
  readonly assumptions: string[];
  readonly notes: string[];
  readonly questions: Question[];
  /** Формульные и защищённые колонки в плане — уезжают в код плана (D-16). */
  readonly touches: PlanTouch[];
}

/**
 * Изменение плана → запись для кода плана и для журнала. Один переводчик на оба: гейт
 * копипаста нашёл здесь две копии, и он прав — если код плана и журнал начнут описывать
 * правку по-разному, расхождение будет видно только на откате.
 *
 * Вид входит в обе записи намеренно: без него код плана у правок вида считался по адресу и
 * не различал СОДЕРЖАНИЕ — «сделать жирным» и «снять жирность» получали один код. Нашла
 * живая проверка в соседней сессии 2026-09-03: `canonicalPlan` эти поля сериализовал, а
 * `planOf` их не кладл.
 */
function cellRecord(change: PlannedChange): PlanCell {
  return {
    a1: change.a1,
    column: change.column,
    before: change.before,
    after: change.after,
    ...(change.beforeFormat === undefined ? {} : { beforeFormat: change.beforeFormat }),
    ...(change.afterFormat === undefined ? {} : { afterFormat: change.afterFormat }),
  };
}

/** План как данные: из него считается код (D-16) и с ним сверяется журнал (B19). */
function planOf(
  map: WriteContext,
  changes: readonly PlannedChange[],
  prepared: Prepared,
  op: OperationKind,
  shape: WriteShape,
): PlanShape {
  const structural = shape.structural;
  return {
    targetId: map.targetId,
    sheet: map.sheet,
    op,
    cells: changes.map(cellRecord),
    touches: prepared.touches,
    // Геометрия входит в подпись: иначе «вставить строку перед четвёртой» и «удалить
    // четвёртую» получили бы один код — у первой ячеек в плане нет, у второй они те же,
    // что были (G2, урок L14).
    ...(structural === undefined
      ? {}
      : {
          structural: {
            kind: structural.kind,
            sheet: structural.sheet,
            ...(structural.at === undefined ? {} : { at: structural.at }),
            ...(structural.count === undefined ? {} : { count: structural.count }),
            ...(structural.to === undefined ? {} : { to: structural.to }),
            ...(structural.title === undefined ? {} : { title: structural.title }),
            ...(structural.anchor === undefined ? {} : { anchor: structural.anchor }),
          },
        }),
  };
}

export async function writeCells(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.kind === 'format') continue;
    // План обещал «станет пусто» — обещание исполняется: `null` в values-API Google
    // значит «пропустить ячейку», и setCells с пустотой отвечал ok, ничего не записав
    // (живой прогон 2026-09-06, LR-2). Пустая строка в USER_ENTERED очищает.
    await client.updateValues(map.spreadsheetId, change.a1, [[change.after ?? '']]);
  }
  const formats = changes
    .filter((c) => c.kind === 'format' && c.afterFormat !== undefined)
    .map((c) => formatRequest(map, c.a1, c.afterFormat as CellFormat));
  if (formats.length > 0) await client.batchUpdate(map.spreadsheetId, formats);
}

/**
 * Собственно запись: охранники, ячейки, ревизия, журнал.
 *
 * Отделено от `finish`, который остался диспетчером «вопрос / нулевое изменение / превью /
 * запись»: гейт сложности отклонил их совместное житьё, и по делу — это разные вопросы.
 */
async function commit(
  client: SheetsClient,
  map: WriteContext,
  changes: readonly PlannedChange[],
  base: Base,
  options: RowOptions,
  op: OperationKind,
  shape: WriteShape,
): Promise<ApplyOutcome> {
  const unconfirmed = confirmationOutcome(
    base,
    options,
    decisionFor(options, op, shape.cells ?? changes.length),
  );
  if (unconfirmed !== null) return unconfirmed;

  // Дубль дописанной строки ловится ДО записи и только там, где человек план не читал.
  const duplicate = await duplicateAppendOutcome(base, options, op, changes, map.targetId);
  if (duplicate !== null) return duplicate;
  await assertPlanNotApplied(options, base.planId, map.targetId);
  if (shape.apply === undefined) {
    // Не «на всякий случай»: контур без применения правки означает, что операция забыла
    // сказать, ЧЕМ она пишет, — и молчаливая запись нуля хуже отказа.
    throw gcError('internal', { detail: 'Контур записи вызван без применения правки.' });
  }
  if (shape.precondition !== undefined) await shape.precondition(client, map);
  const facts = (await shape.apply(client, map)) ?? {};
  const revisionAfter = (await options.readRevision?.()) ?? null;
  const correlationId = newCorrelationId();

  // Журнал пишется ПОСЛЕ успешной записи и до возврата: если журналирование упало,
  // вызывающий обязан узнать об этом — «записали, но не знаем что» хуже отказа.
  await options.journal?.(
    journalRecord({ map, op, changes, base, options, shape, revisionAfter, correlationId, facts }),
  );

  return { status: 'ok', ...base, revisionAfter, correlationId };
}

export async function finishWrite(
  client: SheetsClient,
  map: WriteContext,
  changes: readonly PlannedChange[],
  prepared: Prepared,
  options: RowOptions,
  op: OperationKind,
  shape: WriteShape = {},
): Promise<ApplyOutcome> {
  // Бюджет изменений — про записываемые ЯЧЕЙКИ. У структурной правки `changes`
  // информационные (что исчезнет), и судить их этим бюджетом значило запретить удаление
  // одиннадцати строк на девятнадцати колонках. Предел структурной правки — бюджет
  // снимка; названо в правилах. Нашёл читатель без прогона 2026-09-04.
  if (shape.structural === undefined) assertChangeBudget(changes.length);
  const base: Base = {
    changes,
    assumptions: prepared.assumptions,
    notes: prepared.notes,
    questions: [] as readonly Question[],
    baseRevision: map.revisionId,
    planId: hasWork(changes, shape) ? planCode(planOf(map, changes, prepared, op, shape)) : null,
    ...(shape.structural === undefined ? {} : { structural: shape.structural }),
  };

  // Нулевое изменение — отдельный статус, а не «ok» и не пустое превью: раньше
  // `dryRun:false` на «значение уже такое» возвращал `ok` БЕЗ строки журнала, и человек
  // читал «готово» при пустом факте (живой прогон B13, 2026-09-02).
  if (!hasWork(changes, shape)) {
    return {
      status: 'no_change',
      ...base,
      notes: [...prepared.notes, noChangeNote(op)],
      revisionAfter: null,
    };
  }
  if (options.dryRun !== false) return { status: 'preview', ...base, revisionAfter: null };
  return commit(client, map, changes, base, options, op, shape);
}
/** План геометрии → запись журнала: поля те же, но у записи нет якоря и списка потерь. */
function toStructuralChange(plan: StructuralPlan, facts: StructuralFacts): StructuralChange {
  return {
    kind: plan.kind,
    sheet: plan.sheet,
    ...(plan.at === undefined ? {} : { at: plan.at }),
    ...(plan.count === undefined ? {} : { count: plan.count }),
    ...(plan.to === undefined ? {} : { to: plan.to }),
    ...(plan.title === undefined ? {} : { title: plan.title }),
    ...(plan.previousTitle === undefined ? {} : { previousTitle: plan.previousTitle }),
    ...(plan.properties === undefined ? {} : { properties: plan.properties }),
    // Названная потеря уезжает в журнал: ответ отката обязан сказать не только что
    // вернулось, но и что нет — иначе он отчитается успехом, вернув не всё (урок L5).
    ...(plan.irreversible === undefined ? {} : { irreversible: plan.irreversible }),
    ...(facts.fileId === undefined ? {} : { fileId: facts.fileId }),
  };
}

/** Адрес A1 из плана → доменный запрос вида. Один переводчик на весь пишущий путь. */
export function formatRequest(map: SheetMap, a1: string, format: CellFormat): FormatRequest {
  const parsed = parseA1(a1);
  if (parsed === null) {
    throw gcError('internal', { detail: `План содержит нечитаемый адрес ${a1}.` });
  }
  return {
    kind: 'format',
    sheetId: map.sheetId,
    row: parsed.row,
    column: parsed.column,
    format,
  };
}

/**
 * Кто разрешил эту запись: судья конверта, а если его не передали — никто.
 *
 * Отказ в безопасную сторону назван явно: отсутствие судьи означает «разрешения нет», а
 * не «разрешено по умолчанию». Вынесено из `commit` по гейту сложности.
 */
function decisionFor(options: RowOptions, op: OperationKind, cells: number): EnvelopeDecision {
  return (
    options.authorize?.(op, cells) ?? {
      authorized: false,
      reason: 'Разрешения на запись без кода плана у этого вызова нет.',
    }
  );
}

/**
 * Запись журнала. Вынесена из `commit` по гейту сложности — и по делу: «пускать ли
 * писать» и «что записать в журнал» это разные вопросы, а необязательных полей у записи
 * стало пять.
 */
function journalRecord(input: {
  map: WriteContext;
  op: OperationKind;
  changes: readonly PlannedChange[];
  base: Base;
  options: RowOptions;
  shape: WriteShape;
  revisionAfter: string | null;
  correlationId: string;
  facts: StructuralFacts;
}): WriteRecord {
  const { map, base, options, shape } = input;
  return {
    at: new Date().toISOString(),
    account: options.account ?? 'default',
    targetId: map.targetId,
    alias: options.alias ?? null,
    sheet: map.sheet,
    op: input.op,
    changes: input.changes.map(cellRecord),
    revisionBefore: map.revisionId,
    revisionAfter: input.revisionAfter,
    correlationId: input.correlationId,
    ...(base.planId === null ? {} : { planId: base.planId }),
    // Геометрия и снимок — то, чем откат вернёт исчезнувшее (D-19).
    ...(shape.structural === undefined
      ? {}
      : { structure: toStructuralChange(shape.structural, input.facts) }),
    ...(shape.snapshots === undefined ? {} : { snapshots: shape.snapshots }),
  };
}
