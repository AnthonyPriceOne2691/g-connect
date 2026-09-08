/**
 * Журнал записей: типы и контракт (DESIGN.md §11.4, §10).
 *
 * Ядро journal НЕ пишет само — оно получает приёмник (`JournalSink`) снаружи. Иначе
 * запись в файл оказалась бы вшита в бизнес-логику, тесты потребовали бы файловой
 * системы, а гейт `di-indirection` был бы прав, что зависимость добывается, а не даётся.
 */

import type { DocOperationKind, DocRangeSnapshot, DocTextRun } from './docs/types.js';
import type { CellFormat, SheetProperties } from './sheets/types.js';

export interface JournalChange {
  readonly a1: string;
  readonly column: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
  /**
   * Снимок вида «до» и «после» для правок вида (решение от 2026-09-03: формат
   * откатывается, а не объявляется неоткатываемым). Только затронутые ячейки и только
   * изменяемые поля — журнал не должен расти пропорционально размеру таблицы.
   */
  readonly beforeFormat?: CellFormat;
  readonly afterFormat?: CellFormat;
}

/**
 * Что сделали с геометрией листа (D-19, фаза 2.5b).
 *
 * Ячеечной формой `JournalChange` структурную правку описать нельзя: у исчезнувшей строки
 * нет ячейки, в которую можно вернуть значение, — сначала надо вернуть саму строку.
 * Поэтому откат структурной правки читает ЭТО поле и применяет обратную операцию, а уже
 * потом заливает `snapshot`.
 */
export type StructuralKind =
  | 'insertRows'
  | 'insertColumns'
  | 'deleteRows'
  | 'deleteColumns'
  | 'addSheet'
  | 'renameSheet'
  | 'deleteSheet'
  | 'moveRows'
  | 'sortRange'
  | 'copyRange'
  | 'cutRange'
  | 'autoFill'
  | 'duplicateSheet'
  | 'createFile';

export interface StructuralChange {
  readonly kind: StructuralKind;
  /** Лист, чью геометрию правили. Для `createFile` — имя созданного файла. */
  readonly sheet: string;
  /** 1-based позиция «перед этим номером» — как в домене, а не как в библиотеке. */
  readonly at?: number;
  readonly count?: number;
  /**
   * Куда переносили: 0-based `destinationIndex` в том виде, в каком его понимает Google —
   * по координатам ДО удаления блока. Обратный ход считается из него формулой, покрытой
   * оракулом на числах.
   */
  readonly to?: number;
  /** Новое имя листа или файла; прежнее — в `previousTitle`. */
  readonly title?: string;
  readonly previousTitle?: string;
  /** Id созданного файла Drive: по нему откат кладёт его в корзину. */
  readonly fileId?: string;
  /** Свойства удалённого листа, которые откат умеет вернуть (закрепления, цвет, ширины). */
  readonly properties?: SheetProperties;
  /**
   * Чего откат вернуть НЕ сможет, названное числом. Уезжает в журнал, потому что ответ
   * отката обязан сказать не только что вернулось, но и что нет (урок L5).
   */
  readonly irreversible?: readonly string[];
}

export interface SnapshotCell {
  readonly value: string | number | boolean | null;
  readonly format?: CellFormat;
}

/**
 * Снимок содержимого для восстановления. Только затронутый диапазон и только в пределах
 * бюджета (`write.snapshot-max-cells`): журнал не должен расти пропорционально таблице, а
 * операция, чей снимок в бюджет не влез, обязана отказать ДО записи, а не записаться
 * необратимо.
 */
export interface DocWriteDetail {
  readonly tab: string;
  /** Диапазон, который заняла правка (юниты ПОСЛЕ записи) — его откат и удаляет/сверяет. */
  readonly startIndex: number;
  readonly endIndex: number;
  /** Снимок «до» для удалений и замен; у вставки его нет — откат удаляет вставленное. */
  readonly snapshot?: DocRangeSnapshot;
  /**
   * Что фактически встало в документ (вставки). Охранник отката сверяет ЭТО с текущим
   * текстом диапазона: правленное вставленное откатывать нельзя — унесёт чужое (P4).
   */
  readonly inserted?: string;
  /**
   * Массовая замена: каждое вхождение — что занимает сейчас и что было. Позиции — ПОСЛЕ
   * правки; откат идёт с конца, чтобы сдвиги не портили адреса предыдущих.
   */
  readonly replacements?: readonly DocReplacement[];
  /** Табличная правка: структура и снимок содержимого (уровень 3, слайс 6c). */
  readonly table?: DocTableDetail;
}

