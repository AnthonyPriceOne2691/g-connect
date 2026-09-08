/**
 * Арифметика перемещения строк — одна на прямой и обратный ход.
 *
 * Отдельным модулем и чистыми функциями, потому что это единственное место поставки, где
 * ошибка не видна ни по ответу Google (он пустой), ни по типам: `destinationIndex`
 * считается ПО КООРДИНАТАМ ДО удаления блока, и наивное «вернуть туда, откуда взяли»
 * промахивается на `count` строк. Проверено примером из документации Google:
 * `A1..A5 = 0,1,2,3,4`, блок `[1,3)`, `destinationIndex = 4` → `0,3,1,2,4`.
 */

/** Где окажется блок `[start, start+count)` после переноса на `destination`. Всё 0-based. */
export function movedStart(start: number, count: number, destination: number): number {
  const shift = Math.min(Math.max(destination - start, 0), count);
  return destination - shift;
}

/**
 * Чем вернуть блок на прежнее место: откуда брать и куда переносить (0-based).
 *
 * Уезжал вниз (`destination > start`) — возвращаем на `start`; уезжал вверх — на
 * `start + count`, потому что при движении вверх координата «до удаления» больше на
 * размер блока. Оба случая проверены числами в оракуле.
 */
export function inverseMove(
  start: number,
  count: number,
  destination: number,
): { readonly from: number; readonly to: number } {
  return {
    from: movedStart(start, count, destination),
    to: destination > start ? start : start + count,
  };
}
