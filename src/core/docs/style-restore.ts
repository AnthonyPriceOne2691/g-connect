/**
 * Вид прогонов после вставки текста — одно правило на откаты абзацев и ячеек таблиц.
 *
 * Вставленный текст наследует стиль соседа: в абзаце — символа слева, в новой строке или
 * колонке таблицы — ячейки-образца (живой прогон 2026-10-01, LR3-2: под строкой с жирным
 * «Иванов» вставленный «Петров» стал жирным). Поэтому стиль КАЖДОГО прогона задаётся
 * точно: маска перечисляет все управляемые поля, и отсутствующее в снимке сбрасывается.
 * Восстанавливается ровно заданное явно — без ложного `false` поверх стиля заголовка.
 */

import type { DocRequest, DocTextRun } from './types.js';

/** Точные стили прогонов, вставленных с позиции `at`. Пустые прогоны и переносы — мимо. */
export function exactStyleRequests(
  tabId: string,
  at: number,
  runs: readonly DocTextRun[],
): DocRequest[] {
  const requests: DocRequest[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (run.text !== '' && run.text !== '\n') {
      requests.push({
        kind: 'updateTextStyle',
        tabId,
        startIndex: at + cursor,
        endIndex: at + cursor + run.text.length,
        style: run.style ?? {},
        exact: true,
      });
    }
    cursor += run.text.length;
  }
  return requests;
}
