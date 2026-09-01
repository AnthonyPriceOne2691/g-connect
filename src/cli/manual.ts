#!/usr/bin/env node
/**
 * Минимальная обвязка для ЖИВОЙ проверки слайса 3 (`runtime_paths` в STATUS).
 * Это не CLI-фасад из фазы 3 — только то, чем человек проверяет реальный путь:
 * вход в аккаунт и чтение/запись настоящей таблицы.
 *
 *   npm run gc -- login
 *   npm run gc -- map <ссылка на таблицу> [имя листа]
 *   npm run gc -- upsert <ссылка> <лист> <ключ=значение,...> <поле=значение,...> [--write]
 */

import { execFileSync } from 'node:child_process';

import { MVP_SCOPES, ensureAccessToken, login } from '../core/auth.ts';
import { isGcError } from '../core/errors.ts';
import { googleExchanger } from '../core/google/exchanger.ts';
import { GoogleSheetsClient } from '../core/google/sheets.ts';
import { profileStatus } from '../core/profiles.ts';
import { buildSheetData } from '../core/sheets/map.ts';
import { upsertRow } from '../core/sheets/rows.ts';
import { assertWritable, loadRegistry, resolveTarget } from '../core/targets.ts';

const ACCOUNT = process.env['GCONNECT_ACCOUNT'] ?? 'default';

const openInBrowser = (url: string): void => {
  console.log('\nОткрой ссылку и подтверди доступ:\n' + url + '\n');
  try {
    if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
  } catch {
    /* браузер не открылся — ссылка уже напечатана выше */
  }
};

const pairs = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(',')
      .map((part) => part.split('='))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [(k ?? '').trim(), (v ?? '').trim()]),
  );

async function client(): Promise<GoogleSheetsClient> {
  const accessToken = await ensureAccessToken({ account: ACCOUNT, exchanger: googleExchanger });
  return new GoogleSheetsClient({
    accessToken,
    onRetry: (attempt, total, delay) =>
      console.log(`  Google не ответил, повтор ${attempt} из ${total} через ${delay} мс…`),
  });
}

async function cmdLogin(): Promise<void> {
  const before = await profileStatus(ACCOUNT);
  console.log(`Профиль «${ACCOUNT}»: ${before.state}`);
  const result = await login({ account: ACCOUNT, exchanger: googleExchanger, present: openInBrowser });
  console.log(
    `\nГотово. Права: ${result.scopes.map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(', ')}`,
  );
}

async function cmdMap(ref: string, sheet?: string): Promise<void> {
  const target = resolveTarget(ref, await loadRegistry(ACCOUNT));
  const snapshot = await (await client()).getSpreadsheet(target.id, sheet === undefined ? {} : { sheet });
  const { map } = buildSheetData(snapshot, sheet === undefined ? {} : { sheet });

  console.log(`\nТаблица: ${map.spreadsheetTitle}  (ревизия ${map.revisionId ?? 'неизвестна'})`);
  console.log(`Лист: ${map.sheet} · ${map.usedRange} · строк данных: ${map.dataRowCount}`);
  console.log(`Шапка: ${map.headerRowReason}${map.headerRowConfident ? '' : '  ← выбрана неуверенно'}`);
  console.log('\nКолонки:');
  for (const column of map.columns) {
    const enumPart =
      column.enumValues === null
        ? ''
        : `  значения: ${column.enumValues.join(' | ')} (${column.enumSource === 'validation' ? 'из таблицы' : 'выведено'})`;
    const flags = [column.hasFormula ? 'формулы' : '', column.protected ? 'защищена' : '']
      .filter(Boolean)
      .join(', ');
    console.log(
      `  ${column.letter}  ${column.name} — ${column.type}${column.dateFormat === null ? '' : `/${column.dateFormat}`}` +
        `  заполнено ${column.filled}${flags === '' ? '' : `  [${flags}]`}${enumPart}`,
    );
  }
  if (map.otherSheets.length > 0) {
    console.log('\nДругие листы: ' + map.otherSheets.map((s) => `${s.title} (${s.rowCount})`).join(', '));
  }
  for (const warning of map.warnings) console.log(`\n⚠ ${warning}`);
  console.log('\nПримеры строк:');
  for (const row of map.sampleRows) console.log('  ' + JSON.stringify(row, null, 0));
}

async function cmdUpsert(ref: string, sheet: string, keyText: string, valueText: string, write: boolean): Promise<void> {
  const registry = await loadRegistry(ACCOUNT);
  const target = resolveTarget(ref, registry);
  if (write) assertWritable(target);

  const api = await client();
  const data = buildSheetData(await api.getSpreadsheet(target.id, { sheet }), { sheet });
  const outcome = await upsertRow(api, data, pairs(keyText), pairs(valueText), {
    dryRun: !write,
    ...(target.entry?.aliases === undefined ? {} : { aliases: target.entry.aliases }),
  });

  console.log(`\nСтатус: ${outcome.status}`);
  for (const assumption of outcome.assumptions) console.log(`  допущение: ${assumption}`);
  for (const note of outcome.notes) console.log(`  значение: ${note}`);
  for (const question of outcome.questions) {
    console.log(`  ВОПРОС (${question.reason}) по «${question.field}»: ${question.detail}`);
    if (question.candidates.length > 0) console.log(`    варианты: ${question.candidates.join(' | ')}`);
    else console.log(`    доступно: ${question.available.join(' | ')}`);
  }
  if (outcome.changes.length === 0 && outcome.status !== 'needs_clarification') {
    console.log('  изменений нет — значения уже такие');
  }
  for (const change of outcome.changes) {
    console.log(`  ${change.kind === 'addRow' ? '+' : '~'} ${change.a1} (${change.column}): ${String(change.before)} → ${String(change.after)}`);
  }
  if (!write && outcome.changes.length > 0) console.log('\nЭто превью. Чтобы записать — повтори с --write');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const write = args.includes('--write');
  const rest = args.filter((a) => a !== '--write');

  switch (command) {
    case 'login':
      await cmdLogin();
      return;
    case 'map':
      if (rest[0] === undefined) throw new Error('нужна ссылка: npm run gc -- map <ссылка> [лист]');
      await cmdMap(rest[0], rest[1]);
      return;
    case 'upsert':
      if (rest.length < 4) {
        throw new Error('нужно: npm run gc -- upsert <ссылка> <лист> <ключ=знач,...> <поле=знач,...> [--write]');
      }
      await cmdUpsert(rest[0]!, rest[1]!, rest[2]!, rest[3]!, write);
      return;
    case 'status': {
      const status = await profileStatus(ACCOUNT);
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    default:
      console.log('Команды: login · status · map <ссылка> [лист] · upsert <ссылка> <лист> <ключ> <значения> [--write]');
  }
}

main().catch((error: unknown) => {
  if (isGcError(error)) {
    const p = error.payload;
    console.error(`\n✗ ${p.title}`);
    if (p.detail !== undefined) console.error(`  ${p.detail}`);
    if (p.action !== null) console.error(`  → ${p.action.label}`);
    console.error(`  (${p.code}${p.cause === undefined ? '' : ` / ${p.cause}`}, ${p.correlationId})`);
  } else {
    console.error(`\n✗ ${(error as Error).message}`);
  }
  process.exitCode = 1;
});
