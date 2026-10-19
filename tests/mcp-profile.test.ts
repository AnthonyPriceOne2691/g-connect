/**
 * Два профиля рядом (D-25): сервер на профиль, и каждый называет свой — первой строкой
 * инструкций, в `gc_targets`, в строке перед окном. Всё — через настоящий протокол (L26):
 * инструкции и имя сервера видит только клиент.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MVP_SCOPES } from '../src/core/auth.js';
import { gcCommand, grantPhrase, serverName, unlockLine } from '../src/core/profile-names.js';
import { profileDir, writeSealedToken } from '../src/core/profiles.js';
import { tokenForClients, tokenVault, type TokenVault } from '../src/core/token/vault.js';
import type { ToolDeps } from '../src/mcp/tools.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { protocolSession } from './fixtures/protocol.js';
import { fakeSealer } from './fixtures/sealing.js';
import { FakeSheetsClient, snapshot } from './fixtures/sheet.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/1UNLISTEDsheetAAAAAAAAAAAAAAAA/edit';
const original = process.env['GCONNECT_HOME'];

let home = '';
const touches: Record<string, number> = {};

const vaultOf = (account: string): TokenVault =>
  tokenVault({
    account,
    exchanger: {
      exchangeCode: () => Promise.resolve({}),
      refresh: () => Promise.resolve({ access_token: 'A', expiry_date: Date.now() + 3_600_000 }),
    },
    unsealer: {
      unseal: () => {
        touches[account] = (touches[account] ?? 0) + 1;
        return Promise.resolve('{"refresh_token":"1//r"}');
      },
    },
    sealer: () => Promise.resolve(fakeSealer()),
  });

/** Как `server.ts`: свой профиль, своё хранилище, клиенты Google — через его токен. */
const depsOf = (account: string, google: TokenVault = vaultOf(account)): ToolDeps => {
  const token = tokenForClients(google);
  const viaToken = async <T>(made: T): Promise<T> => {
    await token();
    return made;
  };
  return {
    account,
    google,
    sheets: () => viaToken(new FakeSheetsClient(snapshot())),
    docs: () => Promise.reject(new TypeError('документов в этом сьюте нет')),
    drive: () => viaToken(new FakeDriveClient()),
    registry: () => Promise.resolve({ targets: [] }),
    journal: () => Promise.resolve(),
    journalSource: { recent: () => Promise.resolve([]) },
    revision: () => viaToken('rev-1'),
  };
};

async function makeProfile(account: string, withToken: boolean): Promise<void> {
  await mkdir(profileDir(account), { recursive: true });
  await writeFile(
    join(profileDir(account), 'credentials.json'),
    JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }),
  );
  if (withToken) {
    await writeSealedToken(
      fakeSealer(),
      { refresh_token: '1//r', scope: MVP_SCOPES.join(' ') },
      account,
    );
  }
}

interface Targets {
  profile: { account: string; server: string; about: string; state: string; next?: string };
  otherProfiles: string[];
  google: { state: string; detail: string };
}

describe('два профиля рядом: сервер называет свой профиль', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gconnect-profiles-'));
    process.env['GCONNECT_HOME'] = home;
    await makeProfile('default', true);
    await makeProfile('work', true);
    for (const key of Object.keys(touches)) delete touches[key];
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['GCONNECT_HOME'];
    else process.env['GCONNECT_HOME'] = original;
    await rm(home, { recursive: true, force: true });
  });

  it('W2: профиль — первой строкой инструкций и в gc_targets; о другом — только имя сервера', async () => {
    const work = await protocolSession(depsOf('work'));
    const personal = await protocolSession(depsOf('default'));
    try {
      expect(work.client.getInstructions()?.split('\n')[0]).toContain(
        'Этот сервер — профиль «work» (g-connect-work)',
      );
      expect(personal.client.getInstructions()?.split('\n')[0]).toContain(
        'Этот сервер — профиль «default» (g-connect)',
      );
      const own = (await work.call('gc_targets', {})).data as Targets;
      expect(own.profile).toMatchObject({
        account: 'work',
        server: 'g-connect-work',
        state: 'connected',
      });
      expect(own.profile.about).toContain('профиль work');
      expect(own.otherProfiles).toEqual(['профиль default — сервер g-connect']);
      // Чужой профиль — только имя сервера: ни его состояния, ни прав отсюда не видно.
      expect(own).not.toHaveProperty('accounts');
      const mine = (await personal.call('gc_targets', {})).data as Targets;
      expect(mine.otherProfiles).toEqual(['профиль work — сервер g-connect-work']);
    } finally {
      await work.close();
      await personal.close();
    }
  });

  it('W3: рабочий закрыт — google_locked со строкой своего профиля; касание открывает только его', async () => {
    const workVault = vaultOf('work');
    const personalVault = vaultOf('default');
    const work = await protocolSession(depsOf('work', workVault));
    const personal = await protocolSession(depsOf('default', personalVault));
    try {
      const line = 'G connect (work) попросит палец, чтобы открыть Google этой сессии на час';
      const locked = await work.call('gc_read', { target: SHEET, mode: 'map' });
      expect(locked.error).toMatchObject({ code: 'google_locked' });
      expect(locked.error?.detail).toContain(`«${line}»`);
      expect(((await work.call('gc_targets', {})).data as Targets).google.detail).toContain(line);
      expect(touches['work'] ?? 0).toBe(0);

      expect((await work.call('gc_unlock', {})).data).toMatchObject({ status: 'unlocked' });
      expect(touches['work']).toBe(1);
      expect((await work.call('gc_read', { target: SHEET, mode: 'map' })).ok).toBe(true);
      // Личный — в своём процессе со своим хранилищем: касание рабочего его не открыло.
      expect(((await personal.call('gc_targets', {})).data as Targets).google.state).toBe('locked');
      expect(touches['default'] ?? 0).toBe(0);
    } finally {
      await work.close();
      await personal.close();
    }
  });

  it('W7: профиль без входа — сервер поднят, gc_targets называет шаг владельца', async () => {
    await rm(join(profileDir('work')), { recursive: true, force: true });
    await makeProfile('work', false);
    const work = await protocolSession(depsOf('work'));
    try {
      const own = (await work.call('gc_targets', {})).data as Targets;
      expect(own.profile.state).toBe('needs_reauth');
      expect(own.profile.next).toBe(
        'нет входа — владелец запускает GCONNECT_ACCOUNT=work npm run gc -- seal',
      );
    } finally {
      await work.close();
    }
  });

  it('W10: личный профиль звучит как до D-25 — имя, строка, фраза и команда слово в слово', async () => {
    expect(serverName('default')).toBe('g-connect');
    expect(unlockLine('default')).toBe(
      'G connect попросит палец, чтобы открыть Google этой сессии на час',
    );
    expect(grantPhrase('default')).toBe('открой G connect');
    expect(gcCommand('default', 'seal')).toBe('npm run gc -- seal');
    expect(serverName('work')).toBe('g-connect-work');
    expect(grantPhrase('work')).toBe('открой G connect (work)');
    const personal = await protocolSession(depsOf('default'));
    const work = await protocolSession(depsOf('work'));
    try {
      expect(personal.client.getServerVersion()?.name).toBe('g-connect');
      expect(work.client.getServerVersion()?.name).toBe('g-connect-work');
      const locked = await personal.call('gc_read', { target: SHEET, mode: 'map' });
      expect(locked.error?.detail).toContain(`«${unlockLine('default')}»`);
      expect(locked.error?.detail).not.toContain('(default)');
    } finally {
      await personal.close();
      await work.close();
    }
  });
});
