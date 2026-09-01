/**
 * Превью и отчёты самодостаточным HTML-файлом (DESIGN.md §13.3, ступень 0).
 *
 * Зачем файл, если есть JSON: широкую таблицу в терминале не читают. Ступень 0 даёт
 * человеку глазами увидеть «было → станет» ещё до всякой панели, и работает в любом
 * режиме — в чате, в IDE, из CLI.
 *
 * Файл самодостаточный: ни одной внешней ссылки, ни скриптов, ни шрифтов из сети.
 * Открывается с диска и не тянет ничего наружу.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { profilesRoot } from '../profiles.js';
import type { ApplyOutcome, PlannedChange, Question } from '../sheets/rows.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Экранирование: значения приходят из документов, то есть из недоверенного источника
 * (§9.7). Тип узкий намеренно — `unknown` дал бы «[object Object]» в отчёте, и линтер
 * на это справедливо ругался.
 */
type Printable = string | number | boolean | null | undefined;

function escapeHtml(value: Printable): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root { color-scheme: light dark; --ink: #1e1b3a; --soft: #5b5776; --line: #dcd9ea;
  --add: #0f7a4d; --del: #a3341f; --bg: #faf9fd; --card: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e9e7f5; --soft: #a5a1bd; --line: #33304a; --add: #6fd6a3; --del: #f0917a;
    --bg: #141324; --card: #1c1b30; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--ink);
  font: 15px/1.5 ui-sans-serif, -apple-system, 'SF Pro Text', 'Inter', system-ui, sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
.meta { color: var(--soft); font-size: .875rem; margin-bottom: 1.5rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 1rem 1.25rem; margin-bottom: 1rem; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { color: var(--soft); font-weight: 600; font-size: .8rem; text-transform: uppercase;
  letter-spacing: .04em; }
td.cell { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.was { color: var(--del); }
.will { color: var(--add); font-weight: 600; }
.note { color: var(--soft); font-size: .875rem; }
ul { margin: .35rem 0 0; padding-left: 1.1rem; }
.wrap { overflow-x: auto; }
.tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem;
  border: 1px solid var(--line); color: var(--soft); }
`.trim();

export interface PreviewMeta {
  readonly title: string;
  readonly spreadsheet: string;
  readonly sheet: string;
  readonly alias: string | null;
  readonly revision: string | null;
}

function changesTable(changes: readonly PlannedChange[]): string {
  if (changes.length === 0) return '<p class="note">Изменений нет: значения уже такие.</p>';
  const rows = changes
    .map(
      (change) => `<tr>
      <td class="cell">${escapeHtml(change.a1)}</td>
      <td>${escapeHtml(change.column)}</td>
      <td class="cell was">${change.before === null ? '—' : escapeHtml(change.before)}</td>
      <td class="cell will">${escapeHtml(change.after)}</td>
      <td><span class="tag">${change.kind === 'addRow' ? 'новая строка' : 'правка'}</span></td>
    </tr>`,
    )
    .join('\n');
  return `<div class="wrap"><table>
    <thead><tr><th>Ячейка</th><th>Колонка</th><th>Было</th><th>Станет</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function questionsBlock(questions: readonly Question[]): string {
  if (questions.length === 0) return '';
  const items = questions
    .map(
      (q) => `<li><strong>${escapeHtml(q.field)}</strong> — ${escapeHtml(q.detail)}
      ${
        q.candidates.length > 0
          ? `<br><span class="note">варианты: ${q.candidates.map(escapeHtml).join(' · ')}</span>`
          : `<br><span class="note">доступно: ${q.available.slice(0, 25).map(escapeHtml).join(' · ')}</span>`
      }</li>`,
    )
    .join('\n');
  return `<div class="card"><h2 style="font-size:1rem;margin:0 0 .5rem">Нужен ответ человека</h2>
    <ul>${items}</ul></div>`;
}

function listBlock(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `<div class="card"><h2 style="font-size:1rem;margin:0 0 .5rem">${escapeHtml(title)}</h2>
    <ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
}

/** HTML превью записи. Возвращает строку — запись в файл отдельным шагом. */
export function renderPreview(outcome: ApplyOutcome, meta: PreviewMeta): string {
  const statusText =
    outcome.status === 'preview'
      ? 'План: ничего ещё не записано'
      : outcome.status === 'ok'
        ? 'Записано'
        : 'Нужен ответ человека';

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title><style>${STYLE}</style></head>
<body><main>
  <h1>${escapeHtml(meta.title)}</h1>
  <p class="meta">${escapeHtml(statusText)} · таблица «${escapeHtml(meta.spreadsheet)}»,
    лист «${escapeHtml(meta.sheet)}»${meta.alias === null ? '' : ` · цель «${escapeHtml(meta.alias)}»`}
    ${meta.revision === null ? '' : ` · ревизия ${escapeHtml(meta.revision)}`}</p>
  <div class="card">${changesTable(outcome.changes)}</div>
  ${questionsBlock(outcome.questions)}
  ${listBlock('Как я понял запрос', outcome.assumptions)}
  ${listBlock('Что привёл к формату колонки', outcome.notes)}
</main></body></html>`;
}

export function reportsDir(): string {
  return join(profilesRoot(), 'reports');
}

/** Имя файла со временем: превью копятся, и их надо различать глазами. */
export function reportFileName(at: Date, kind: string): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}-${kind}.html`;
}

/** Пишет отчёт рядом с профилем (600), возвращает путь. */
export async function writeReport(
  html: string,
  kind: string,
  at: Date = new Date(),
): Promise<string> {
  const dir = reportsDir();
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE).catch(() => undefined);
  const path = join(dir, reportFileName(at, kind));
  await writeFile(path, html, { mode: FILE_MODE });
  await chmod(path, FILE_MODE).catch(() => undefined);
  return path;
}
