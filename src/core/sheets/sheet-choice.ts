/**
 * Какой лист адресует вызов (D-26, Q27–Q29). Старшинство: явный `sheet` → `gid` ссылки → лист
 * реестра → первый лист книги. Явный `sheet` и `gid` о РАЗНЫХ листах — отказ, а не выбор.
 *
 * Живой прогон 2026-10-20: ссылка на вкладку «Лог проверок» (`…/edit?gid=112806398#gid=…`) без
 * `sheet` читалась первым листом «Вводная», без предупреждения — разбор ссылки gid отбрасывал.
 * Запись шла тем же путём: правка по ссылке на вкладку попала бы в первый лист, а внутри
 * конверта записалась бы сразу.
 *
 * Лист по gid выбирается ДО чтения сетки (урок L11): отказ стоит одного запроса метаданных, а не
 * чтения листа. `buildSheetData` получает уже имя листа — карта и превью называют его, как прежде.
 */

import { gcError } from '../errors.js';
import type { RegistryEntry, ResolvedTarget } from '../targets.js';
import type { SheetsClient, SheetTitle } from './types.js';

/** О каком листе и строке шапки просит вызов; поля нет — не просит. */
export interface SheetAsk {
  readonly sheet?: string | undefined;
  readonly headerRow?: number | undefined;
}

/** Лист и шапка для `buildSheetData`; поля нет — решает ядро (первый лист, шапка по эвристике). */
export interface SheetChoice {
  readonly sheet?: string;
  readonly headerRow?: number;
}

/**
 * Лист и шапка из реестра, если вызов их не задал. Без этого `gc_targets` обещал агенту «лист по
 * умолчанию: Проекты», а операция уходила на ПЕРВЫЙ лист книги (живая проба 2026-09-02).
 */
function sheetDefaults(entry: RegistryEntry | null, ask: SheetAsk): SheetChoice {
  const sheet = ask.sheet ?? entry?.sheet;
  const headerRow = ask.headerRow ?? entry?.headerRow;
  return {
    ...(sheet === undefined ? {} : { sheet }),
    ...(headerRow === undefined ? {} : { headerRow }),
  };
}

export async function chooseSheet(
  client: Pick<SheetsClient, 'sheetTitles'>,
  target: ResolvedTarget,
  ask: SheetAsk,
): Promise<SheetChoice> {
  const { gid } = target;
  if (gid === undefined) return sheetDefaults(target.entry, ask);
  const sheets = await client.sheetTitles(target.id);
  const linked = sheets.find((sheet) => sheet.sheetId === gid);
  if (linked === undefined) throw unknownGid(gid, sheets);
  if (ask.sheet !== undefined && ask.sheet !== linked.title) throw gidMismatch(linked, ask.sheet);
  // Шапка реестра — у ЕГО листа (без `sheet` в реестре — у первого): строкой шапки чужой
  // вкладки она не становится, иначе вкладка по ссылке читалась бы не своими колонками.
  const registrySheet = target.entry?.sheet ?? sheets[0]?.title;
  const own = linked.title === registrySheet ? target.entry : null;
  return sheetDefaults(own, { sheet: linked.title, headerRow: ask.headerRow });
}

const listed = (sheets: readonly SheetTitle[]): string =>
  sheets.map((sheet) => `«${sheet.title}» (gid ${sheet.sheetId})`).join(', ');

function unknownGid(gid: number, sheets: readonly SheetTitle[]) {
  return gcError('bad_request', {
    detail:
      `В ссылке — лист с gid ${gid}, а в этой книге такого листа нет. Листы книги: ` +
      `${listed(sheets)}. Ни чтения, ни записи не было, первый лист вместо него не взят: ` +
      'спроси человека, какой лист он имел в виду.',
    cause: 'sheet_gid_unknown',
  });
}

function gidMismatch(linked: SheetTitle, asked: string) {
  return gcError('bad_request', {
    detail:
      `В ссылке — лист «${linked.title}» (gid ${linked.sheetId}), в sheet — «${asked}». Ни ` +
      'чтения, ни записи не было: спроси человека, какой из двух нужен, и не выбирай сам.',
    cause: 'sheet_gid_mismatch',
  });
}
