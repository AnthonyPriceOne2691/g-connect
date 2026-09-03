/** Примеры B1, B2, B5, B6, B7, B8 спеки фазы 2: набор инструментов и граница ошибок. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { noopJournal } from '../src/core/journal.js';
import { profileDir } from '../src/core/profiles.js';
import type { Registry } from '../src/core/targets.js';
import {
  EXPECTED_TOOL_COUNT,
  TOOLS,
  gcApply,
  gcRead,
  gcTargets,
  gcUndo,
  runTool,
  serverInstructions,
  type ToolDeps,
} from '../src/mcp/tools.js';
import {
  FakeSheetsClient,
  MutableSheetsClient,
  formulaSheet,
  instructionSheet,
  reportSheet,
  snapshot,
} from './fixtures/sheet.js';

const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

const registry: Registry = {
  targets: [
    { alias: 'log', id: SHEET_ID, type: 'sheet', allow: 'write', sheet: 'Лист1', key: ['Проект'] },
    { alias: 'reference', id: 'DOCID000000000000000000', type: 'doc' },
    // Цель с подписанным конвертом (D-18): такие правки идут с первой фразы.
    {
      alias: 'combat',
      id: SHEET_ID,
      type: 'sheet',
      allow: 'write',
      sheet: 'Лист1',
      key: ['Проект'],
      auto: { ops: ['upsertRow', 'setCells', 'formatCells', 'appendRow'], maxCells: 2 },
    },
    // Конверт написан неверно: запись по такой цели идёт через план и код, а причина
    // называется вслух — угадывать половину подписи нельзя.
    {
      alias: 'broken',
      id: SHEET_ID,
      type: 'sheet',
      allow: 'write',
      sheet: 'Лист1',
      key: ['Проект'],
      auto: { ops: ['deleteRows'] },
    },
  ],
};

const original = process.env['GCONNECT_HOME'];

beforeEach(async () => {
  process.env['GCONNECT_HOME'] = await mkdtemp(join(tmpdir(), 'gconnect-mcp-'));
});

afterEach(() => {
  if (original === undefined) delete process.env['GCONNECT_HOME'];
  else process.env['GCONNECT_HOME'] = original;
});

interface Harness {
  readonly deps: ToolDeps;
  readonly client: FakeSheetsClient;
  readonly journalled: WriteRecord[];
}

const harness = (over: Partial<ToolDeps> = {}): Harness => {
  const client = new FakeSheetsClient(snapshot());
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    drive: () =>
      Promise.resolve({ search: () => Promise.resolve({ files: [], incompleteBecause: [] }) }),
    registry: () => Promise.resolve(registry),
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('rev-1'),
    ...over,
  };
  return { deps, client, journalled };
};

/** Превью → код плана → запись через инструмент: подпись человека имитируется (D-16). */
const applyConfirmed = async (
  args: Record<string, unknown>,
  deps: ToolDeps,
): ReturnType<typeof runTool> => {
  const preview = await runTool(gcApply, { ...args, dryRun: true }, deps);
  const { planId } = preview.data as { planId: string | null };
  return runTool(
    gcApply,
    { ...args, dryRun: false, ...(planId === null ? {} : { confirm: planId }) },
    deps,
  );
};

describe('B1 — набор инструментов', () => {
  it('ровно шесть, и это требование §3, а не совпадение', () => {
    expect(TOOLS).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(TOOLS.map((t) => t.name)).toEqual([
      'gc_targets',
      'gc_read',
      'gc_search',
      'gc_scan',
      'gc_apply',
      'gc_undo',
    ]);
  });

  it('у каждого есть внятное описание и схема входа', () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).toMatch(/^gc_[a-z]+$/);
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      // Описание — то, по чему агент выбирает инструмент: короткое бесполезно.
      expect(tool.description.length, tool.name).toBeGreaterThan(60);
      expect(typeof tool.input, tool.name).toBe('object');
    }
  });

  it('описание gc_apply предупреждает про план вместо записи и про вопрос вместо догадки', () => {
    // Ищем смысл, а не конкретное слово: агенту важно, что по умолчанию возвращается
    // план со `status=preview`, а не что мы назвали это «превью».
    expect(gcApply.description).toMatch(/ПЛАН|preview/);
    expect(gcApply.description).toContain('dryRun=false');
    expect(gcApply.description.toLowerCase()).toContain('не угадывай');
    expect(gcRead.description).toContain('ПРЕДУПРЕЖДЕНИЯ');
  });
});

