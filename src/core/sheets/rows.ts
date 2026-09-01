/**
 * Операции по строкам и колонкам: appendRow / upsertRow / setCells (DESIGN.md §5).
 *
 * Все три возвращают ПЛАН, пока `dryRun` не выключен явно (§11.1). Ключ строки и имена
 * колонок — человеческие, а не A1: колонки переставляют, и `Sheet1!D17` через неделю
 * указывает не туда.
 */

import { gcError } from '../errors.ts';
import { needsClarification, resolveColumn, type ResolveOptions } from '../resolver.ts';
import { normalizeValue } from '../values.ts';
import {
  columnLetter,
  type CellValue,
  type ColumnProfile,
  type SheetData,
  type SheetMap,
  type SheetsClient,
} from './types.ts';

export type RowValues = Readonly<Record<string, unknown>>;

export interface Question {
  readonly field: string;
  readonly reason:
    'ambiguous' | 'no_match' | 'not_in_enum' | 'not_a_number' | 'not_a_date' | 'key_not_found';
  readonly detail: string;
  readonly candidates: readonly string[];
  /** Полный список доступного — чтобы человек выбирал из того, что есть (§8.2). */
  readonly available: readonly string[];
}

export interface PlannedChange {
  readonly kind: 'set' | 'addRow';
  readonly a1: string;
  readonly column: string;
  readonly before: CellValue;
  readonly after: CellValue;
}

export interface ApplyOutcome {
  readonly status: 'ok' | 'preview' | 'needs_clarification';
  readonly changes: readonly PlannedChange[];
  /** Ступень 4 резолвера: что именно мы поняли по-своему (§8.2). */
  readonly assumptions: readonly string[];
  /** Нормализации значений — «3ч» → 3, приведение регистра. */
  readonly notes: readonly string[];
  readonly questions: readonly Question[];
  readonly revisionId: string | null;
}

export interface RowOptions extends ResolveOptions {
  readonly dryRun?: boolean;
  readonly now?: Date;
  /** Осознанное подтверждение записи в формульную/защищённую колонку (§8.1). */
  readonly force?: boolean;
  /** Ревизия, на которой строилась карта: защита от гонки с живой правкой (§3). */
  readonly expectRevision?: string;
}

interface Prepared {
  readonly resolved: { column: ColumnProfile; value: CellValue }[];
  readonly assumptions: string[];
  readonly notes: string[];
  readonly questions: Question[];
}

const names = (map: SheetMap): readonly string[] => map.columns.map((c) => c.name);

function prepare(map: SheetMap, values: RowValues, options: RowOptions): Prepared {
  const out: Prepared = { resolved: [], assumptions: [], notes: [], questions: [] };

  for (const [requested, raw] of Object.entries(values)) {
    const resolution = resolveColumn(requested, map.columns, options);
    if (needsClarification(resolution.step) || resolution.column === null) {
      out.questions.push({
        field: requested,
        reason: resolution.step === 'ambiguous' ? 'ambiguous' : 'no_match',
        detail:
          resolution.step === 'ambiguous'
            ? `«${requested}» подходит сразу нескольким колонкам — какую имел в виду?`
            : `Колонки «${requested}» в листе «${map.sheet}» нет. Создавать её сама не буду.`,
        candidates: resolution.candidates,
        available: names(map),
      });
      continue;
    }
    if (resolution.assumption !== null) out.assumptions.push(resolution.assumption);

    const column = resolution.column;
    if ((column.hasFormula || column.protected) && options.force !== true) {
      throw gcError('write_blocked', {
        detail: column.hasFormula
          ? `Колонка «${column.name}» содержит формулы — запись значения их затрёт.`
          : `Колонка «${column.name}» в защищённом диапазоне.`,
        cause: column.hasFormula ? 'formula_column' : 'protected_range',
      });
    }

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
      continue;
    }
    if (normalized.note !== null) out.notes.push(normalized.note);
    out.resolved.push({ column, value: normalized.value });
  }

  return out;
}

/** Индексы строк данных, подходящих под ключ. Сравнение — через нормализацию значений. */
function findRows(
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

function assertRevision(map: SheetMap, options: RowOptions): void {
  if (options.expectRevision === undefined || map.revisionId === null) return;
  if (options.expectRevision !== map.revisionId) {
    throw gcError('revision_conflict', {
      detail: `Таблица изменилась с момента чтения (было ${options.expectRevision}, стало ${map.revisionId}).`,
    });
  }
}

const clarify = (questions: readonly Question[], map: SheetMap): ApplyOutcome => ({
  status: 'needs_clarification',
  changes: [],
  assumptions: [],
  notes: [],
  questions,
  revisionId: map.revisionId,
});

async function writeCells(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
): Promise<void> {
  for (const change of changes) {
    await client.updateValues(map.spreadsheetId, change.a1, [[change.after]]);
  }
}

/**
 * Общий финал всех трёх операций: превью или запись. Был скопирован трижды —
 * гейт дублей (jscpd) это и нашёл, а вместе с копией уезжала бы и логика dryRun.
 */
async function finish(
  client: SheetsClient,
  map: SheetMap,
  changes: readonly PlannedChange[],
  prepared: Prepared,
  options: RowOptions,
): Promise<ApplyOutcome> {
  const base = {
    changes,
    assumptions: prepared.assumptions,
    notes: prepared.notes,
    questions: [] as readonly Question[],
    revisionId: map.revisionId,
  };
  if (options.dryRun !== false) return { status: 'preview', ...base };
  await writeCells(client, map, changes);
  return { status: 'ok', ...base };
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

  return finish(client, map, changes, prepared, options);
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

  return finish(client, map, changes, prepared, options);
}

/** Точечно поправить ячейки во всех строках, подходящих под условие. */
export async function setCells(
  client: SheetsClient,
  data: SheetData,
  where: RowValues,
  values: RowValues,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const map = data.map;
  assertRevision(map, options);
  const found = findRows(data, where, options);
  if (found.questions.length > 0) return clarify(found.questions, map);
  if (found.rows.length === 0) {
    return clarify(
      [
        {
          field: Object.keys(where)[0] ?? 'условие',
          reason: 'key_not_found',
          detail: 'Под условие не подошла ни одна строка — править нечего.',
          candidates: [],
          available: names(map),
        },
      ],
      map,
    );
  }

  const prepared = prepare(map, values, options);
  if (prepared.questions.length > 0) return clarify(prepared.questions, map);

  const changes: PlannedChange[] = [];
  for (const rowNumber of found.rows) {
    const current = data.rows[rowNumber - map.headerRow - 1] ?? {};
    for (const { column, value } of prepared.resolved) {
      const before = current[column.name] ?? null;
      if (String(before ?? '') === String(value ?? '')) continue;
      changes.push({
        kind: 'set',
        a1: `${map.sheet}!${column.letter}${rowNumber}`,
        column: column.name,
        before,
        after: value,
      });
    }
  }

  return finish(client, map, changes, prepared, options);
}

export { columnLetter };
