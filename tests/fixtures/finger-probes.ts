/**
 * Проба правила подписи окна Touch ID (D-24, 27.11) — отдельным модулем, как `comment-probes.ts`:
 * реестр проб в policy.test.ts у предела длины. Заглушки `age` и плагина — `finger.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'vitest';

import { profileDir } from '../../src/core/profiles.js';
import { ageToolsIn } from '../../src/core/token/age.js';
import { profileUnsealer } from '../../src/core/token/sealing.js';
import { IDENTITY_CALL, STUB_META, agePrinted, stubPrograms } from './finger.js';

export const fingerProbes: Record<string, () => Promise<void>> = {
  // Окно называет профиль словами строки перед ним; подпись не легла — расшифровка всё равно идёт.
  'google.unlock-window-named': async () => {
    const root = await mkdtemp(join(tmpdir(), 'gconnect-finger-probe-'));
    try {
      const unsealer = profileUnsealer(ageToolsIn(await stubPrograms(root)), 'work');
      const named = agePrinted(await unsealer.unseal('x', STUB_META));
      expect(named.plugin).toBe(`v1|G connect (work)|${IDENTITY_CALL}`);
      const dir = join(profileDir('work'), 'finger');
      await rm(dir, { recursive: true });
      await writeFile(dir, 'не папка');
      const bare = agePrinted(await unsealer.unseal('x', STUB_META));
      expect(bare.plugin).toBe(`v1|age-plugin-se|${IDENTITY_CALL}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
};