describe('B2 — gc_targets отдаёт права, но не секреты', () => {
  it('цели с правами и пометка про allowlist', async () => {
    const { deps } = harness();
    const result = await runTool(gcTargets, {}, deps);
    expect(result.ok).toBe(true);
    const data = result.data as {
      targets: { alias: string; allow: string; auto: unknown }[];
      note: string;
    };
    expect(data.targets).toHaveLength(4);
    expect(data.targets.find((t) => t.alias === 'log')?.allow).toBe('write');
    expect(data.targets.find((t) => t.alias === 'reference')?.allow).toBe('read');
    expect(data.note).toContain('write.allowlist');
    // Конверт виден рядом с правами: у цели без него — null, у битого — причина строкой.
    expect(data.targets.find((t) => t.alias === 'log')?.auto).toBeNull();
    expect(data.targets.find((t) => t.alias === 'combat')?.auto).toMatchObject({ maxCells: 2 });
    expect(String(data.targets.find((t) => t.alias === 'broken')?.auto)).toContain('deleteRows');
  });

  it('в ответе нет ни токенов, ни путей к профилю', async () => {
    const { deps } = harness();
    const json = JSON.stringify((await runTool(gcTargets, {}, deps)).data);
    expect(json).not.toContain('access_token');
    expect(json).not.toContain('refresh_token');
    expect(json).not.toContain('.gconnect');
  });
});

describe('B4, B5 — превью по умолчанию и вопрос вместо догадки', () => {
  it('gc_apply без dryRun возвращает preview и ничего не пишет', async () => {
    const { deps, client, journalled } = harness();
    const result = await runTool(
      gcApply,
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 5 } },
      deps,
    );
    const data = result.data as { status: string; hint?: string };
    expect(data.status).toBe('preview');
    expect(data.hint).toContain('Покажи человеку');
    // Подсказка обязана требовать код плана: без этого агент «подтвердит» сам за человека.
    expect(data.hint).toContain('confirm');
    expect(client.writes).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });

  it('неизвестная колонка → needs_clarification со списком и подсказкой спросить', async () => {
    const { deps } = harness();
    const result = await runTool(
      gcApply,
      { op: 'setCells', target: 'log', where: { Проект: 'G connect' }, values: { Бюджет: 100 } },
      deps,
    );
    const data = result.data as {
      status: string;
      questions: { available: string[] }[];
      hint?: string;
    };
    expect(data.status).toBe('needs_clarification');
    expect(data.questions[0]?.available).toContain('Часы');
    expect(data.hint).toContain('Не угадывай');
  });

  it('с dryRun=false пишет и журналирует', async () => {
    const { deps, client, journalled } = harness();
    const result = await applyConfirmed(
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 5 } },
      deps,
    );
    expect((result.data as { status: string }).status).toBe('ok');
    expect(client.writes).toHaveLength(1);
    expect(journalled).toHaveLength(1);
    expect(journalled[0]).toMatchObject({ op: 'upsertRow', revisionAfter: 'rev-1' });
  });
});

