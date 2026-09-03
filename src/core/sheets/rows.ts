/**
 * Операции по строкам и колонкам: appendRow / upsertRow / setCells (DESIGN.md §5).
 *
 * Все три возвращают ПЛАН, пока `dryRun` не выключен явно (§11.1). Ключ строки и имена
 * колонок — человеческие, а не A1: колонки переставляют, и `Sheet1!D17` через неделю
 * указывает не туда.
 */

import { gcError } from '../errors.js';
import { planId as planCode, type PlanCell, type PlanShape, type PlanTouch } from '../plan.js';
import { newCorrelationId } from '../errors.js';
import { parseA1 } from './a1.js';
import { assertChangeBudget } from '../policy.js';
import { needsClarification, resolveColumn } from '../resolver.js';
import { normalizeValue } from '../values.js';
import {
  columnLetter,
  type CellFormat,
  type CellValue,
  type FormatRequest,
  type ColumnProfile,
  type SheetData,
  type SheetMap,
  type SheetsClient,
} from './types.js';
import { assertBeforeValues, assertPlanNotApplied, confirmationOutcome } from './write-guards.js';
import {
  noChangeNote,
  type OperationKind,
  type ApplyOutcome,
  type PlannedChange,
  type Question,
  type RowOptions,
  type RowValues,
} from './write-types.js';

// Типы пишущего контура живут в `write-types.ts`, но исторический адрес импорта — этот
// модуль: внешние вызовы (MCP-слой, CLI, тесты) берут их отсюда.
export type {
  ApplyOutcome,
  PlannedChange,
  Question,
  RowOptions,
  RowValues,
} from './write-types.js';
export { NO_CHANGE_NOTE } from './write-types.js';

export interface Prepared {
  readonly resolved: { column: ColumnProfile; value: CellValue }[];
  readonly assumptions: string[];
  readonly notes: string[];
  readonly questions: Question[];
  /** Формульные и защищённые колонки в плане — уезжают в код плана (D-16). */
  readonly touches: PlanTouch[];
}

export const names = (map: SheetMap): readonly string[] => map.columns.map((c) => c.name);

/** Вопрос про колонку: ступени резолвера 5 и 6 (§8.2). Текст рядом с причиной. */
export function columnQuestion(
  requested: string,
  resolution: ReturnType<typeof resolveColumn>,
  map: SheetMap,
): Question {
  return {
    field: requested,
    reason: resolution.step === 'ambiguous' ? 'ambiguous' : 'no_match',
    detail:
      resolution.step === 'ambiguous'
        ? `«${requested}» подходит сразу нескольким колонкам — какую имел в виду?`
        : `Колонки «${requested}» в листе «${map.sheet}» нет. Создавать её сама не буду.`,
    candidates: resolution.candidates,
    available: names(map),
  };
}

/**
 * Формульная и защищённая колонка: отметить в плане и не пустить без `force`.
 *
 * Отметка уезжает в код плана (D-16) — подтверждая код, человек подтверждает и то, что
 * правка лезет в такую колонку. Раньше `force` был решением одной модели.
 */
export function guardColumn(column: ColumnProfile, out: Prepared, options: RowOptions): void {
  if (column.hasFormula && !out.touches.includes('formula')) out.touches.push('formula');
  if (column.protected && !out.touches.includes('protected')) out.touches.push('protected');
  if (!column.hasFormula && !column.protected) return;
  if (options.force === true) return;
  throw gcError('write_blocked', {
    detail: column.hasFormula
      ? `Колонка «${column.name}» содержит формулы — запись значения их затрёт.`
      : `Колонка «${column.name}» в защищённом диапазоне.`,
    cause: column.hasFormula ? 'formula_column' : 'protected_range',
  });
}

/** Одно значение: колонка, отметки риска, нормализация. Возвращает вопрос, если нужен. */
function prepareOne(
  requested: string,
  raw: unknown,
  map: SheetMap,
  out: Prepared,
  options: RowOptions,
): void {
  const resolution = resolveColumn(requested, map.columns, options);
  if (needsClarification(resolution.step) || resolution.column === null) {
    out.questions.push(columnQuestion(requested, resolution, map));
    return;
  }
  if (resolution.assumption !== null) out.assumptions.push(resolution.assumption);

  const column = resolution.column;
  guardColumn(column, out, options);

  const normalized = normalizeValue(
    raw,
    column,
    options.now === undefined ? {} : { now: options.now },
  );
  if (normalized.status === 'clarify') {
    out.questions.push({
      field: column.name,
      reason: normalized.reason,
      detail: normalized.detail,
      candidates: normalized.candidates,
      available: normalized.candidates.length > 0 ? normalized.candidates : names(map),
    });
    return;
  }
  if (normalized.note !== null) out.notes.push(normalized.note);
  out.resolved.push({ column, value: normalized.value });
}

