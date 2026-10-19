/**
 * Команды токена под пальцем (D-24): `seal`, `login`, `run` и доступ к Google для команд CLI.
 *
 * Окно Touch ID здесь появляется сразу — команду набрал сам человек, и строка перед окном
 * печатается в его же терминал. Каждая команда — свой процесс, поэтому и своё касание.
 */

import { login } from '../core/auth.js';
import { defaultAccount, inheritedEnv } from '../core/env.js';
import { gcError } from '../core/errors.js';
import { googleExchanger, googleRevoker } from '../core/google/exchanger.js';
import { profileStatus } from '../core/profiles.js';
import { findAgeTools } from '../core/token/age.js';
import { runWithAccessToken } from '../core/token/run-with-token.js';
import { sealProfile } from '../core/token/seal-flow.js';
import { profileSealer, profileUnsealer } from '../core/token/sealing.js';
import { tokenVault, type TokenVault } from '../core/token/vault.js';

const ACCOUNT = defaultAccount();
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

type Present = (url: string) => void;

async function cliVault(): Promise<TokenVault> {
  const tools = await findAgeTools();
  return tokenVault({
    account: ACCOUNT,
    exchanger: googleExchanger,
    unsealer: profileUnsealer(tools, ACCOUNT),
    sealer: () => profileSealer(tools, ACCOUNT),
  });
}

/** Access-токен для команды CLI: строка — и окно Touch ID. */
export async function cliAccessToken(): Promise<string> {
  const vault = await cliVault();
  console.log('G connect просит палец или пароль Mac, чтобы открыть Google для этой команды…');
  await vault.unlock();
  return vault.accessToken();
}

/** Повторный вход (Google рубит его через 7 дней): токен сразу шифротекстом. */
export async function cmdLogin(present: Present): Promise<void> {
  const status = await profileStatus(ACCOUNT);
  console.log(`Профиль «${ACCOUNT}»: ${status.state}`);
  if (status.state === 'unsealed') {
    throw gcError('token_unsealed', {
      detail:
        'Токен лежит открытым файлом: вход поверх него оставил бы старый токен живым. ' +
        'Запусти npm run gc -- seal — он отзовёт старый вход и войдёт заново.',
    });
  }
  const sealer = await profileSealer(await findAgeTools(), ACCOUNT);
  const result = await login({ account: ACCOUNT, exchanger: googleExchanger, present, sealer });
  console.log(
    `\nГотово: вход зашифрован ключом анклава. Права: ${result.scopes.map((s) => s.replace(SCOPE_PREFIX, '')).join(', ')}`,
  );
}

/** Переход на токен под пальцем — один раз (`seal-flow.ts`). */
export async function cmdSeal(present: Present): Promise<void> {
  const report = await sealProfile({
    account: ACCOUNT,
    tools: await findAgeTools(),
    revoker: googleRevoker,
    login: (sealer) => login({ account: ACCOUNT, exchanger: googleExchanger, present, sealer }),
    say: (line) => console.log(line),
  });
  console.log(
    '\nГотово: токен Google зашифрован ключом анклава' +
      (report.revoked
        ? '; старый вход отозван — его копии в снимках и бэкапах больше ничего не открывают.'
        : '.'),
  );
  console.log('Дальше Google в каждой сессии и команде открывается касанием, на час.');
}

/** `gc run -- <команда>`: касание — и команда получает access-токен на ≤1 ч. */
export async function cmdRun(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args[0] === '--' ? args.slice(1) : args;
  if (command === undefined) {
    throw gcError('bad_request', { detail: 'Нужно: npm run gc -- run -- <команда> [аргументы]' });
  }
  const vault = await cliVault();
  console.log(
    'G connect просит палец или пароль Mac: команда получит доступ к Google на час ' +
      '(переменная GOOGLE_ACCESS_TOKEN).',
  );
  process.exitCode = await runWithAccessToken(vault, command, rest, inheritedEnv());
}