describe('B6, B7 — граница ошибок', () => {
  it('неизвестная операция → ok:false с кодом и списком допустимых, без стектрейса', async () => {
    const { deps } = harness();
    const result = await runTool(gcApply, { op: 'удалиВсё', target: 'log', values: {} }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('bad_request');
    expect(result.error?.detail).toContain('upsertRow');
    expect(JSON.stringify(result.error)).not.toContain('at Object');
  });

  it('запись в цель вне реестра → policy_denied с id правила', async () => {
    const { deps, client } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: `https://docs.google.com/spreadsheets/d/UNLISTED0000000000000/edit`,
        key: { Проект: 'G connect' },
        values: { Часы: 1 },
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_denied');
    expect(result.error?.cause).toBe('write.allowlist');
    expect(client.writes).toHaveLength(0);
  });

  it('право проверяется ДО обращения к Google, а не после (нашла живая проба)', async () => {
    // Клиент, который падает при любом вызове: если право проверяется вторым,
    // тест увидит ошибку сети вместо policy_denied — как это и было.
    const { deps } = harness({
      sheets: () => Promise.reject(new Error('в Google лезть не должны были')),
    });
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'https://docs.google.com/spreadsheets/d/UNLISTED0000000000000/edit',
        key: { Проект: 'x' },
        values: { Часы: 1 },
        dryRun: false,
      },
      deps,
    );
    expect(result.error?.code).toBe('policy_denied');
    expect(result.error?.cause).toBe('write.allowlist');
  });

  it('read-only цель не пишется даже при dryRun=false', async () => {
    const { deps } = harness();
    const result = await runTool(
      gcApply,
      { op: 'appendRow', target: 'reference', values: { Часы: 1 }, dryRun: false },
      deps,
    );
    expect(result.error?.cause).toBe('write.allowlist');
  });

  it('неожиданное падение инструмента тоже приходит как payload, а не как исключение', async () => {
    const { deps } = harness({
      sheets: () => Promise.reject(new Error('сеть отвалилась внезапно')),
    });
    const result = await runTool(gcRead, { target: 'log', mode: 'map' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('internal');
    expect(result.error?.cause).toContain('сеть отвалилась');
    expect(result.error?.title.length).toBeGreaterThan(0);
  });

  it('у каждой ошибки границы есть correlationId — иначе её не найти в аудите', async () => {
    const { deps } = harness();
    const result = await runTool(gcApply, { op: 'нет такой', target: 'log', values: {} }, deps);
    expect(result.error?.correlationId).toMatch(/^gc-/);
  });
});

describe('B8 — правила уходят клиенту', () => {
  it('instructions содержат политику и число машинных правил', () => {
    const text = serverInstructions();
    expect(text).toContain('Правила работы с документами');
    expect(text).toContain('policy://rules');
    expect(text).toMatch(/\d+ шт\./);
  });
});

describe('gc_read — карта как первый шаг', () => {
  it('mode=map отдаёт карту с предупреждениями, а не строки', async () => {
    const { deps } = harness();
    const data = (await runTool(gcRead, { target: 'log', mode: 'map' }, deps)).data as {
      headerRow: number;
      columns: { name: string }[];
      warnings: string[];
    };
    expect(data.headerRow).toBe(2);
    expect(data.columns.map((c) => c.name)).toContain('Статус');
    expect(data.warnings.join(' ')).toContain('над шапкой');
  });

  it('mode=values помечает усечение, а не молча обрезает', async () => {
    const { deps } = harness();
    const data = (await runTool(gcRead, { target: 'log', mode: 'values', limit: 1 }, deps))
      .data as {
      rows: unknown[];
      truncated: boolean;
    };
    expect(data.rows).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });
});

describe('gc_undo через инструмент', () => {
  it('откат после записи возвращает значения и сообщает, что откатил', async () => {
    // Изменяемый клиент обязателен: сверка отката смотрит на ЖИВЫЕ значения ячеек,
    // а фейк записи не применяет — с ним любая проверка выглядела бы как чужая правка.
    const applied = new MutableSheetsClient(snapshot());
    const { deps, journalled } = harness({ sheets: () => Promise.resolve(applied) });
    await applyConfirmed(
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 9 } },
      deps,
    );
    const result = await runTool(gcUndo, { target: 'log' }, deps);
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; restored: { value: unknown }[] };
    expect(data.status).toBe('ok');
    expect(data.restored[0]?.value).toBe(2);
    expect(journalled.some((r) => r.op === 'undo')).toBe(true);
  });

  it('R6 — строка отката несёт ревизию ПОСЛЕ обратной записи, а не литерал null', async () => {
    const applied = new MutableSheetsClient(snapshot());
    const { deps, journalled } = harness({ sheets: () => Promise.resolve(applied) });
    await applyConfirmed(
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 9 } },
      deps,
    );
    await runTool(gcUndo, { target: 'log' }, deps);
    const undone = journalled.find((r) => r.op === 'undo');
    // Тип WriteRecord и rules.md обещают человеку обе ревизии; до 2026-09-03 у строки
    // отката вторая была захардкожена null, и обещание было ложным.
    expect(undone?.revisionBefore).toBe('rev-1');
    expect(undone?.revisionAfter).toBe('rev-1');
  });

  it('нечего откатывать → говорит прямо', async () => {
    const { deps } = harness({ journalSource: { recent: () => Promise.resolve([]) } });
    const data = (await runTool(gcUndo, { target: 'log' }, deps)).data as {
      status: string;
      reason?: string;
      hint?: string;
    };
    expect(data.status).toBe('nothing_to_undo');
    expect(data.hint?.toLowerCase()).toContain('откатывать нечего');
    // Причина обязательна: без неё модель её выдумывает (живой прогон B13).
    expect(data.reason).toBe('journal_empty');
  });

  it('откат по read-only цели запрещён', async () => {
    const { deps } = harness();
    const result = await runTool(gcUndo, { target: 'reference' }, deps);
    expect(result.error?.cause).toBe('write.allowlist');
  });
});

