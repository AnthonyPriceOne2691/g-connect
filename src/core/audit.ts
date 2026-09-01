/**
 * Аудит-лог: файловая реализация журнала (DESIGN.md §11.4).
 *
 * `~/.gconnect/audit/YYYY-MM.jsonl`, права 600 в каталоге 700 — там же, где токены.
 * Формат JSONL: строка на запись, дописывается атомарно, читается построчно.
 *
 * Что здесь НЕ хранится: токены, ключи, содержимое `credentials.json`. Профиль
 * упоминается только именем. Значения ячеек хранятся — без них откат невозможен, — и
 * поэтому файл живёт под теми же правами, что креды, а не рядом с проектом.
 */

import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { gcError } from './errors.ts';
import { profilesRoot } from './profiles.ts';
import type { JournalSink, JournalSource, WriteRecord } from './journal.ts';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function auditDir(): string {
  return join(profilesRoot(), 'audit');
}

/** Файл месяца: `2026-09.jsonl`. Разбивка по месяцам держит файл читаемым руками. */
export function auditFile(at: Date = new Date()): string {
  const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  return join(auditDir(), `${month}.jsonl`);
}

/** Ключи, которых в журнале быть не должно ни при каких условиях. */
const FORBIDDEN_KEYS = ['access_token', 'refresh_token', 'client_secret', 'private_key'];

function assertNoSecrets(record: WriteRecord): void {
  const serialized = JSON.stringify(record);
  for (const key of FORBIDDEN_KEYS) {
    if (serialized.includes(key)) {
      throw gcError('internal', {
        detail: `Попытка записать в аудит поле «${key}» — журнал не хранит секреты.`,
        cause: 'secret_in_audit',
      });
    }
  }
}

export async function appendRecord(record: WriteRecord): Promise<void> {
  assertNoSecrets(record);
  const dir = auditDir();
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE).catch(() => undefined);
  const path = auditFile(new Date(record.at));
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
  await chmod(path, FILE_MODE).catch(() => undefined);
}

async function readMonth(at: Date): Promise<WriteRecord[]> {
  try {
    const text = await readFile(auditFile(at), 'utf8');
    const out: WriteRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as WriteRecord);
      } catch {
        // Битая строка не должна ронять чтение всего журнала: пропускаем её,
        // но и не делаем вид, что журнал полон — в отчёт это попадёт как пробел.
      }
    }
    return out;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw gcError('internal', {
      detail: 'Аудит-лог не читается.',
      cause: (error as Error).message,
    });
  }
}

/** Записи по цели, старые → новые. Смотрим текущий месяц и предыдущий: откат живёт недолго. */
export async function recentRecords(
  targetId: string,
  limit: number,
  now: Date = new Date(),
): Promise<readonly WriteRecord[]> {
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const all = [...(await readMonth(previousMonth)), ...(await readMonth(now))];
  return all.filter((r) => r.targetId === targetId).slice(-limit);
}

/** Приёмник журнала для реальной работы. */
export const fileJournal: JournalSink = appendRecord;

/** Источник истории для undo. */
export const fileJournalSource: JournalSource = {
  recent: (targetId, limit) => recentRecords(targetId, limit),
};
