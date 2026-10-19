/**
 * Пробы правил двух профилей (D-25) — отдельным модулем, как `token-probes.ts`: реестр проб в
 * policy.test.ts у предела длины. Структурный оракул «у КАЖДОГО правила есть проба — и
 * наоборот» судит реестр целиком.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect } from 'vitest';

import { grantText, newGrant, projectKey } from '../../src/core/grant/document.js';
import { currentGrant, grantsDir, issueGrant, revokeGrant } from '../../src/core/grant/grants.js';
import type { WriteRecord } from '../../src/core/journal.js';
import { pickUndoRecord } from '../../src/core/undo-shared.js';
import { fileKeys, makeKey } from './grant-keys.js';

const PROJECT = '/Users/someone/project';

const write = (account: string, correlationId: string): WriteRecord => ({
  at: new Date().toISOString(),
  account,
  targetId: 'T',
  alias: null,
  sheet: 'Лист1',
  op: 'setCells',
  changes: [{ a1: 'B2', column: 'Часы', before: 1, after: 2 }],
  revisionBefore: null,
  revisionAfter: null,
  correlationId,
  project: PROJECT,
});

export const profileProbes: Record<string, () => Promise<void>> = {
  // D-25: разрешение рабочего профиля рядом с личным не затирает его, отзыв — тоже;
  // файл прежней раскладки (на проект) не открывает запись никому.
  'grant.per-profile': async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gconnect-probe-keys-'));
    try {
      const keys = fileKeys(makeKey(dir, 'owner', 'G connect@secretive.test-host'));
      await issueGrant(keys, PROJECT, 'default');
      await issueGrant(keys, PROJECT, 'work');
      expect(await revokeGrant(PROJECT, 'work')).toBe(true);
      expect(await currentGrant(keys, PROJECT, 'default')).toMatchObject({ state: 'granted' });
      await revokeGrant(PROJECT, 'default');
      const text = grantText(newGrant(PROJECT, 'default', new Date()));
      const root = dirname(grantsDir('default'));
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, `${projectKey(PROJECT)}.json`),
        JSON.stringify({ text, signature: await keys.sign(text, '', 5_000) }),
      );
      expect(await currentGrant(keys, PROJECT, 'default')).toMatchObject({ reason: 'no_grant' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  // D-25: запись другого профиля по id — отказ; последняя по цели — чужая → её сервер.
  'undo.own-profile': async () => {
    const source = { recent: () => Promise.resolve([write('default', 'gc-personal')]) };
    await expect(
      pickUndoRecord(source, 'T', {
        correlationId: 'gc-personal',
        account: 'work',
        project: PROJECT,
      }),
    ).rejects.toMatchObject({ payload: { code: 'policy_denied', cause: 'undo.own-profile' } });
    expect(await pickUndoRecord(source, 'T', { account: 'work', project: PROJECT })).toMatchObject({
      status: 'nothing_to_undo',
      reason: 'only_other_profiles',
      detail: expect.stringContaining('откат — сервером g-connect.'),
    });
  },
};
