/**
 * Шапка и строки нового листа или новой таблицы (D-23): `createSheet` и `addSheet` — «создай
 * лист, сделай там шапку, занеси данные» (слово владельца 2026-11-11).
 *
 * Общим модулем, а не второй копией в операции листа: проверка содержимого, его сверка в коде
 * плана, превью и счёт ячеек для конверта обязаны быть одними на обе операции — иначе «таблица
 * со шапкой» и «лист со шапкой» разошлись бы молча, а вторую копию не пропустит гейт копипаста.
 * Здесь же запись с уборкой: созданное, в которое содержимое не легло, не остаётся сиротой.
 */

import { createHash } from 'node:crypto';

import { gcError } from '../errors.js';
import { limitOf } from '../policy.js';
import type { CellValue, SheetsClient } from './types.js';

export interface SheetContent {
  readonly columns?: readonly string[] | undefined;
  readonly rows?: readonly (readonly CellValue[])[] | undefined;
  /** Текстом (RAW) — по умолчанию; `false` — как набрал бы человек: даты распознаются. */
  readonly asText: boolean;
}

/**
 * Поля содержимого из операции — и только они. Ни шапки, ни строк — содержимое пустое, и его
 * отсекает счёт ячеек (`assertContent` → 0): правка идёт как без содержимого (D-23, X7).
 */
export const sheetContentOf = (fields: SheetContent): SheetContent => ({
  columns: fields.columns,
  rows: fields.rows,
  asText: fields.asText,
});

/** Строки содержимого в одну матрицу: шапка первой строкой. */
export function contentMatrix(content: SheetContent): readonly (readonly CellValue[])[] {
  return [...(content.columns === undefined ? [] : [content.columns]), ...(content.rows ?? [])];
}

/**
 * Сколько ячеек содержимое оставит непустыми: `null` values-API пропускает, пустая строка ячейку
 * очищает — ни того ни другого в листе не останется. Этим числом откат нового листа узнаёт, что
 * лист после нас не правили, — как копию листа (`duplicateSheet`).
 */
export const filledCells = (content: SheetContent): number =>
  contentMatrix(content)
    .flat()
    .filter((value) => value !== null && value !== '').length;

/**
 * Содержимое проверяется ДО создания: строка длиннее шапки — вопрос, а не догадка, куда легли
 * лишние значения; больше бюджета изменений — отказ с советом дописать после. `what` — что
 * создаётся, в винительном падеже: «таблицу», «лист».
 */
export function assertContent(content: SheetContent | undefined, what: string): number {
  if (content === undefined) return 0;
  // Без шапки ширина не ограничена: строки ложатся с A1, и длиннее нечего.
  const width = content.columns?.length ?? Infinity;
  const tooWide = (content.rows ?? []).findIndex((row) => row.length > width);
  if (tooWide >= 0) {
    throw gcError('bad_request', {
      detail: `Строка ${tooWide + 1} длиннее шапки (${width} колонок): куда лягут лишние значения — решает человек.`,
      cause: 'row_wider_than_header',
    });
  }
  const cells = contentMatrix(content).reduce((sum, row) => sum + row.length, 0);
  const budget = limitOf('write.max-changes', 200);
  if (cells > budget) {
    throw gcError('bad_request', {
      detail: `Содержимое — ${cells} ячеек при бюджете ${budget} на одну правку: создай ${what} с шапкой и допиши строки после (appendRow).`,
      cause: 'change_budget',
    });
  }
  return cells;
}

/** Сверка содержимого для кода плана: человек подтверждает именно эти строки. */
export const contentDigest = (content: SheetContent): string =>
  createHash('sha256')
    .update(JSON.stringify([contentMatrix(content), content.asText]))
    .digest('hex')
    .slice(0, 12);

/** Что запишется — человеку в превью: шапка и первые строки, без «и т. д.» молчком. */
export function contentNotes(content: SheetContent): string[] {
  const rows = content.rows ?? [];
  const shown = rows.slice(0, 10).map((row) => `  ${row.map((v) => String(v ?? '')).join(' | ')}`);
  return [
    ...(content.columns === undefined ? [] : [`Шапка: ${content.columns.join(' | ')}`]),
    ...(rows.length === 0
      ? []
      : [`Строк: ${rows.length}${content.asText ? ', текстом (RAW)' : ''}:`, ...shown]),
    ...(rows.length > shown.length ? [`  …и ещё ${rows.length - shown.length}`] : []),
  ];
}

/** Если содержимое не легло: чем убрать созданное и что сказать человеку, если не убралось. */
export interface ContentFailure {
  readonly discard: () => Promise<unknown>;
  readonly orphan: string;
  readonly cause: string;
}

/**
 * Содержимое — с левого верхнего угла `range`, текстом (RAW) или как набрал бы человек. Сбой
 * записи не оставляет сироту: созданное без строки журнала `gc_undo` не нашёл бы, поэтому
 * `discard` его убирает, и наружу уходит сама ошибка записи; не убралось и оно —
 * `write_outcome_unknown` с текстом `orphan`: человек узнаёт, что осталось, а не получает тишину.
 */
export async function writeSheetContent(
  sheets: SheetsClient,
  where: { readonly id: string; readonly range: string },
  content: SheetContent,
  failure: ContentFailure,
): Promise<void> {
  try {
    await sheets.updateValues(
      where.id,
      where.range,
      contentMatrix(content),
      content.asText ? 'raw' : 'user',
    );
  } catch (error) {
    throw await failure.discard().then(
      () => error,
      () => gcError('write_outcome_unknown', { detail: failure.orphan, cause: failure.cause }),
    );
  }
}

/**
 * Содержимое нового листа (`addSheet`) — в `'<лист>'!A1`: имя бывает с пробелами, поэтому в
 * кавычках, а апостроф внутри имени удваивается (A1-нотация). Сбой — лист удаляется по имени: оно в
 * книге уникально, а id нового листа запрос создания не возвращает; не нашёлся — убирать нечего.
 * Не удалился — исход неизвестен, и человек узнаёт, какой лист проверить.
 */
export function fillAddedSheet(
  sheets: SheetsClient,
  id: string,
  title: string,
  content: SheetContent,
): Promise<void> {
  return writeSheetContent(sheets, { id, range: `'${title.replaceAll("'", "''")}'!A1` }, content, {
    discard: async () => {
      const added = (await sheets.sheetTitles(id)).filter((sheet) => sheet.title === title);
      await sheets.batchUpdate(
        id,
        added.map(({ sheetId }) => ({ kind: 'deleteSheet' as const, sheetId })),
      );
    },
    orphan:
      `Лист «${title}» добавлен, а шапка и строки в него не записались, и удалить лист не вышло. ` +
      'Проверь книгу: удали лист руками или допиши содержимое.',
    cause: 'add_sheet_content_failed',
  });
}
