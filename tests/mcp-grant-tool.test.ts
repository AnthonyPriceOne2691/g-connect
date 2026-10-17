/**
 * `gc_grant` и право проекта в `gc_targets` (D-23, слайс 4): X1 и механика X3 — через
 * настоящий протокол (урок L26), с настоящей подписью и проверкой (`ssh-keygen`).
 * Палец здесь — программный ключ: живое окно Touch ID проверяет только прогон X3.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { currentGrant, type GrantKeys } from '../src/core/grant/grants.js';
import { gcGrant } from '../src/mcp/grant-tool.js';
import { gcTargets, type ToolDeps } from '../src/mcp/tools.js';
import { fileKeys, makeKey, type SoftKey } from './fixtures/grant-keys.js';
import { callMcp } from './fixtures/protocol.js';

const PROJECT = '/Users/someone/Documents/Ahrefs cases';

let owner: SoftKey;
let touches = 0;

beforeAll(async () => {
  owner = makeKey(
    await mkdtemp(join(tmpdir(), 'gconnect-tool-keys-')),
    'owner',
    'G connect@secretive.host',
  );
});

const original = process.env['GCONNECT_HOME'];
beforeEach(async () => {
  process.env['GCONNECT_HOME'] = await mkdtemp(join(tmpdir(), 'gconnect-tool-home-'));
  touches = 0;
});
afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

/** `project: null` — сессия без проекта; значение по умолчанию у `undefined` сработало бы молча. */
const deps = (
  keys: GrantKeys = fileKeys(owner, () => (touches += 1)),
  project: string | null = PROJECT,
): ToolDeps => ({
  account: 'default',
  sheets: () => Promise.reject(new Error('не нужно')),
  docs: () => Promise.reject(new Error('не нужно')),
  drive: () => Promise.reject(new Error('не нужно')),
  registry: () => Promise.resolve({ targets: [] }),
  journal: () => Promise.resolve(),
  journalSource: { recent: () => Promise.resolve([]) },
  revision: () => Promise.resolve(null),
  ...(project === null ? {} : { project }),
  grant: () => currentGrant(keys, project ?? undefined, 'default'),
  grantKeys: keys,
});

describe('gc_targets показывает право проекта (X1)', () => {
  it('без разрешения — «записи вне реестра нет: попроси владельца открыть G connect»', async () => {
    const result = await callMcp(gcTargets, {}, deps());
    const data = result.data as { grant: { project: string; state: string; detail: string } };
    expect(data.grant).toMatchObject({ project: PROJECT, state: 'no_grant' });
    expect(data.grant.detail).toContain('открой G connect');
  });

  it('после касания — открыт до 23:59 с названием проекта', async () => {
    await callMcp(gcGrant, { action: 'open' }, deps());
    const data = (await callMcp(gcTargets, {}, deps())).data as {
      grant: { state: string; expires: string; detail: string };
    };
    expect(data.grant.state).toBe('granted');
    expect(data.grant.expires).toMatch(/T23:59:59[+-]\d\d:\d\d$/);
  });
});

describe('gc_grant: выдать, показать, отозвать (X3, механика)', () => {
  it('open — одна просьба о касании, ответ называет проект и срок', async () => {
    const result = await callMcp(gcGrant, { action: 'open' }, deps());
    expect(result.data).toMatchObject({ status: 'granted', project: PROJECT });
    expect(String((result.data as { hint: string }).hint)).toContain('до ');
    expect(touches).toBe(1);
  });

  it('разрешение уже действует — open не просит палец второй раз', async () => {
    await callMcp(gcGrant, { action: 'open' }, deps());
    const again = await callMcp(gcGrant, { action: 'open' }, deps());
    expect(again.data).toMatchObject({ status: 'already_granted', state: 'granted' });
    expect(touches).toBe(1);
  });

  it('отмена касания — grant_declined, разрешения нет', async () => {
    const declining: GrantKeys = { ...fileKeys(owner), sign: () => Promise.resolve(undefined) };
    const result = await callMcp(gcGrant, { action: 'open' }, deps(declining));
    expect(result.error).toMatchObject({ code: 'grant_declined' });
    const status = await callMcp(gcGrant, {}, deps());
    expect(status.data).toMatchObject({ status: 'status', state: 'no_grant' });
  });

  it('revoke снимает разрешение; второй revoke — «отзывать нечего»', async () => {
    await callMcp(gcGrant, { action: 'open' }, deps());
    expect((await callMcp(gcGrant, { action: 'revoke' }, deps())).data).toMatchObject({
      status: 'revoked',
    });
    expect((await callMcp(gcGrant, { action: 'revoke' }, deps())).data).toMatchObject({
      status: 'nothing_to_revoke',
    });
    expect((await callMcp(gcGrant, {}, deps())).data).toMatchObject({ state: 'no_grant' });
  });

  it('сессия без проекта — разрешение выдать некому: needs_grant, палец не просят', async () => {
    const result = await callMcp(gcGrant, { action: 'open' }, deps(undefined, null));
    expect(result.error).toMatchObject({ code: 'needs_grant', cause: 'no_project' });
    expect(touches).toBe(0);
  });

  it('незнакомое действие — отказ формы, а не догадка', async () => {
    const result = await callMcp(gcGrant, { action: 'grant-forever' }, deps());
    expect(result.error?.code).toBe('bad_request');
    expect(touches).toBe(0);
  });
});
