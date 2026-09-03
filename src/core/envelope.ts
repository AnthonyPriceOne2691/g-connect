/**
 * Конверт разрешений цели (D-18): что человек разрешил делать с первой фразы.
 *
 * Зачем. Подтверждение кодом плана (D-16) связывало запись с показанным планом, но брало
 * за это вторую человеческую фразу на КАЖДУЮ правку. Связь и вторая фраза — разные вещи:
 * связь даёт один вызов плюс предусловие D-17, а фраза давала налог, из-за которого
 * инструмент за три дня не вышел за одну цель реестра. Разрешение переезжает туда, где
 * его подписывает человек: в реестр целей, один раз на цель.
 *
 * Отсутствие `auto` означает ОТСУТСТВИЕ разрешения, а не «дефолт по умолчанию»: конверт,
 * которого никто не написал, не может ничего разрешать. Поэтому предложенный состав
 * конверта живёт в правилах и в подсказке `gc_targets`, а не в значении по умолчанию.
 */

import { gcError } from './errors.js';
import type { EnvelopeDecision, OperationKind } from './sheets/write-types.js';

/**
 * Операции, которые ВООБЩЕ можно положить в конверт. Список, а не «всё, кроме»: любая
 * будущая операция (структурные из 2.5b — `insertRows`, `deleteRows`, `addSheet`) окажется
 * снаружи по построению, а не по чьей-то памяти. Удаление строки обратимо только при
 * снимке всей строки, а журнал хранит ячейки — до этого структурному в конверте не место.
 */
export const ENVELOPE_OPS: readonly OperationKind[] = [
  'appendRow',
  'upsertRow',
  'setCells',
  'formatCells',
  'findReplace',
  // Позиционные структурные (2.5b): добавляют место, ничего не уничтожая, и их откат —
  // обратная операция с охранником «вставленное ещё пусто».
  'insertRows',
  'insertColumns',
  'addSheet',
  'renameSheet',
  // Добавляющие и обратимые: копия колонки и автозаполнение возвращаются снимком,
  // копия листа удаляется откатом, созданный файл уходит в корзину.
  'copyRange',
  'autoFill',
  'duplicateSheet',
  // Создание файла (`createFile`) тоже добавляющее и обратимое — в корзину.
  'createFile',
];

/**
 * Операции, которые требуют финального подтверждения ВСЕГДА (D-20), сколько бы конверт ни
 * разрешал: «как очистка корзины в Windows» (решение владельца 2026-09-03).
 *
 * Деление не «опасно на слух», а проверяемое: здесь одна фраза уничтожает или
 * перемешивает то, чего в ответе не видно целиком. Такую операцию нельзя положить в
 * конверт — разбор реестра её отклонит.
 */
export const NAMED_CONFIRM_OPS: readonly OperationKind[] = [
  'deleteRows',
  'deleteColumns',
  'deleteSheet',
  'moveRows',
  'sortRange',
  // Вырезание уничтожает источник целиком, независимо от того, что переносит.
  'cutRange',
];

/** Граница по числу ячеек, когда конверт её не назвал. */
export const DEFAULT_MAX_CELLS = 50;

/** Потолок границы: выше общего бюджета изменений (`write.max-changes`) она бессмысленна. */
const BUDGET_CEILING = 200;

export interface AutoEnvelope {
  /** Операции, выполняемые с первой фразы. Остальные показывают план и код. */
  readonly ops: readonly OperationKind[];
  /** Сколько ячеек за раз конверт разрешает тронуть без показа плана. */
  readonly maxCells: number;
}

/**
 * Конверт из записи реестра. Битый конверт — не повод угадать, какую половину человек
 * имел в виду: это отказ с названной причиной. Читающая половина при этом не страдает —
 * конверт разбирается там, где принимается решение о записи.
 */