export function prepare(map: SheetMap, values: RowValues, options: RowOptions): Prepared {
  const out: Prepared = {
    resolved: [],
    assumptions: [],
    notes: [],
    questions: [],
    touches: [],
  };
  for (const [requested, raw] of Object.entries(values)) {
    prepareOne(requested, raw, map, out, options);
  }
  return out;
}

export function assertRevision(map: SheetMap, options: RowOptions): void {
  if (options.expectRevision === undefined || map.revisionId === null) return;
  if (options.expectRevision !== map.revisionId) {
    throw gcError('revision_conflict', {
      detail: `Таблица изменилась с момента чтения (было ${options.expectRevision}, стало ${map.revisionId}).`,
    });
  }
}

export const clarify = (questions: readonly Question[], map: SheetMap): ApplyOutcome => ({
  status: 'needs_clarification',
  changes: [],
  assumptions: [],
  notes: [],
  questions,
  baseRevision: map.revisionId,
  revisionAfter: null,
  planId: null,
});

/**
 * Значения и вид уходят разными дверями: values-API не умеет формат, а `batchUpdate` не
 * пишет значения. Разделение здесь, а не у вызывающего: `finish` не должен знать, чем
 * отличаются операции — он знает только план.
 */
async function writeCells(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.kind === 'format') continue;
    await client.updateValues(map.spreadsheetId, change.a1, [[change.after]]);
  }
  const formats = changes
    .filter((c) => c.kind === 'format' && c.afterFormat !== undefined)
    .map((c) => formatRequest(map, c.a1, c.afterFormat as CellFormat));
  if (formats.length > 0) await client.batchUpdate(map.spreadsheetId, formats);
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
 * Общий финал всех трёх операций: превью или запись. Был скопирован трижды —
 * гейт дублей (jscpd) это и нашёл, а вместе с копией уезжала бы и логика dryRun.
 */
type Base = Omit<ApplyOutcome, 'status' | 'revisionAfter'>;

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
  map: SheetMap,
  changes: readonly PlannedChange[],
  prepared: Prepared,
  op: OperationKind,
): PlanShape {
  return {
    targetId: map.spreadsheetId,
    sheet: map.sheet,
    op,
    revision: map.revisionId,
    cells: changes.map(cellRecord),
    touches: prepared.touches,
  };
}

/**
 * Собственно запись: охранники, ячейки, ревизия, журнал.
 *
 * Отделено от `finish`, который остался диспетчером «вопрос / нулевое изменение / превью /
 * запись»: гейт сложности отклонил их совместное житьё, и по делу — это разные вопросы.
 */
async function commit(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
  base: Base,
  options: RowOptions,
  op: OperationKind,
): Promise<ApplyOutcome> {
  const mismatch = confirmationOutcome(base, options);
  if (mismatch !== null) return mismatch;
  await assertPlanNotApplied(options, base.planId, map.spreadsheetId);
  await assertBeforeValues(client, map, changes);
  await writeCells(client, map, changes);
  const revisionAfter = (await options.readRevision?.()) ?? null;

  // Журнал пишется ПОСЛЕ успешной записи и до возврата: если журналирование упало,
  // вызывающий обязан узнать об этом — «записали, но не знаем что» хуже отказа.
  await options.journal?.({
    at: new Date().toISOString(),
    account: options.account ?? 'default',
    targetId: map.spreadsheetId,
    alias: options.alias ?? null,
    sheet: map.sheet,
    op,
    changes: changes.map(cellRecord),
    revisionBefore: map.revisionId,
    revisionAfter,
    correlationId: newCorrelationId(),
    ...(base.planId === null ? {} : { planId: base.planId }),
  });

  return { status: 'ok', ...base, revisionAfter };
}

export async function finish(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
  prepared: Prepared,
  options: RowOptions,
  op: OperationKind,
): Promise<ApplyOutcome> {
  assertChangeBudget(changes.length);
  const base: Base = {
    changes,
    assumptions: prepared.assumptions,
    notes: prepared.notes,
    questions: [] as readonly Question[],
    baseRevision: map.revisionId,
    planId: changes.length === 0 ? null : planCode(planOf(map, changes, prepared, op)),
  };

  // Нулевое изменение — отдельный статус, а не «ok» и не пустое превью: раньше
  // `dryRun:false` на «значение уже такое» возвращал `ok` БЕЗ строки журнала, и человек
  // читал «готово» при пустом факте (живой прогон B13, 2026-09-02).
  if (changes.length === 0) {
    return {
      status: 'no_change',
      ...base,
      notes: [...prepared.notes, noChangeNote(op)],
      revisionAfter: null,
    };
  }
  if (options.dryRun !== false) return { status: 'preview', ...base, revisionAfter: null };
  return commit(client, map, changes, base, options, op);
}