describe('noopJournal не мешает', () => {
  it('запись с noopJournal проходит и ничего не журналирует', async () => {
    const { deps, client } = harness({ journal: noopJournal });
    const result = await applyConfirmed(
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 3 } },
      deps,
    );
    expect((result.data as { status: string }).status).toBe('ok');
    expect(client.writes).toHaveLength(1);
  });
});

/** Оракулы на дефекты живого прогона B13 в Cursor (2026-09-02). */
describe('V10 — битое выражение на границе', () => {
  it('отклоняется ДО обращения к Google, и ни одной замены не сделано', async () => {
    const { deps, client } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'findReplace',
        target: 'log',
        find: '[',
        replace: 'x',
        searchByRegex: true,
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.error)).toContain('bad_regex');
    expect(client.writes).toHaveLength(0);
  });

  it('то же выражение без searchByRegex — обычная строка, отказа нет', async () => {
    const { deps } = harness();
    const result = await runTool(
      gcApply,
      { op: 'findReplace', target: 'log', find: '[', replace: 'x' },
      deps,
    );
    expect(result.ok).toBe(true);
  });
});

describe('V11 — вид на границе инструмента', () => {
  it('неизвестное поле вида отклонено ДО обращения к Google, с перечислением допустимых', async () => {
    const { deps, client } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'formatCells',
        target: 'log',
        where: { Проект: 'G connect' },
        columns: ['Часы'],
        format: { fontSize: 14 },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result.error);
    // Агент должен узнать, что вообще можно: без списка он будет угадывать.
    for (const field of ['bold', 'italic', 'underline', 'align', 'background']) {
      expect(text, field).toContain(field);
    }
    expect(client.formatWrites).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('formatCells проходит через тот же контур подтверждения, что запись', async () => {
    const { deps, client } = harness();
    const preview = await runTool(
      gcApply,
      {
        op: 'formatCells',
        target: 'log',
        where: { Проект: 'G connect' },
        columns: ['Часы'],
        format: { bold: true },
      },
      deps,
    );
    const { planId, status } = preview.data as { planId: string | null; status: string };
    expect(status).toBe('preview');
    expect(planId).toMatch(/^[0-9a-f]{6}$/);

    const written = await runTool(
      gcApply,
      {
        op: 'formatCells',
        target: 'log',
        where: { Проект: 'G connect' },
        columns: ['Часы'],
        format: { bold: true },
        dryRun: false,
        confirm: planId,
      },
      deps,
    );
    expect((written.data as { status: string }).status).toBe('ok');
    expect(client.formatWrites).toHaveLength(1);
    expect(client.writes).toHaveLength(0);
  });
});

describe('живой прогон B13 — что он нашёл', () => {
  it('gc_targets не отдаёт expiresAt: агент читал его как «срок входа истёк»', async () => {
    // Профиль нужен настоящий, иначе accounts пуст и оракул проходит вхолостую.
    await mkdir(profileDir('default'), { recursive: true });
    await writeFile(
      join(profileDir('default'), 'credentials.json'),
      JSON.stringify({ web: { client_id: 'id', client_secret: 's', redirect_uris: ['http://x'] } }),
    );
    const { deps } = harness();
    const data = (await runTool(gcTargets, {}, deps)).data as {
      accounts: { account: string; state: string }[];
    };
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]?.state).toBeTypeOf('string');
    expect(JSON.stringify(data)).not.toContain('expiresAt');
  });

  it('gc_apply на «значение уже такое» не выглядит выполненной записью', async () => {
    const { deps, client, journalled } = harness();
    const result = await runTool(
      gcApply,
      {
        target: 'log',
        op: 'upsertRow',
        key: { Проект: 'G connect' },
        values: { Статус: 'в работе' },
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; hint?: string };
    expect(data.status).toBe('no_change');
    expect(data.hint).toContain('не выдавай');
    expect(client.writes).toHaveLength(0);
    expect(journalled).toHaveLength(0);
  });

  it('лист и шапка берутся из реестра, когда вызов их не задал', async () => {
    // Книга как у владельца: первым листом идёт «Инструкция», рабочий лист — второй.
    const book = () =>
      Promise.resolve(new FakeSheetsClient(snapshot([instructionSheet(), reportSheet()])));
    const withSheet: Registry = {
      targets: [
        { alias: 'log', id: SHEET_ID, type: 'sheet', allow: 'write', sheet: 'Лист1', headerRow: 2 },
      ],
    };

    const fromRegistry = (
      await runTool(
        gcRead,
        { target: 'log' },
        harness({ sheets: book, registry: () => Promise.resolve(withSheet) }).deps,
      )
    ).data as { sheet: string; headerRow: number };
    expect(fromRegistry.sheet).toBe('Лист1');
    expect(fromRegistry.headerRow).toBe(2);

    // Явный аргумент вызова старше реестра.
    const explicit = (
      await runTool(
        gcRead,
        { target: 'log', sheet: 'Инструкция' },
        harness({ sheets: book, registry: () => Promise.resolve(withSheet) }).deps,
      )
    ).data as { sheet: string };
    expect(explicit.sheet).toBe('Инструкция');

    // Без листа в реестре остаётся прежнее поведение — первый лист книги.
    const noDefault: Registry = { targets: [{ alias: 'log', id: SHEET_ID, type: 'sheet' }] };
    const first = (
      await runTool(
        gcRead,
        { target: 'log' },
        harness({ sheets: book, registry: () => Promise.resolve(noDefault) }).deps,
      )
    ).data as { sheet: string };
    expect(first.sheet).toBe('Инструкция');
  });

  it('gc_apply тоже уважает лист из реестра: план не уходит на чужой лист', async () => {
    const withSheet: Registry = {
      targets: [
        {
          alias: 'log',
          id: SHEET_ID,
          type: 'sheet',
          allow: 'write',
          sheet: 'Лист1',
          headerRow: 2,
          key: ['Проект'],
        },
      ],
    };
    const { deps } = harness({
      sheets: () =>
        Promise.resolve(new FakeSheetsClient(snapshot([instructionSheet(), reportSheet()]))),
      registry: () => Promise.resolve(withSheet),
    });
    const result = await runTool(
      gcApply,
      { target: 'log', op: 'upsertRow', key: { Проект: 'G connect' }, values: { Часы: 4 } },
      deps,
    );
    const data = result.data as {
      status: string;
      changes: { a1: string }[];
      target: { sheet?: string };
    };
    expect(data.status).toBe('preview');
    expect(data.changes[0]?.a1).toContain('Лист1!');
  });

  it('gc_read values не отдаёт строки за границей данных', async () => {
    // Лист как настоящий: под двумя строками данных ещё сотня пустых строк сетки.
    const base = reportSheet();
    const padded = {
      ...base,
      rows: [...base.rows, ...Array.from({ length: 100 }, () => [{ value: null }])],
    };
    const { deps } = harness({
      sheets: () => Promise.resolve(new FakeSheetsClient(snapshot([padded]))),
    });
    const data = (await runTool(gcRead, { target: 'log', mode: 'values' }, deps)).data as {
      rows: Record<string, unknown>[];
      truncated: boolean;
    };
    expect(data.rows).toHaveLength(2);
    expect(data.truncated).toBe(false);
  });

  it('gc_undo не утверждает «журнал пуст», а называет причину из ядра', async () => {
    const { deps } = harness();
    const result = await runTool(gcUndo, { target: 'log' }, deps);
    const data = result.data as { status: string; reason?: string; hint?: string };
    expect(data.status).toBe('nothing_to_undo');
    expect(data.reason).toBe('journal_empty');
    expect(data.hint).toContain('журнала нет');
  });
});

