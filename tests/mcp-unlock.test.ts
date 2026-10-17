/**
 * `gc_unlock` и закрытый Google (D-24, слайс 4) — через настоящий протокол (урок L26).
 *
 * Зависимости собраны так же, как в `server.ts`: клиент Google получает access-токен из
 * хранилища процесса, и закрытое хранилище отвечает `google_locked`. «Касание» — счётчик
 * расшифровок; шов `age` судят `token-age.test.ts` и `token-vault.test.ts`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MVP_SCOPES } from '../src/core/auth.js';
import { gcError } from '../src/core/errors.js';
import { newGrant } from '../src/core/grant/document.js';
import type { GrantState } from '../src/core/grant/grants.js';
import { profileDir, writeSealedToken } from '../src/core/profiles.js';
import { tokenForClients, tokenVault, type TokenVault } from '../src/core/token/vault.js';
import { gcApply, gcRead, gcTargets, type ToolDeps } from '../src/mcp/tools.js';
import { gcUnlock } from '../src/mcp/unlock-tool.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp } from './fixtures/protocol.js';
import { fakeSealer } from './fixtures/sealing.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/1UNLISTEDsheetAAAAAAAAAAAAAAAA/edit';
const PROJECT = '/Users/someone/Documents/Ahrefs cases';
const original = process.env['GCONNECT_HOME'];

let home = '';
let touches = 0;
let declineNext = false;

const vault = (): TokenVault =>
  tokenVault({
    account: 'default',
    exchanger: {
      exchangeCode: () => Promise.resolve({}),
      refresh: () => Promise.resolve({ access_token: 'A', expiry_date: Date.now() + 3_600_000 }),
    },
    unsealer: {
      unseal: () => {
        touches += 1;
        if (!declineNext) return Promise.resolve('{"refresh_token":"1//r"}');
        declineNext = false;
        return Promise.reject(gcError('unlock_declined', { cause: 'declined' }));
      },
    },
    sealer: () => Promise.resolve(fakeSealer()),
  });

/** Как `server.ts`: клиент Google — только с access-токеном той же функции `tokenForClients`. */
const deps = (google: TokenVault, grant?: GrantState): ToolDeps => {
  const client = new FakeSheetsClient(snapshot());
  const token = tokenForClients(google);
  const viaToken = async <T>(made: T): Promise<T> => {
    await token();
    return made;
  };
  return {
    account: 'default',
    project: PROJECT,
    google,
    sheets: () => viaToken(client),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => viaToken(new FakeDriveClient()),
    registry: () => Promise.resolve({ targets: [] }),
    journal: () => Promise.resolve(),
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => viaToken('rev-1'),
    grant: () => Promise.resolve(grant ?? { state: 'none', reason: 'no_grant', detail: 'нет' }),
  };
};

describe('gc_unlock: Google открывается касанием, объявленным строкой', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gconnect-unlock-'));
    process.env['GCONNECT_HOME'] = home;
    await mkdir(profileDir(), { recursive: true });
    await writeFile(
      join(profileDir(), 'credentials.json'),
      JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }),
    );
    await writeSealedToken(fakeSealer(), { refresh_token: '1//r', scope: MVP_SCOPES.join(' ') });
    touches = 0;
    declineNext = false;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['GCONNECT_HOME'];
    else process.env['GCONNECT_HOME'] = original;
    await rm(home, { recursive: true, force: true });
  });

  it('U3: закрытый Google — google_locked с действием, без окна; после касания — данные', async () => {
    const d = deps(vault());
    const locked = await callMcp(gcRead, { target: SHEET }, d);
    expect(locked.error).toMatchObject({
      code: 'google_locked',
      action: { kind: 'unlock_google' },
    });
    expect(touches).toBe(0);

    const opened = await callMcp(gcUnlock, {}, d);
    expect(opened.data).toMatchObject({
      status: 'unlocked',
      until: expect.stringMatching(/^\d\d:\d\d$/),
    });
    expect(touches).toBe(1);
    expect((await callMcp(gcRead, { target: SHEET }, d)).ok).toBe(true);
  });

  it('U4: второй gc_unlock в течение часа — already_unlocked, окна нет', async () => {
    const d = deps(vault());
    await callMcp(gcUnlock, {}, d);
    expect((await callMcp(gcUnlock, {}, d)).data).toMatchObject({ status: 'already_unlocked' });
    expect(touches).toBe(1);
  });

  it('U12: gc_targets — «закрыт» со строкой для человека, затем «открыт до HH:MM»; без окна', async () => {
    const d = deps(vault());
    const before = (await callMcp(gcTargets, {}, d)).data as {
      google: { state: string; detail: string };
    };
    expect(before.google.state).toBe('locked');
    expect(before.google.detail).toContain('G connect попросит палец');
    expect(before.google.detail).toContain('gc_unlock');
    await callMcp(gcUnlock, {}, d);
    const after = (await callMcp(gcTargets, {}, d)).data as {
      google: { state: string; detail: string };
    };
    expect(after.google).toMatchObject({
      state: 'unlocked',
      detail: expect.stringMatching(/до \d\d:\d\d/),
    });
    expect(touches).toBe(1);
  });

  it('U6: отказ касания — unlock_declined, повторяемо; Google остаётся закрыт', async () => {
    const d = deps(vault());
    declineNext = true;
    const declined = await callMcp(gcUnlock, {}, d);
    expect(declined.error).toMatchObject({
      code: 'unlock_declined',
      retryable: true,
      action: { kind: 'unlock_google' },
    });
    expect((await callMcp(gcRead, { target: SHEET }, d)).error?.code).toBe('google_locked');
  });

  it('незнакомое поле у gc_unlock — отказ, а не молчаливый срез (урок L27)', async () => {
    const result = await callMcp(gcUnlock, { force: true }, deps(vault()));
    expect(result.error?.code).toBe('bad_request');
    expect(touches).toBe(0);
  });

  it('U13: запись вне реестра требует обоих касаний — разрешения проекта и Google', async () => {
    const upsert = {
      op: 'upsertRow',
      target: SHEET,
      key: { Проект: 'G connect' },
      values: { Статус: 'готово' },
      dryRun: false,
    };
    const granted: GrantState = {
      state: 'granted',
      grant: newGrant(PROJECT, 'default', new Date()),
    };
    // Разрешение есть, Google закрыт — google_locked; ни одной записи.
    const locked = deps(vault(), granted);
    expect((await callMcp(gcApply, upsert, locked)).error?.code).toBe('google_locked');
    // Google открыт, разрешения нет — needs_grant.
    const open = vault();
    await open.unlock();
    expect((await callMcp(gcApply, upsert, deps(open))).error?.code).toBe('needs_grant');
    // Оба — запись проходит.
    expect((await callMcp(gcApply, upsert, deps(open, granted))).ok).toBe(true);
  });
});