/** Индексы строк данных, подходящих под ключ. Сравнение — через нормализацию значений. */
export function findRows(
  data: SheetData,
  key: RowValues,
  options: RowOptions,
): { rows: number[]; questions: Question[] } {
  const map = data.map;
  const prepared = prepare(map, key, options);
  if (prepared.questions.length > 0) return { rows: [], questions: prepared.questions };

  const rows: number[] = [];
  for (let i = 0; i < data.rows.length; i += 1) {
    const row = data.rows[i]!;
    const matches = prepared.resolved.every(({ column, value }) => {
      const cell = row[column.name] ?? null;
      if (cell === null || value === null) return cell === value;
      return String(cell).trim().toLowerCase() === String(value).trim().toLowerCase();
    });
    if (matches) rows.push(map.headerRow + 1 + i);
  }
  return { rows, questions: [] };
}

/** Похожие значения ключа — для вопроса «создать новую или ты имел в виду вот эти?» (A11). */
function similarKeyValues(data: SheetData, key: RowValues, options: RowOptions): string[] {
  const prepared = prepare(data.map, key, options);
  const first = prepared.resolved[0];
  if (first === undefined) return [];
  const target = String(first.value ?? '').toLowerCase();
  const seen = new Set<string>();
  for (const row of data.rows) {
    const raw = row[first.column.name];
    if (raw === null || raw === undefined) continue;
    const text = String(raw);
    const compact = text.toLowerCase().replace(/\s+/g, '');
    if (compact === target.replace(/\s+/g, '') && text.toLowerCase() !== target) seen.add(text);
  }
  return [...seen];
}

/**
 * Строки под условие или готовый отказ. Общий для `setCells` и правки вида: гейт
 * копипаста нашёл здесь одну и ту же двадцатку строк дважды, и он прав — расходиться этим
 * двум путям нельзя, они отвечают на один вопрос «какие строки трогаем».
 */
export function rowsUnderCondition(
  data: SheetData,
  where: RowValues,
  options: RowOptions,
  nothingToDo: string,
): { rows: readonly number[] } | { refusal: ApplyOutcome } {
  const map = data.map;
  assertRevision(map, options);
  const found = findRows(data, where, options);
  if (found.questions.length > 0) return { refusal: clarify(found.questions, map) };
  if (found.rows.length === 0) {
    return {
      refusal: clarify(
        [
          {
            field: Object.keys(where)[0] ?? 'условие',
            reason: 'key_not_found',
            detail: nothingToDo,
            candidates: [],
            available: names(map),
          },
        ],
        map,
      ),
    };
  }
  return { rows: found.rows };
}

/** Дописать строку в конец. Дубликаты допустимы — там, где они осмысленны (§5). */
export async function appendRow(
  client: SheetsClient,
  data: SheetData,
  values: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertRevision(map, options);
  const prepared = prepare(map, values, options);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  const rowNumber = map.headerRow + map.dataRowCount + 1;
  const changes: PlannedChange[] = prepared.resolved.map(({ column, value }) => ({
    kind: 'addRow' as const,
    a1: `${map.sheet}!${column.letter}${rowNumber}`,
    column: column.name,
    before: null,
    after: value,
  }));

  return finish(client, map, changes, prepared, options, 'appendRow');
}

/**
 * Обновить строку по ключу, а если её нет — добавить. Обязательный режим для регулярных
 * записей: повторный заход правит ту же строку, а не плодит дубликаты (§5).
 */
export async function upsertRow(
  client: SheetsClient,
  data: SheetData,
  key: RowValues,
  values: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertRevision(map, options);
  const found = findRows(data, key, options);
  if (found.questions.length > 0) return clarify(found.questions, map);

  if (found.rows.length > 1) {
    throw gcError('ambiguous_target', {
      detail: `Ключу соответствует ${found.rows.length} строк (${found.rows.join(', ')}) — уточни ключ.`,
    });
  }

  if (found.rows.length === 0) {
    const similar = similarKeyValues(data, key, options);
    if (similar.length > 0) {
      const field = Object.keys(key)[0] ?? 'ключ';
      return clarify(
        [
          {
            field,
            reason: 'key_not_found',
            detail: `Строки с таким ключом нет. Создать новую или имелось в виду одно из существующих значений?`,
            candidates: similar,
            available: names(map),
          },
        ],
        map,
      );
    }
    return appendRow(client, data, { ...key, ...values }, options);
  }

  const rowNumber = found.rows[0]!;
  const rowIndex = rowNumber - map.headerRow - 1;
  const current = data.rows[rowIndex] ?? {};
  const prepared = prepare(map, values, options);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  const changes: PlannedChange[] = prepared.resolved
    .map(({ column, value }) => ({
      kind: 'set' as const,
      a1: `${map.sheet}!${column.letter}${rowNumber}`,
      column: column.name,
      before: current[column.name] ?? null,
      after: value,
    }))
    .filter((change) => String(change.before ?? '') !== String(change.after ?? ''));

  return finish(client, map, changes, prepared, options, 'upsertRow');
}

export { columnLetter };
