/**
 * Зависимости и форма инструмента MCP-слоя.
 *
 * Отдельным модулем, чтобы обвязка `gc_apply` (`apply-support.ts`) не импортировала сам
 * `tools.ts`: цикл между определениями инструментов и их обвязкой развалился бы первым же
 * рефакторингом. Исторический адрес импорта — `tools.ts`, он эти типы ре-экспортирует.
 */

import type { z } from 'zod';

import type { DriveClient } from '../core/google/drive.js';
import type { GcErrorPayload } from '../core/errors.js';
import type { JournalSink, JournalSource } from '../core/journal.js';
import type { SheetsClient } from '../core/sheets/types.js';
import type { Registry } from '../core/targets.js';

export interface ToolDeps {
  readonly account: string;
  sheets(): Promise<SheetsClient>;
  drive(): Promise<DriveClient>;
  registry(): Promise<Registry>;
  readonly journal: JournalSink;
  readonly journalSource: JournalSource;
  /** Ревизия таблицы сейчас — нужна журналу и откату (§10.3). */
  revision(targetId: string): Promise<string | null>;
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
  handle(args: Record<string, unknown>, deps: ToolDeps): Promise<unknown>;
}