/** Табличная правка документа: чем откатывать структуру и чем вернуть содержимое. */
export interface DocTableDetail {
  readonly kind:
    'insertTable' | 'insertRow' | 'insertColumn' | 'deleteRow' | 'deleteColumn' | 'deleteTable';
  /** startIndex таблицы ПОСЛЕ правки; у deleteTable — точка, где таблица стояла. */
  readonly tableStart: number;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
  readonly rows?: number;
  readonly columns?: number;
  /** Снимок удалённой строки/колонки: по ячейке — прогоны со стилями. */
  readonly cells?: readonly (readonly DocTextRun[])[];
  /** Снимок всей удалённой таблицы: `grid[r][c]` — прогоны ячейки. */
  readonly grid?: readonly (readonly (readonly DocTextRun[])[])[];
}

/** Одно вхождение массовой замены: текущий диапазон и снимок оригинала. */
export interface DocReplacement {
  readonly tab: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly runs: readonly DocTextRun[];
}

export interface RangeSnapshot {
  readonly a1Range: string;
  readonly rows: readonly (readonly SnapshotCell[])[];
}

export interface WriteRecord {
  /** ISO-время записи. */
  readonly at: string;
  readonly account: string;
  readonly targetId: string;
  readonly alias: string | null;
  readonly sheet: string;
  readonly op:
    | 'appendRow'
    | 'upsertRow'
    | 'setCells'
    | 'formatCells'
    | 'findReplace'
    | StructuralKind
    | DocOperationKind
    | 'undo';
  readonly changes: readonly JournalChange[];
  /** Геометрия: что сделали со строками, колонками, листами или файлами (D-19). */
  readonly structure?: StructuralChange;
  /**
   * Содержимое затронутых диапазонов «до» — им откат восстанавливает исчезнувшее.
   *
   * Список, а не один диапазон: у `cutRange` их два (источник и получатель), и добавлять
   * второе поле рядом с первым значило бы держать одно понятие в двух местах.
   */
  readonly snapshots?: readonly RangeSnapshot[];
  /**
   * Текстовая форма записи (уровень 3): таб, затронутый диапазон ПОСЛЕ правки и снимок
   * «до» — им откат восстанавливает текст со стилями. У табличных записей поля нет,
   * прежние записи целы (та же совместимость, что у `structure`/`snapshots`, D-19).
   */
  readonly doc?: DocWriteDetail;
  /** Ревизия таблицы до и после записи — по ним undo решает, безопасен ли откат. */
  readonly revisionBefore: string | null;
  readonly revisionAfter: string | null;
  readonly correlationId: string;
  /**
   * Код плана (D-16), которым человек подтвердил эту запись. По нему же ловится повторное
   * «пиши»: тот же план дважды — не повтор, а вторая правка (B20).
   */
  readonly planId?: string;
  /** Для записи типа `undo` — correlationId той записи, которую откатили. */
  readonly undoOf?: string;
}

/** Куда уходит запись журнала. */
export type JournalSink = (record: WriteRecord) => Promise<void>;

/** Откуда undo берёт историю. */
export interface JournalSource {
  recent(targetId: string, limit: number): Promise<readonly WriteRecord[]>;
}

/** Приёмник, который ничего не делает: для превью и для тестов, где журнал не проверяют. */
export const noopJournal: JournalSink = () => Promise.resolve();

/**
 * Последняя запись, которую ещё не откатывали. Откат уже откаченного — не «повтор»,
 * а второй откат: он вернул бы значения, которых человек не выбирал.
 *
 * Запись БЕЗ ячеек пропускается — но только если у неё нет и геометрии: у структурной
 * правки ячеек не бывает вовсе («вставили строку» нечего описывать ячейками), и раньше
 * такая запись становилась неоткатываемой молча — `gc_undo` отвечал «откатывать нечего»
 * сразу после успешной вставки.
 */
export function lastUndoable(records: readonly WriteRecord[]): WriteRecord | null {
  const undone = new Set(
    records.filter((r) => r.op === 'undo' && r.undoOf !== undefined).map((r) => r.undoOf),
  );
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.op === 'undo') continue;
    if (undone.has(record.correlationId)) continue;
    // Запись без ячеек, геометрии И текста — превью-след, откатывать нечего. Проверка
    // на `doc` не украшение: без неё вставка в документ считалась бы неоткатываемой —
    // тот же класс дыры, что нашёл оракул G3 у структурных правок (уровень 2).
    if (record.changes.length === 0 && record.structure === undefined && record.doc === undefined)
      continue;
    return record;
  }
  return null;
}
