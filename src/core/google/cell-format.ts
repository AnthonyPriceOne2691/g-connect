/**
 * Явный вид ячейки из ответа Google → доменный `CellFormat` (§8.1).
 *
 * Отдельным модулем от `sheets.ts` по гейту длины — и по делу: с D-26 (Q11) вид несёт
 * гарнитуру, кегль и формат числа, и это уже соответствие восьми полей Google полям домена, а
 * не три строки внутри снимка листа. Направление то же, что у `sheets.ts`: ответ → домен.
 */

import type { sheets_v4 } from 'googleapis';

import { isNumberFormatType } from '../sheets/number-format.js';
import { rgbToHex } from './support.js';
import type { CellFormat, NumberFormat } from '../sheets/types.js';

export function toHex(color: sheets_v4.Schema$Color | undefined): string | undefined {
  return color === undefined || color === null ? undefined : rgbToHex(color);
}

/** `LEFT|CENTER|RIGHT` из ответа → доменное выравнивание; всё остальное игнорируем. */
function toAlign(value: string | null | undefined): CellFormat['align'] | undefined {
  if (value === 'LEFT' || value === 'CENTER' || value === 'RIGHT') {
    return value.toLowerCase() as CellFormat['align'];
  }
  return undefined;
}

/** Поле вида попадает в домен только когда задано явно: `undefined` и `false` — разное. */
function flag(value: boolean | null | undefined): boolean | undefined {
  return value === undefined || value === null ? undefined : value;
}

/** Гарнитура — только непустая строка: пустое имя шрифта — не вид, а отсутствие поля. */
const fontFamilyOf = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** Кегль — только число: `null` в ответе Google значит «поля нет», а не «кегль null». */
const fontSizeOf = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined;

/**
 * Формат числа: тип — из тех, что знает домен, шаблон — только непустой. Тип
 * `NUMBER_FORMAT_TYPE_UNSPECIFIED` или незнакомый — мимо: записать его обратно схема правки не
 * пустит, и откат такого вида был бы обещанием без способа его исполнить.
 */
function toNumberFormat(
  format: sheets_v4.Schema$NumberFormat | null | undefined,
): NumberFormat | undefined {
  const type = format?.type;
  if (typeof type !== 'string' || !isNumberFormatType(type)) return undefined;
  const pattern = format?.pattern;
  return typeof pattern === 'string' && pattern !== '' ? { type, pattern } : { type };
}

/**
 * Явный вид ячейки. Берётся `userEnteredFormat`, а НЕ `effectiveFormat`: второй показывает
 * и то, что пришло от темы или условного форматирования, — откатывать такое ядру нечем, а
 * показать в превью «было → станет» значило бы обещать правку чужого механизма. Шрифт и
 * формат числа по умолчанию у листа тоже живут только в `effectiveFormat` — сюда не попадают.
 */
export function toFormat(cell: sheets_v4.Schema$CellData): CellFormat | undefined {
  const format = cell.userEnteredFormat;
  if (format === undefined || format === null) return undefined;
  const text = format.textFormat ?? {};
  const fields = {
    bold: flag(text.bold),
    italic: flag(text.italic),
    underline: flag(text.underline),
    align: toAlign(format.horizontalAlignment),
    background: toHex(format.backgroundColor ?? undefined),
    fontFamily: fontFamilyOf(text.fontFamily),
    fontSize: fontSizeOf(text.fontSize),
    numberFormat: toNumberFormat(format.numberFormat),
  };
  const out = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as CellFormat;
  return Object.keys(out).length === 0 ? undefined : out;
}
