/**
 * Журнал записей: типы и контракт (DESIGN.md §11.4, §10).
 *
 * Ядро journal НЕ пишет само — оно получает приёмник (`JournalSink`) снаружи. Иначе
 * запись в файл оказалась бы вшита в бизнес-логику, тесты потребовали бы файловой
 * системы, а гейт `di-indirection` был бы прав, что зависимость добывается, а не даётся.
 */

import type { CellFormat } from './sheets/types.js';

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
  | 'createFile';

export interface StructuralChange {
  readonly kind: StructuralKind;
  /** Лист, чью геометрию правили. Для `createFile` — имя созданного файла. */
  readonly sheet: string;
  /** 1-based позиция «перед этим номером» — как в домене, а не как в библиотеке. */
  readonly at?: number;
  readonly count?: number;
  /** Новое имя листа или файла; прежнее — в `previousTitle`. */
  readonly title?: string;
  readonly previousTitle?: string;
  /** Id созданного файла Drive: по нему откат кладёт его в корзину. */
  readonly fileId?: string;
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
    | 'undo';
  readonly changes: readonly JournalChange[];
  /** Геометрия: что сделали со строками, колонками, листами или файлами (D-19). */
  readonly structure?: StructuralChange;
  /** Содержимое затронутого диапазона «до» — им откат восстанавливает то, что исчезло. */
  readonly snapshot?: RangeSnapshot;
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
 */
export function lastUndoable(records: readonly WriteRecord[]): WriteRecord | null {
  const undone = new Set(
    records.filter((r) => r.op === 'undo' && r.undoOf !== undefined).map((r) => r.undoOf),
  );
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.op === 'undo') continue;
    if (undone.has(record.correlationId)) continue;
    if (record.changes.length === 0) continue;
    return record;
  }
  return null;
}
