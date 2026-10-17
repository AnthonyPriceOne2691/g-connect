/**
 * Шов с `age` и `age-plugin-se` (D-24) — единственное место, где ядро шифрует и расшифровывает
 * токен Google.
 *
 * Зашифровать можно одним получателем — открытым ключом, без касания: поэтому вход и смена
 * refresh-токена пишут сразу шифротекст. Расшифровка идёт через плагин: ключ живёт в Secure
 * Enclave этого Mac, и macOS показывает Touch ID или пароль (`any-biometry-or-passcode` —
 * решение владельца 2026-10-17).
 *
 * Программы — по абсолютному пути, `PATH` ребёнка собран здесь: `age` ищет плагин по `PATH`, и
 * путь сессии подсунул бы чужой `age-plugin-se`. Каталог Homebrew пишется тем же
 * пользователем — это граница согласия, названная в спеке, а не изоляция.
 */

import { access, chmod, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { gcError, type GcError } from '../errors.js';
import { run, type RunResult } from '../subprocess.js';

/** Сколько ждать касания: дольше — `unlock_declined`, окно не держит вызов (спека). */
export const UNLOCK_TIMEOUT_MS = 60_000;
/** Касание или пароль Mac — решение владельца: с закрытой крышкой доступ остаётся. */
export const SE_ACCESS_CONTROL = 'any-biometry-or-passcode';
/** Где Homebrew кладёт программы: Apple Silicon, затем Intel. */
export const HOMEBREW_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin'];

const ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----';
/** Шифрование не ждёт человека: дольше этого — сбой программы, а не раздумье. */
const SEAL_TIMEOUT_MS = 10_000;

export interface AgeTools {
  readonly age: string;
  readonly plugin: string;
  /** `PATH` ребёнка: каталог программ и системный минимум. */
  readonly path: string;
}

export function ageToolsIn(dir: string): AgeTools {
  return {
    age: join(dir, 'age'),
    plugin: join(dir, 'age-plugin-se'),
    path: `${dir}:/usr/bin:/bin`,
  };
}

const executable = (file: string): Promise<boolean> =>
  access(file, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Первый каталог, где есть `age`; нет нигде — первый, и отказ придёт при обращении. */
export async function findAgeTools(dirs: readonly string[] = HOMEBREW_DIRS): Promise<AgeTools> {
  for (const dir of dirs) {
    if (await executable(join(dir, 'age'))) return ageToolsIn(dir);
  }
  return ageToolsIn(dirs[0] ?? '/opt/homebrew/bin');
}

/** Обе программы на месте — или отказ с командой установки, а не открытый токен (U10). */
export async function requireAgeTools(tools: AgeTools): Promise<void> {
  const missing = [];
  for (const file of [tools.age, tools.plugin]) {
    if (!(await executable(file))) missing.push(file);
  }
  if (missing.length > 0) throw toolMissing(missing.join(', '));
}

const toolMissing = (what: string): GcError =>
  gcError('seal_tool_missing', {
    detail:
      `Нет программ для шифрования токена: ${what}. Установи: brew install age age-plugin-se. ` +
      'Открытым файлом токен не хранится — без них G connect к Google не ходит.',
    cause: 'age_missing',
  });

/** Получатель (открытый ключ) из файла ключа: обе формы пишут строку `# public key:`. */
export function recipientInIdentity(text: string): string | undefined {
  return /^# public key: (\S+)$/m.exec(text)?.[1];
}

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter((line) => !line.includes('report unexpected'))
    .at(-1) ?? 'без объяснения';

const missingProgram = (result: RunResult): boolean =>
  result.code === null || /plugin not found|executable file not found/i.test(result.stderr);

/** Зашифровать для получателя. Касания нет: ключ анклава для этого не нужен. */
export async function sealFor(tools: AgeTools, recipient: string, plain: string): Promise<string> {
  const result = await run(tools.age, ['--encrypt', '--armor', '--recipient', recipient], {
    input: plain,
    env: { PATH: tools.path },
    timeoutMs: SEAL_TIMEOUT_MS,
  });
  if (result.code === 0 && result.stdout.startsWith(ARMOR)) return result.stdout;
  if (missingProgram(result)) throw toolMissing(tools.age);
  throw gcError('internal', {
    detail: `Токен не зашифрован: ${lastLine(result.stderr)}`,
    cause: 'age_seal_failed',
  });
}

/**
 * Расшифровать ключом анклава — окно Touch ID показывает плагин.
 *
 * Отменённое касание и чужой ключ `age` называет одинаково — «no identity matched»: плагин
 * на ошибке анклава пишет сообщение и продолжает (замер исходников 0.2.1). Различает их
 * получатель, которым зашифрован файл: совпал с ключом из файла ключа — касания не было,
 * не совпал — ключ не тот, и поможет только новый вход.
 */
export async function unsealWith(
  tools: AgeTools,
  identityFile: string,
  sealed: string,
  sealedFor: string,
  timeoutMs: number = UNLOCK_TIMEOUT_MS,
): Promise<string> {
  const result = await run(tools.age, ['--decrypt', '--identity', identityFile], {
    input: sealed,
    env: { PATH: tools.path },
    timeoutMs,
  });
  if (result.code === 0 && !result.timedOut) return result.stdout;
  throw await unsealFailure(tools, result, identityFile, sealedFor, timeoutMs);
}

async function unsealFailure(
  tools: AgeTools,
  result: RunResult,
  identityFile: string,
  sealedFor: string,
  timeoutMs: number,
): Promise<GcError> {
  if (result.timedOut) {
    return gcError('unlock_declined', {
      detail: `Касания не было ${Math.round(timeoutMs / 1000)} с — Google не открыт.`,
      cause: 'timeout',
    });
  }
  if (missingProgram(result)) return toolMissing(`${tools.age} или ${tools.plugin}`);
  if (/no identity matched/i.test(result.stderr)) {
    const own = recipientInIdentity(await readFile(identityFile, 'utf8').catch(() => ''));
    if (own !== undefined && own === sealedFor) {
      return gcError('unlock_declined', {
        detail:
          'Касание отменено или не прошло — Google не открыт. Повторяется после касания — ' +
          'ключ анклава недоступен, поможет новый вход (gc login).',
        cause: 'declined',
      });
    }
    return gcError('auth_expired', {
      detail:
        'Токен зашифрован ключом, которого у этого Mac нет (профиль с другой машины или ключ ' +
        'пересоздан). Войди заново: gc login.',
      cause: 'seal_key_gone',
    });
  }
  return gcError('internal', {
    detail: `Токен не расшифрован: ${lastLine(result.stderr)}`,
    cause: 'age_unseal_failed',
  });
}

/**
 * Новый ключ анклава. Касания создание не требует — по исходникам 0.2.1: политика доступа
 * проверяется при использовании ключа; живой замер — в прогоне `gc seal`. Файл ключа — ссылка
 * на ключ в Secure Enclave этого Mac, на другой машине он бесполезен. Возвращает получателя.
 */
export async function createSeIdentity(tools: AgeTools, file: string): Promise<string> {
  const result = await run(
    tools.plugin,
    ['keygen', `--access-control=${SE_ACCESS_CONTROL}`, '-o', file],
    { env: { PATH: tools.path }, timeoutMs: SEAL_TIMEOUT_MS },
  );
  if (missingProgram(result)) throw toolMissing(tools.plugin);
  const recipient = recipientInIdentity(await readFile(file, 'utf8').catch(() => ''));
  if (result.code !== 0 || recipient === undefined) {
    throw gcError('internal', {
      detail: `Ключ анклава не создан: ${lastLine(result.stderr)}`,
      cause: 'se_keygen_failed',
    });
  }
  await chmod(file, 0o600);
  return recipient;
}