export function parseEnvelope(raw: unknown, alias: string | null): AutoEnvelope | null {
  if (raw === undefined || raw === null) return null;
  const where = alias === null ? 'в реестре' : `у цели «${alias}»`;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw envelopeError(`Конверт ${where} должен быть объектом с полем ops.`);
  }
  const { ops, maxCells } = raw as { ops?: unknown; maxCells?: unknown };
  return { ops: parseOps(ops, where), maxCells: parseMaxCells(maxCells, where) };
}

/**
 * Список операций конверта. Вынесен из `parseEnvelope` — гейт сложности отклонил
 * одиннадцатую ветвь, и по делу: «что за операции» и «какова граница» разные вопросы.
 */
function parseOps(raw: unknown, where: string): readonly OperationKind[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw envelopeError(`Конверт ${where}: поле ops обязательно и непусто.`);
  }
  for (const op of raw) {
    if (typeof op === 'string' && ENVELOPE_OPS.includes(op as OperationKind)) continue;
    const destructive = typeof op === 'string' && NAMED_CONFIRM_OPS.includes(op as OperationKind);
    throw envelopeError(
      `Конверт ${where}: операция «${String(op)}» в конверт не кладётся. ` +
        (destructive
          ? 'Она уничтожает или перемешивает то, чего в ответе не видно целиком, и ' +
            'требует финального подтверждения названием — всегда, сколько бы конверт ни ' +
            'разрешал (D-20). '
          : '') +
        `Можно: ${ENVELOPE_OPS.join(', ')}.`,
    );
  }
  return raw as readonly OperationKind[];
}

function parseMaxCells(raw: unknown, where: string): number {
  if (raw === undefined) return DEFAULT_MAX_CELLS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw envelopeError(`Конверт ${where}: maxCells — целое число больше нуля.`);
  }
  if (raw > BUDGET_CEILING) {
    throw envelopeError(
      `Конверт ${where}: maxCells ${raw} больше общего бюджета изменений ` +
        `(${BUDGET_CEILING} за вызов, правило write.max-changes) — такая граница ничего не значит.`,
    );
  }
  return raw;
}

function envelopeError(detail: string): ReturnType<typeof gcError> {
  return gcError('bad_request', {
    detail: `${detail} Пока конверт не исправлен, запись по этой цели идёт через план и код.`,
    cause: 'write.envelope-invalid',
  });
}

/**
 * Разрешает ли конверт эту правку с первой фразы.
 *
 * Судит только о РАЗРЕШЕНИИ. Неоднозначность (неизвестная колонка, значение вне списка),
 * формульная колонка и нулевое изменение — не про разрешение, и внутри конверта они
 * работают как снаружи: ядро спрашивает, а не догадывается.
 */
export function envelopeAuthorizes(
  envelope: AutoEnvelope | null,
  op: OperationKind,
  cellCount: number,
): EnvelopeDecision {
  // Разрушающая операция не авторизуется конвертом никогда — даже если её туда как-то
  // занесло: разбор реестра её отклоняет, но охранник записи не полагается на разбор.
  if (NAMED_CONFIRM_OPS.includes(op)) {
    return {
      authorized: false,
      reason: 'Эта правка уничтожает или перемешивает данные — нужно назвать её предмет.',
    };
  }
  if (envelope === null) {
    return { authorized: false, reason: 'У цели нет конверта: правка показывается планом.' };
  }
  if (!envelope.ops.includes(op)) {
    return {
      authorized: false,
      reason:
        `Конверт цели не включает «${op}» (в нём: ${envelope.ops.join(', ')}) — ` +
        'правка показывается планом, и записать её можно кодом плана.',
    };
  }
  if (cellCount > envelope.maxCells) {
    return {
      authorized: false,
      reason:
        `Правка трогает ${cellCount} ячеек, конверт цели разрешает ${envelope.maxCells} ` +
        'за раз — показан план, записать можно кодом плана.',
    };
  }
  return { authorized: true };
}
