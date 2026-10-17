/**
 * Зависимости и форма инструмента MCP-слоя.
 *
 * Отдельным модулем, чтобы обвязка `gc_apply` (`apply-support.ts`) не импортировала сам
 * `tools.ts`: цикл между определениями инструментов и их обвязкой развалился бы первым же
 * рефакторингом. Исторический адрес импорта — `tools.ts`, он эти типы ре-экспортирует.
 */

import type { z } from 'zod';

import type { DocsClient } from '../core/docs/types.js';
import type { DriveClient } from '../core/google/drive.js';
import type { GcErrorPayload } from '../core/errors.js';
import type { GrantKeys, GrantState } from '../core/grant/grants.js';
import type { JournalSink, JournalSource } from '../core/journal.js';
import type { SheetsClient } from '../core/sheets/types.js';
import type { Registry } from '../core/targets.js';

export interface ToolDeps {
  readonly account: string;
  sheets(): Promise<SheetsClient>;
  docs(): Promise<DocsClient>;
  drive(): Promise<DriveClient>;
  registry(): Promise<Registry>;
  readonly journal: JournalSink;
  readonly journalSource: JournalSource;
  /** Ревизия таблицы сейчас — нужна журналу и откату (§10.3). */
  revision(targetId: string): Promise<string | null>;
  /**
   * Проект сессии (`CLAUDE_PROJECT_DIR`, D-23). Нет — проекта нет: запись вне реестра
   * невозможна, откат видит все записи (вызов человека из терминала).
   */
  readonly project?: string;
  /** Действующее разрешение проекта. Нет функции — разрешения нет, право даёт только реестр. */
  grant?(): Promise<GrantState>;
  /** Ключи разрешения — для `gc_grant`: выдать касанием. */
  readonly grantKeys?: GrantKeys;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: GcErrorPayload;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** zod-форма входа: из неё же SDK собирает JSON-схему для `tools/list`. */
  readonly input: z.ZodRawShape;
  /**
   * Свой разбор входа вместо общего строгого по `input` (D-22). Нужен, когда общая схема
   * судит хуже: у `gc_apply` она одна на все операции, и `afterHeading` у `insertText`
   * прошёл бы её молча, — поля операции судит ядро.
   */
  parseInput?(args: Record<string, unknown>): Record<string, unknown>;
  handle(args: Record<string, unknown>, deps: ToolDeps): Promise<unknown>;
}