describe('K1, K3, K9 — боевая запись по конверту (D-18)', () => {
  it('K1: правка внутри конверта пишется с первой фразы, без кода плана', async () => {
    const applied = new MutableSheetsClient(snapshot());
    const { deps, journalled } = harness({ sheets: () => Promise.resolve(applied) });
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'combat',
        key: { Проект: 'G connect' },
        values: { Часы: 9 },
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; correlationId?: string; hint?: string };
    expect(data.status).toBe('ok');
    // Обещание «откатить одной фразой» исполняет механизм: id записи в ответе (урок L6).
    expect(data.correlationId).toBeDefined();
    expect(data.hint).toContain('gc_undo');
    expect(journalled).toHaveLength(1);
    expect(journalled[0]?.correlationId).toBe(data.correlationId);
  });

  it('K9: откат после боевой записи возвращает ровно её', async () => {
    const applied = new MutableSheetsClient(snapshot());
    const { deps, journalled } = harness({ sheets: () => Promise.resolve(applied) });
    await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'combat',
        key: { Проект: 'G connect' },
        values: { Часы: 9 },
        dryRun: false,
      },
      deps,
    );
    const undone = (await runTool(gcUndo, { target: 'combat' }, deps)).data as {
      status: string;
      restored: { value: unknown }[];
    };
    expect(undone.status).toBe('ok');
    expect(undone.restored[0]?.value).toBe(2);
    expect(journalled.map((r) => r.op)).toEqual(['upsertRow', 'undo']);
  });

  it('K3: за границей конверта записи нет — статус, план и код в том же ответе', async () => {
    const { deps, client, journalled } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'setCells',
        target: 'combat',
        where: {},
        values: { Часы: 1 },
        dryRun: false,
      },
      deps,
    );
    const data = result.data as { status: string; planId: string | null; notes: string[] };
    // В конверте maxCells: 2, а правка по пустому условию берёт обе строки листа —
    // границу проверяем на настоящем плане, а не на подставленном числе.
    if (data.status === 'confirm_required') {
      expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
      expect(data.notes.join(' ')).toContain('конверт');
    } else {
      expect(data.status).toBe('ok');
    }
    expect(journalled.some((r) => r.op === 'setCells' && r.changes.length > 2)).toBe(false);
    expect(client.writes.length).toBeLessThanOrEqual(2);
  });

  it('битый конверт: запись отказывает с названной причиной, а не пишет наугад', async () => {
    const { deps, client } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'broken',
        key: { Проект: 'G connect' },
        values: { Часы: 9 },
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBe('write.envelope-invalid');
    expect(client.writes).toHaveLength(0);
  });

  it('цель без конверта ведёт себя как прежде: без кода записи нет', async () => {
    const { deps, client } = harness();
    const result = await runTool(
      gcApply,
      {
        op: 'upsertRow',
        target: 'log',
        key: { Проект: 'G connect' },
        values: { Часы: 9 },
        dryRun: false,
      },
      deps,
    );
    const data = result.data as { status: string; planId: string | null };
    expect(data.status).toBe('confirm_required');
    expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(client.writes).toHaveLength(0);
  });
});

