/**
 * Поправка мутационного гейта (`scripts/lint/mutation_ts.sh`, объявлена в `adapted.json`).
 *
 * `--mutate` из командной строки Stryker ЗАМЕНЯЕТ маску `mutate` конфига. Без фильтра гейт
 * по изменённым файлам отдал бы в мутацию `src/core/env.ts`, исключённый как защитный, а
 * мутант этого модуля 2026-09-02 записал фикстуры тестов в настоящий `~/.gconnect`. Свойство
 * держит сьют, а не память: правка гейта, потерявшая маску, краснеет здесь.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/** Функция гейта в его же окружении: палитра пустая, `not_judged` — метка вместо выхода. */
const gate = (call: string, changed: string[], shard = ''): string =>
  execFileSync(
    'bash',
    [
      '-c',
      [
        'yellow= green= red= reset= STRICT=1 BASE=HEAD MIN_KILLED=60 BUDGET_SEC=5',
        'not_judged() { echo NOT_JUDGED; exit 1; }',
        '. scripts/lint/mutation_ts.sh',
        `cfg=stryker.config.json; changed="${changed.join('\n')}"; MUTATION_SHARD=${shard}`,
        `${call} >/dev/null; echo "rc=$? [$changed]"`,
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  ).trim();

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

  it('пустая доля — «нечего», кривая доля — «не судит»', () => {
    expect(gate('ts_shard', ['a.ts'], '2/2')).toBe('rc=1 []');
    expect(gate('ts_shard', ['a.ts'], '3/2')).toBe('rc=2 [a.ts]');
    expect(gate('ts_shard', ['a.ts'], 'x')).toBe('rc=2 [a.ts]');
  });
});
