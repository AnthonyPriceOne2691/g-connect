/**
 * Мутационный гейт TS-половины (`scripts/lint/mutation_ts.sh` и `mutation_shard.sh`, канон
 * cqg@2.69 — наши починки №1–№3 вошли в канон, адаптации больше нет).
 *
 * `--mutate` из командной строки Stryker ЗАМЕНЯЕТ маску `mutate` конфига. Без фильтра гейт
 * по изменённым файлам отдал бы в мутацию `src/core/env.ts`, исключённый как защитный, а
 * мутант этого модуля 2026-09-02 записал фикстуры тестов в настоящий `~/.gconnect`. Доли
 * только СЧИТАЮТ, порог судит сумма (CQG §3.7, урок L31) — проводку суммы в CI судит здесь
 * оракул на настоящем `check_mutation_gate.sh`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Функция гейта в его же окружении: палитра пустая, `not_judged` — метка в stderr и выход. */
const gate = (call: string, changed: string[], shard = ''): string => {
  const run = spawnSync(
    'bash',
    [
      '-c',
      [
        'yellow= green= red= reset= STRICT=1 BASE=HEAD MIN_KILLED=60 BUDGET_SEC=5',
        'not_judged() { echo NOT_JUDGED >&2; exit 1; }',
        '. scripts/lint/mutation_ts.sh',
        '. scripts/lint/mutation_shard.sh',
        `cfg=stryker.config.json; changed="${changed.join('\n')}"; MUTATION_SHARD=${shard}`,
        `${call} >/dev/null; echo "rc=$? [$changed]"`,
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  return `${run.stdout}${run.stderr}`.trim();
};

describe('мутационный гейт: область — маска проекта', () => {
  it('из изменённых остаются только файлы маски: env.ts, адаптеры Google, типы, mcp и удалённые — нет', () => {
    const out = gate('ts_scope_filter', [
      'src/core/env.ts',
      'src/core/google/sheets.ts',
      'src/core/sheets/types.ts',
      'src/mcp/server.ts',
      'src/core/gone.ts',
      'src/core/ops.ts',
    ]);
    expect(out).toBe('rc=0 [src/core/ops.ts]');
  });

  it('только исключённые файлы — честное «судить нечего», а не прогон', () => {
    expect(gate('ts_scope_filter', ['src/core/env.ts', 'src/core/error-catalog.ts'])).toBe(
      'rc=1 []',
    );
  });
});

describe('мутационный гейт: доли параллельных джоб', () => {
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

  it('доли k/N делят список без потерь и пересечений', () => {
    const shares = ['1/2', '2/2'].map((shard) => gate('ts_shard', files, shard));
    expect(shares).toEqual(['rc=0 [a.ts\nc.ts\ne.ts]', 'rc=0 [b.ts\nd.ts]']);
  });

  it('без доли — весь список, как в каноне', () => {
    expect(gate('ts_shard', files)).toBe(`rc=0 [${files.join('\n')}]`);
  });

  it('пустая доля — «нечего», кривая доля — «не судит» (not_judged, красное)', () => {
    expect(gate('ts_shard', ['a.ts'], '2/2')).toBe('rc=1 []');
    expect(gate('ts_shard', ['a.ts'], '3/2')).toBe('NOT_JUDGED');
    expect(gate('ts_shard', ['a.ts'], 'x')).toBe('NOT_JUDGED');
  });
});

describe('мутационный гейт: сумма долей судит порог (джоба mutation-sum в CI)', () => {
  /** Настоящий гейт с MUTATION_SUM — так его зовёт CI; счета долей — во временном каталоге. */
  const sum = async (counts: Record<number, string>) => {
    const dir = await mkdtemp(join(tmpdir(), 'gconnect-shards-'));
    try {
      for (const [k, line] of Object.entries(counts)) {
        await writeFile(join(dir, `shard-${k}-of-4.counts`), `${line}\n`);
      }
      const run = spawnSync('bash', ['scripts/lint/check_mutation_gate.sh'], {
        encoding: 'utf8',
        env: { ...process.env, MUTATION_SUM: '4', MIN_KILLED: '60', MUTATION_COUNTS_DIR: dir },
      });
      return { code: run.status, out: `${run.stdout}${run.stderr}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('четыре счёта — порог по сумме: доля ниже порога не валит общий прогон (урок L31)', async () => {
    // Доля 1 — 59% (как на CI PR #4), а сумма 70%: судит сумма.
    const verdict = await sum({ 1: '59 100', 2: '80 100', 3: '0 0', 4: '71 100' });
    expect(verdict.code).toBe(0);
    expect(verdict.out).toContain('сумма 4 долей — убито 210 из 300 (70%), порог 60%');
  });

  it('сумма ниже порога — красное; доля без счёта — «не судит», а не зелёное', async () => {
    expect((await sum({ 1: '10 100', 2: '20 100', 3: '0 0', 4: '30 100' })).code).toBe(1);
    const missing = await sum({ 1: '80 100', 2: '80 100', 4: '80 100' });
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('нет счёта долей 3');
  });

  it('все доли без мутантов (PR без кода ядра) — «судить нечего», зелёное', async () => {
    const verdict = await sum({ 1: '0 0', 2: '0 0', 3: '0 0', 4: '0 0' });
    expect(verdict.code).toBe(0);
    expect(verdict.out).toContain('мутантов нет, судить нечего');
  });
});