describe('K4, K5, K6, K7 — что конверт НЕ разрешает решать за человека (D-18)', () => {
  const combat = { op: 'upsertRow', target: 'combat', key: { Проект: 'G connect' }, dryRun: false };

  it('K4: неизвестная колонка внутри конверта — вопрос, а не догадка', async () => {
    const { deps, client } = harness();
    const data = (await runTool(gcApply, { ...combat, values: { Бюджет: 5 } }, deps)).data as {
      status: string;
      questions: { available: string[] }[];
    };
    expect(data.status).toBe('needs_clarification');
    expect(data.questions[0]?.available).toContain('Часы');
    expect(client.writes).toHaveLength(0);
  });

  it('K5: значение вне списка допустимых — вопрос со списком', async () => {
    const { deps, client } = harness();
    const data = (await runTool(gcApply, { ...combat, values: { Статус: 'почти готово' } }, deps))
      .data as { status: string; questions: { reason: string; available: string[] }[] };
    expect(data.status).toBe('needs_clarification');
    expect(data.questions[0]?.reason).toBe('not_in_enum');
    expect(client.writes).toHaveLength(0);
  });

  it('K6: формульная колонка внутри конверта требует force, а не конверта', async () => {
    const applied = new FakeSheetsClient(snapshot([formulaSheet()]));
    const { deps } = harness({ sheets: () => Promise.resolve(applied) });
    const result = await runTool(
      gcApply,
      { ...combat, sheet: 'Итоги', key: { Проект: 'G connect' }, values: { Итого: 1 } },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBe('formula_column');
    expect(applied.writes).toHaveLength(0);
  });

  it('K7: та же фраза дважды не даёт второй строки', async () => {
    const applied = new MutableSheetsClient(snapshot());
    const { deps, journalled } = harness({ sheets: () => Promise.resolve(applied) });
    const row = {
      op: 'appendRow',
      target: 'combat',
      values: { Проект: 'Новый', Часы: 1 },
      dryRun: false,
    };
    const first = (await runTool(gcApply, row, deps)).data as { status: string };
    expect(first.status).toBe('ok');
    const second = (await runTool(gcApply, row, deps)).data as { status: string; notes: string[] };
    expect(second.status).toBe('no_change');
    expect(second.notes.join(' ')).toContain('уже дописана');
    expect(journalled.filter((r) => r.op === 'appendRow')).toHaveLength(1);
  });
});
