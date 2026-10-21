/**
 * Операции по строкам и колонкам: appendRow / upsertRow / setCells (DESIGN.md §5).
 *
 * Все три возвращают ПЛАН, пока `dryRun` не выключен явно (§11.1). Ключ строки и имена
 * колонок — человеческие, а не A1: колонки переставляют, и `Sheet1!D17` через неделю
 * указывает не туда.
 */

import { gcError } from '../errors.js';
import { isSilent, needsClarification, resolveColumn } from '../resolver.js';
import { normalizeValue } from '../values.js';
import { unlabeledAssumption, unlabeledByKey, unlabeledKeyQuestion } from './unlabeled-key.js';
import {
  columnLetter,
  type ColumnProfile,
  type CopyPasteRequest,
  type SheetData,
  type SheetMap,
  type SheetRequest,
  type SheetsClient,
} from './types.js';
import {
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

import { contextOf, finishWrite, writeCells, type Prepared } from './commit.js';
import { withNoteHints } from './notes.js';
import { assertBeforeValues } from './write-guards.js';

export type { Prepared } from './commit.js';
export { formatRequest, finishWrite } from './commit.js';

/**
 * Запись ячеек: тот же контур, что у геометрии, только без структурной части.
 *
 * Обёртка, а не копия: последовательность охранников живёт в `commit.ts` одна на все формы
 * правки. Имя `finish` сохранено, потому что им пользуются все ячеечные операции. Правило из
 * заметки шапки задетой колонки — здесь же, в `notes` превью любой записи значений (Q26).
 */
export const finish = (
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
  prepared: Prepared,
  options: RowOptions,
  op: OperationKind,
  /** Запросы вида, которые уходят ДО значений: копия оформления дописанной строки (Q14). */
  layout: readonly SheetRequest[] = [],
): Promise<ApplyOutcome> =>
  finishWrite(client, contextOf(map), changes, withNoteHints(prepared, map, changes), options, op, {
    // Ячеечная правка приносит своё применение и своё предусловие тем же способом, что
    // структурная: контур записи один, а формы правки различаются ровно этими двумя.
    apply: async (c) => {
      // Вид — до значений, и порядок не косметика: отказ копии не оставит в листе строку с
      // данными без вида, а отказ значений оставит пустую оформленную строку — она безвредна.
      if (layout.length > 0) await c.batchUpdate(map.spreadsheetId, layout);
      await writeCells(c, map, changes);
    },
    precondition: (c) => assertBeforeValues(c, map, changes),
  });

/**
 * Что пишется на листе — полный список для `available` у вопроса: имена подписанных колонок и
 * ключи колонок без подписи (Q40).
 */
export const names = (map: SheetMap): readonly string[] => [
  ...map.columns.map((c) => c.name),
  ...(map.unlabeled ?? []).map((column) => column.key),
];

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

/**
 * Колонка правки по имени — одна дорога для значений, условий строк и колонок вида (Q40). Точный
 * ключ колонки без подписи — до резолвера: он таких колонок не знает и нечётко к ним не сведёт.
 * Ключ в скобках, который не стал колонкой молча, — отказ без подбора; остальное — ступени §8.2.
 */
export function writeColumn(
  requested: string,
  data: SheetData,
  options: RowOptions,
): { column: ColumnProfile; assumption: string | null } | { question: Question } {
  const unlabeled = unlabeledByKey(requested, data);
  if (unlabeled !== undefined) {
    return { column: unlabeled, assumption: unlabeledAssumption(unlabeled) };
  }
  const map = data.map;
  const resolution = resolveColumn(requested, map.columns, options);
  const keyLike = isSilent(resolution.step)
    ? null
    : unlabeledKeyQuestion(requested, data, names(map));
  if (keyLike !== null) return { question: keyLike };
  if (needsClarification(resolution.step) || resolution.column === null) {
    return { question: columnQuestion(requested, resolution, map) };
  }
  return { column: resolution.column, assumption: resolution.assumption };
}

/** Одно значение: колонка, отметки риска, нормализация. Возвращает вопрос, если нужен. */
function prepareOne(
  requested: string,
  raw: unknown,
  data: SheetData,
  out: Prepared,
  options: RowOptions,
): void {
  const found = writeColumn(requested, data, options);
  if ('question' in found) {
    out.questions.push(found.question);
    return;
  }
  if (found.assumption !== null) out.assumptions.push(found.assumption);

  const column = found.column;
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
      available: normalized.candidates.length > 0 ? normalized.candidates : names(data.map),
    });
    return;
  }
  if (normalized.note !== null) out.notes.push(normalized.note);
  out.resolved.push({ column, value: normalized.value });
}

