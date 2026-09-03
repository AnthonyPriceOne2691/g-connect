/**
 * Типы отката — отдельным модулем-низом.
 *
 * Не косметика: `undo.ts` (значения) и `undo-structure.ts` (геометрия) оба их используют,
 * и когда типы жили в `undo.ts`, гейт слоёв нашёл цикл — модуль геометрии импортировал
 * потребителя. Общий тип уходит вниз, а не разворачивает слой импортом обратно (§2.3).
 */

import type { JournalSink } from './journal.js';

export type NothingToUndoReason = 'journal_empty' | 'all_undone' | 'id_not_found';

export interface UndoOptions {
  readonly account?: string;
  /** Откатить КОНКРЕТНУЮ запись по её id — способ дотянуться до старой осознанно. */
  readonly correlationId?: string;
  /** Сколько последних записей откатить. Больше одной — редкий случай, но он законен. */
  readonly last?: number;
  /** Ревизия сейчас — только для записи в журнал; решение об откате принимается по ячейкам. */
  readonly currentRevision?: string | null;
  /**
   * Ревизия ПОСЛЕ обратной записи — тем же способом, каким её читает путь записи.
   * Раньше здесь стоял литерал `null`, хотя тип `WriteRecord` и `rules.md` обещают
   * человеку обе ревизии: строка отката была заведомо неполной.
   */
  readonly readRevision?: () => Promise<string | null>;
  /** Откатить, даже если наши ячейки изменили. Только по явному решению человека. */
  readonly force?: boolean;
  readonly journal?: JournalSink;
}

/**
 * Почему откатывать нечего. Три разных состояния раньше выглядели снаружи одинаково,
 * и модель дописывала причину сама: в живом прогоне B13 она сказала «журнал пуст»,
 * когда в журнале лежали четыре строки, просто все записи были уже откачены.
 */

export interface UndoOutcome {
  readonly status: 'ok' | 'nothing_to_undo';
  /** Что вернули: те же ячейки, но значения из снимка «до». */
  readonly restored: readonly {
    a1: string;
    column: string;
    value: string | number | boolean | null;
  }[];
  readonly undoneCorrelationId: string | null;
  readonly at: string | null;
  /** Заполнено только при `nothing_to_undo`. */
  readonly reason?: NothingToUndoReason;
  /** Причина человеческим текстом — её показывают, а не ветвят. */
  readonly detail?: string;
  /**
   * Что вернула геометрия (D-19): «вставленная строка 4 удалена», «лист Октябрь удалён».
   * Отдельным полем, потому что `restored` описывает ячейки, а у структурной правки
   * ячеек может не быть вовсе — и молчать об этом нельзя (урок L5).
   */
  readonly structureUndone?: string;
}
