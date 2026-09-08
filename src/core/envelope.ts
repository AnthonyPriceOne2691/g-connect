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
 * будущая операция окажется снаружи по построению, а не по чьей-то памяти.
 *
 * Критерий — «не уничтожает и не перемешивает»: добавляющее и обратимое сюда кладётся,
 * разрушающее живёт в `NAMED_CONFIRM_OPS` и требует названия предмета всегда. Текст про
 * «структурные не кладутся» устарел со слайса 3 и был исправлен после разбора читателя
 * без прогона 2026-09-04 — он же стоял в D-18.
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
  // Документы (уровень 3): вставка нового абзаца добавляет, ничего не трогая, и её
  // откат удаляет ровно вставленный диапазон с охранником «не правлено»; точечная
  // замена в пределах ОДНОГО абзаца обратима снимком и масштаб её виден в превью.
  'appendText',
  'insertText',
  'replaceText',
  // Табличные вставки добавляют пустую структуру; откат удаляет её, пока она пуста.
  'insertTable',
  'insertTableRow',
  'insertTableColumn',
  // Стили обратимы снимком прежних полей; текст они не трогают вовсе.
  'updateTextStyle',
  'setParagraphStyle',
  'createParagraphBullets',
  'deleteParagraphBullets',
  // Разрыв страницы и картинка по URL: один юнит, откат удаляет вставленное.
  'insertPageBreak',
  'insertInlineImage',
];

/**
 * Имена, которыми создание файла зовут В ПРОТОКОЛЕ, → имя операции ядра.
 *
 * Читатель без прогона нашёл ловушку: в реестре надо было писать `createFile`, а человек
 * видит в схеме `createSheet`/`createDoc`/`createFolder` — и неверное имя роняло конверт
 * ЦЕЛИКОМ, то есть ломало и все прочие записи по этой цели. Принимаем оба написания.
 */
const OP_ALIASES: Readonly<Record<string, OperationKind>> = {
  createSheet: 'createFile',
  createDoc: 'createFile',
  createFolder: 'createFile',
};

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
  // Документы (уровень 3). Имена стоят здесь ДО реализации операций намеренно: это
  // запретительный список, и конверт обязан отклонять их уже сейчас — с текстом D-20,
  // а не «неизвестная операция». replaceAllText разрушающая решением владельца
  // 2026-09-08: массовая правка, чей масштаб виден только числом в превью.
  'deleteParagraph',
  'deleteRange',
  'deleteTable',
  'deleteTableRow',
  'deleteTableColumn',
  'replaceAllText',
];

/** Граница по числу ячеек, когда конверт её не назвал. */
export const DEFAULT_MAX_CELLS = 50;

/** Граница по UTF-16-юнитам для документов (подписано владельцем 2026-09-08). */
export const DEFAULT_MAX_CHARS = 1000;

/** Потолок maxChars: выше бюджета снимка граница ничего не значит. */
const CHARS_CEILING = 20000;

/** Потолок границы: выше общего бюджета изменений (`write.max-changes`) она бессмысленна. */
const BUDGET_CEILING = 200;

export interface AutoEnvelope {
  /** Операции, выполняемые с первой фразы. Остальные показывают план и код. */
  readonly ops: readonly OperationKind[];
  /** Сколько ячеек за раз конверт разрешает тронуть без показа плана. */
  readonly maxCells: number;
  /** Мера документов: сколько UTF-16-юнитов за раз (тексту ячейки мера не судья). */
  readonly maxChars: number;
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
  const { ops, maxCells, maxChars } = raw as {
    ops?: unknown;
    maxCells?: unknown;
    maxChars?: unknown;
  };
  return {
    ops: parseOps(ops, where),
    maxCells: parseMaxCells(maxCells, where),
    maxChars: parseMaxChars(maxChars, where),
  };
}

/**
 * Список операций конверта. Вынесен из `parseEnvelope` — гейт сложности отклонил
 * одиннадцатую ветвь, и по делу: «что за операции» и «какова граница» разные вопросы.
 */
function parseOps(raw: unknown, where: string): readonly OperationKind[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw envelopeError(`Конверт ${where}: поле ops обязательно и непусто.`);
  }
  const named: OperationKind[] = [];
  for (const item of raw as readonly unknown[]) {
    const asked = typeof item === 'string' ? item : '';
    const op = OP_ALIASES[asked] ?? asked;
    if (ENVELOPE_OPS.includes(op as OperationKind)) {
      named.push(op as OperationKind);
      continue;
    }
    const destructive = NAMED_CONFIRM_OPS.includes(op as OperationKind);
    throw envelopeError(
      `Конверт ${where}: операция «${String(item)}» в конверт не кладётся. ` +
        (destructive
          ? 'Она уничтожает или перемешивает то, чего в ответе не видно целиком, и ' +
            'требует финального подтверждения названием — всегда, сколько бы конверт ни ' +
            'разрешал (D-20). '
          : '') +
        `Можно: ${ENVELOPE_OPS.join(', ')}` +
        ` (создание файла можно назвать и так, как в протоколе: ${Object.keys(OP_ALIASES).join(', ')}).`,
    );
  }
  return named;
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

function parseMaxChars(raw: unknown, where: string): number {
  if (raw === undefined) return DEFAULT_MAX_CHARS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw envelopeError(`Конверт ${where}: maxChars — целое число больше нуля.`);
  }
  if (raw > CHARS_CEILING) {
    throw envelopeError(
      `Конверт ${where}: maxChars ${raw} больше бюджета снимка ` +
        `(${CHARS_CEILING}, правило write.snapshot-max-chars) — такая граница ничего не значит.`,
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
const DOC_OPS: ReadonlySet<OperationKind> = new Set([
  'appendText',
  'insertText',
  'replaceText',
  'insertTable',
  'insertTableRow',
  'insertTableColumn',
  'updateTextStyle',
  'setParagraphStyle',
  'createParagraphBullets',
  'deleteParagraphBullets',
  'insertPageBreak',
  'insertInlineImage',
]);

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
  // У документов мера — UTF-16-юниты (maxChars), у таблиц — ячейки (maxCells).
  const limit = DOC_OPS.has(op) ? envelope.maxChars : envelope.maxCells;
  const unit = DOC_OPS.has(op) ? 'юнитов текста' : 'ячеек';
  const limitName = DOC_OPS.has(op) ? 'maxChars' : 'maxCells';
  if (cellCount > limit) {
    return {
      authorized: false,
      reason:
        `Правка трогает ${cellCount} ${unit}, конверт цели разрешает ${limit} ` +
        `за раз (${limitName}) — показан план, записать можно кодом плана.`,
    };
  }
  return { authorized: true };
}