export function prepare(data: SheetData, values: RowValues, options: RowOptions): Prepared {
  const out: Prepared = {
    resolved: [],
    assumptions: [],
    notes: [],
    questions: [],
    touches: [],
  };
  for (const [requested, raw] of Object.entries(values)) {
    prepareOne(requested, raw, data, out, options);
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
/**
 * Общий финал всех трёх операций: превью или запись. Был скопирован трижды —
 * гейт дублей (jscpd) это и нашёл, а вместе с копией уезжала бы и логика dryRun.
 */

/**
 * Строки под условие: номера строк листа и оговорки условия — нечёткое имя колонки, ключ колонки
 * без подписи (Q40). Раньше оговорки условия терялись: превью молчало, как понято условие.
 */
export interface RowsFound {
  readonly rows: readonly number[];
  readonly assumptions?: readonly string[];
}

/** Оговорки условия строк — в превью операции, перед её собственными (Q40). */
export const withAssumptions = (prepared: Prepared, found: RowsFound): Prepared => ({
  ...prepared,
  assumptions: [...(found.assumptions ?? []), ...prepared.assumptions],
});

/** Индексы строк данных, подходящих под ключ. Сравнение — через нормализацию значений. */
export function findRows(
  data: SheetData,
  key: RowValues,
  options: RowOptions,
): { rows: number[]; questions: Question[]; assumptions: readonly string[] } {
  const map = data.map;
  const { questions, assumptions, resolved } = prepare(data, key, options);
  if (questions.length > 0) return { rows: [], questions, assumptions };

  const rows: number[] = [];
  for (let i = 0; i < data.rows.length; i += 1) {
    const row = data.rows[i]!;
    const matches = resolved.every(({ column, value }) => {
      const cell = row[column.name] ?? null;
      if (cell === null || value === null) return cell === value;
      return String(cell).trim().toLowerCase() === String(value).trim().toLowerCase();
    });
    if (matches) rows.push(map.headerRow + 1 + i);
  }
  return { rows, questions: [], assumptions };
}

/** Похожие значения ключа — для вопроса «создать новую или ты имел в виду вот эти?» (A11). */
function similarKeyValues(data: SheetData, key: RowValues, options: RowOptions): string[] {
  const prepared = prepare(data, key, options);
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
): RowsFound | { refusal: ApplyOutcome } {
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
  return { rows: found.rows, assumptions: found.assumptions };
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
  const prepared = prepare(data, values, options);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  // После ПОСЛЕДНЕЙ строки с данными, а не после числа непустых строк (урок L16): при
  // пропуске в середине листа счётчик целился внутрь данных. `data.rows` — строки без
  // пустого хвоста, и лист прочитан целиком (D-26), а не первые 500 строк.
  const rowNumber = map.headerRow + data.rows.length + 1;
  const changes: PlannedChange[] = prepared.resolved.map(({ column, value }) => ({
    kind: 'addRow' as const,
    a1: `${map.sheet}!${column.letter}${rowNumber}`,
    column: column.name,
    before: null,
    after: value,
  }));

  const layout =
    changes.length === 0
      ? []
      : layoutFromAbove(map, rowNumber, data.rows.length, prepared.resolved);
  if (layout.length === 0) return finish(client, map, changes, prepared, options, 'appendRow');
  // Копию вида называет план: человек видит её в превью, а не узнаёт по виду листа.
  const note = `оформление строки ${rowNumber} — как у строки ${rowNumber - 1}, с проверкой данных`;
  const named: Prepared = { ...prepared, notes: [...prepared.notes, note] };
  return finish(client, map, changes, named, options, 'appendRow', layout);
}

/**
 * Вид дописанной строки — как у строки над ней (D-26, Q14).
 *
 * values-API пишет только значения, и строка, дописанная ниже оформленных строк шаблона,
 * получала шрифт листа по умолчанию: «Реестр инфраструктуры» владелец выравнивал руками на
 * семи вкладках. Копия — `copyPaste` с `PASTE_FORMAT` и вторым — с `PASTE_DATA_VALIDATION`: вид
 * Google переносит без проверки данных, а строка без выпадающего списка — та же неровность (Q44).
 * Источник — последняя строка данных,
 * получатель — новая строка, колонки — ширина таблицы, от первой до последней колонки карты, а
 * колонка без подписи, в которую пишет дозапись (Q40), — тоже часть строки, как подписанная.
 * Строки данных над новой нет (лист из одной шапки) — копии нет: шапка оформлена иначе.
 *
 * Названная непокрытость: откат дозаписи возвращает ЗНАЧЕНИЯ, а скопированный вид остаётся
 * на опустевшей строке — журнал хранит ячейки правки, а не прежний вид строки, и вернуть
 * «как было» нечем. Строка без значений данными не считается, и следующая дозапись встанет
 * в неё же с тем же видом.
 */
function layoutFromAbove(
  map: SheetMap,
  rowNumber: number,
  rowsAbove: number,
  written: Prepared['resolved'],
): CopyPasteRequest[] {
  if (rowsAbove === 0 || map.columns.length === 0) return [];
  const indices = [...map.columns, ...written.map(({ column }) => column)].map((c) => c.index);
  const first = Math.min(...indices);
  const line = (row: number) => ({
    row,
    column: first,
    rowCount: 1,
    columnCount: Math.max(...indices) - first + 1,
  });
  return (['format', 'validation'] as const).map((paste) => ({
    kind: 'copyPaste',
    sheetId: map.sheetId,
    source: line(rowNumber - 1),
    destination: line(rowNumber),
    paste,
  }));
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
  const prepared = withAssumptions(prepare(data, values, options), found);
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
