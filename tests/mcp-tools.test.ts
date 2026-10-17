/** Примеры B1, B2, B5, B6, B7, B8 спеки фазы 2: набор инструментов и граница ошибок. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { noopJournal } from '../src/core/journal.js';
import { OPERATION_NAMES } from '../src/core/ops.js';
import { profileDir } from '../src/core/profiles.js';
import { applyInput } from '../src/mcp/apply-schema.js';
import type { Registry } from '../src/core/targets.js';
import {
  EXPECTED_TOOL_COUNT,
  TOOLS,
  gcApply,
  gcRead,
  gcTargets,
  gcUndo,
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
import { callMcp } from './fixtures/protocol.js';

const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const FOLDER_ID = '1FOLDERaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
    // Папка с правом записи: в неё можно создавать файлы (§6.2, Ctrl+N).
    { alias: 'folder', id: FOLDER_ID, type: 'folder', allow: 'write' },
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
  readonly drive: FakeDriveClient;
}

/** Фейк Drive: помнит созданное и отправленное в корзину — этим и проверяем откат. */
class FakeDriveClient {
  readonly created: { id: string; name: string; kind: string; parentId?: string }[] = [];
  readonly trashed: string[] = [];

  search(): Promise<{ files: never[]; incompleteBecause: never[] }> {
    return Promise.resolve({ files: [], incompleteBecause: [] });
  }

  create(
    kind: 'sheet' | 'doc' | 'folder',
    name: string,
    parentId?: string,
  ): Promise<{ id: string; name: string; url: string }> {
    const id = `FILE${this.created.length + 1}`;
    this.created.push({ id, name, kind, ...(parentId === undefined ? {} : { parentId }) });
    return Promise.resolve({ id, name, url: `https://drive.google.com/open?id=${id}` });
  }

  trash(fileId: string): Promise<void> {
    this.trashed.push(fileId);
    return Promise.resolve();
  }
}

const harness = (over: Partial<ToolDeps> = {}): Harness => {
  const client = new FakeSheetsClient(snapshot());
  const drive = new FakeDriveClient();
  const journalled: WriteRecord[] = [];
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.resolve(client),
    docs: () => Promise.reject(new Error('в этом сьюте doc-целей нет — см. mcp-doc-read.test.ts')),
    drive: () => Promise.resolve(drive),
    registry: () => Promise.resolve(registry),
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('rev-1'),
    ...over,
  };
  return { deps, client, journalled, drive };
};

/** Превью → код плана → запись через инструмент: подпись человека имитируется (D-16). */
const applyConfirmed = async (
  args: Record<string, unknown>,
  deps: ToolDeps,
): ReturnType<typeof callMcp> => {
  const preview = await callMcp(gcApply, { ...args, dryRun: true }, deps);
  const { planId } = preview.data as { planId: string | null };
  return callMcp(
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
    const result = await callMcp(gcTargets, {}, deps);
    expect(result.ok).toBe(true);
    const data = result.data as {
      targets: { alias: string; allow: string; auto: unknown }[];
      note: string;
    };
    expect(data.targets).toHaveLength(5);
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
    const json = JSON.stringify((await callMcp(gcTargets, {}, deps)).data);
    expect(json).not.toContain('access_token');
    expect(json).not.toContain('refresh_token');
    expect(json).not.toContain('.gconnect');
  });
});

describe('B4, B5 — превью по умолчанию и вопрос вместо догадки', () => {
  it('gc_apply без dryRun возвращает preview и ничего не пишет', async () => {
    const { deps, client, journalled } = harness();
    const result = await callMcp(
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
    const result = await callMcp(
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
    const result = await callMcp(gcApply, { op: 'удалиВсё', target: 'log', values: {} }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('bad_request');
    expect(result.error?.detail).toContain('upsertRow');
    expect(JSON.stringify(result.error)).not.toContain('at Object');
  });

  it('запись в цель вне реестра → policy_denied с id правила', async () => {
    const { deps, client } = harness();
    const result = await callMcp(
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
    const result = await callMcp(
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
    const result = await callMcp(
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
    const result = await callMcp(gcRead, { target: 'log', mode: 'map' }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('internal');
    expect(result.error?.cause).toContain('сеть отвалилась');
    expect(result.error?.title.length).toBeGreaterThan(0);
  });

  it('у каждой ошибки границы есть correlationId — иначе её не найти в аудите', async () => {
    const { deps } = harness();
    const result = await callMcp(gcApply, { op: 'нет такой', target: 'log', values: {} }, deps);
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
    const data = (await callMcp(gcRead, { target: 'log', mode: 'map' }, deps)).data as {
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
    const data = (await callMcp(gcRead, { target: 'log', mode: 'values', limit: 1 }, deps))
      .data as {
      rows: { kind: string; origin: string; value: unknown[] };
      truncated: boolean;
    };
    expect(data.rows.kind).toBe('data');
    expect(data.rows.origin).toContain('лист');
    expect(data.rows.value).toHaveLength(1);
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
    const result = await callMcp(gcUndo, { target: 'log' }, deps);
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
    await callMcp(gcUndo, { target: 'log' }, deps);
    const undone = journalled.find((r) => r.op === 'undo');
    // Тип WriteRecord и rules.md обещают человеку обе ревизии; до 2026-09-03 у строки
    // отката вторая была захардкожена null, и обещание было ложным.
    expect(undone?.revisionBefore).toBe('rev-1');
    expect(undone?.revisionAfter).toBe('rev-1');
  });

  it('нечего откатывать → говорит прямо', async () => {
    const { deps } = harness({ journalSource: { recent: () => Promise.resolve([]) } });
    const data = (await callMcp(gcUndo, { target: 'log' }, deps)).data as {
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
    const result = await callMcp(gcUndo, { target: 'reference' }, deps);
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
    const result = await callMcp(
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
    const result = await callMcp(
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
    const result = await callMcp(
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
    const preview = await callMcp(
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

    const written = await callMcp(
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
    const data = (await callMcp(gcTargets, {}, deps)).data as {
      accounts: { account: string; state: string }[];
    };
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]?.state).toBeTypeOf('string');
    expect(JSON.stringify(data)).not.toContain('expiresAt');
  });

  it('gc_apply на «значение уже такое» не выглядит выполненной записью', async () => {
    const { deps, client, journalled } = harness();
    const result = await callMcp(
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
      await callMcp(
        gcRead,
        { target: 'log' },
        harness({ sheets: book, registry: () => Promise.resolve(withSheet) }).deps,
      )
    ).data as { sheet: string; headerRow: number };
    expect(fromRegistry.sheet).toBe('Лист1');
    expect(fromRegistry.headerRow).toBe(2);

    // Явный аргумент вызова старше реестра.
    const explicit = (
      await callMcp(
        gcRead,
        { target: 'log', sheet: 'Инструкция' },
        harness({ sheets: book, registry: () => Promise.resolve(withSheet) }).deps,
      )
    ).data as { sheet: string };
    expect(explicit.sheet).toBe('Инструкция');

    // Без листа в реестре остаётся прежнее поведение — первый лист книги.
    const noDefault: Registry = { targets: [{ alias: 'log', id: SHEET_ID, type: 'sheet' }] };
    const first = (
      await callMcp(
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
    const result = await callMcp(
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
    const data = (await callMcp(gcRead, { target: 'log', mode: 'values' }, deps)).data as {
      rows: { value: Record<string, unknown>[] };
      truncated: boolean;
    };
    expect(data.rows.value).toHaveLength(2);
    expect(data.truncated).toBe(false);
  });

  it('gc_undo не утверждает «журнал пуст», а называет причину из ядра', async () => {
    const { deps } = harness();
    const result = await callMcp(gcUndo, { target: 'log' }, deps);
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
    const result = await callMcp(
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
    await callMcp(
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
    const undone = (await callMcp(gcUndo, { target: 'combat' }, deps)).data as {
      status: string;
      restored: { value: unknown }[];
    };
    expect(undone.status).toBe('ok');
    expect(undone.restored[0]?.value).toBe(2);
    expect(journalled.map((r) => r.op)).toEqual(['upsertRow', 'undo']);
  });

  it('K3: за границей конверта записи нет — статус, план и код в том же ответе', async () => {
    const { deps, client, journalled } = harness();
    const result = await callMcp(
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
    const result = await callMcp(
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
    const result = await callMcp(
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
    const data = (await callMcp(gcApply, { ...combat, values: { Бюджет: 5 } }, deps)).data as {
      status: string;
      questions: { available: string[] }[];
    };
    expect(data.status).toBe('needs_clarification');
    expect(data.questions[0]?.available).toContain('Часы');
    expect(client.writes).toHaveLength(0);
  });

  it('K5: значение вне списка допустимых — вопрос со списком', async () => {
    const { deps, client } = harness();
    const data = (await callMcp(gcApply, { ...combat, values: { Статус: 'почти готово' } }, deps))
      .data as { status: string; questions: { reason: string; available: string[] }[] };
    expect(data.status).toBe('needs_clarification');
    expect(data.questions[0]?.reason).toBe('not_in_enum');
    expect(client.writes).toHaveLength(0);
  });

  it('K6: формульная колонка внутри конверта требует force, а не конверта', async () => {
    const applied = new FakeSheetsClient(snapshot([formulaSheet()]));
    const { deps } = harness({ sheets: () => Promise.resolve(applied) });
    const result = await callMcp(
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
    const first = (await callMcp(gcApply, row, deps)).data as { status: string };
    expect(first.status).toBe('ok');
    const second = (await callMcp(gcApply, row, deps)).data as { status: string; notes: string[] };
    expect(second.status).toBe('no_change');
    expect(second.notes.join(' ')).toContain('уже дописана');
    expect(journalled.filter((r) => r.op === 'appendRow')).toHaveLength(1);
  });
});

describe('G15, G16 — создание файлов Drive (D-19, слайс 8)', () => {
  it('G15: таблица создаётся в папке реестра, ссылка и id в ответе', async () => {
    const { deps, drive, journalled } = harness();
    const preview = (
      await callMcp(gcApply, { op: 'createSheet', target: 'folder', name: 'Октябрь 2026' }, deps)
    ).data as { status: string; planId: string | null };
    expect(preview.status).toBe('preview');
    expect(drive.created).toHaveLength(0);

    const result = await callMcp(
      gcApply,
      {
        op: 'createSheet',
        target: 'folder',
        name: 'Октябрь 2026',
        dryRun: false,
        confirm: preview.planId ?? '',
      },
      deps,
    );
    const data = result.data as { status: string; notes: string[] };
    expect(data.status).toBe('ok');
    expect(drive.created[0]).toMatchObject({
      name: 'Октябрь 2026',
      kind: 'sheet',
      parentId: FOLDER_ID,
    });
    expect(data.notes.join(' ')).toContain('drive.google.com');
    // Право записи созданный файл НЕ получает, и ответ говорит это сразу.
    expect(data.notes.join(' ')).toContain('Права записи у нового файла нет');
    expect(journalled[0]?.structure).toMatchObject({ kind: 'createFile' });
    expect(journalled[0]?.structure?.fileId).toBe('FILE1');
  });

  it('G15: откат отправляет файл в корзину и говорит, что достать — руками', async () => {
    const { deps, drive, journalled } = harness();
    const preview = (
      await callMcp(gcApply, { op: 'createFolder', target: 'folder', name: 'Архив' }, deps)
    ).data as { planId: string | null };
    await callMcp(
      gcApply,
      {
        op: 'createFolder',
        target: 'folder',
        name: 'Архив',
        dryRun: false,
        confirm: preview.planId ?? '',
      },
      deps,
    );
    const undone = (await callMcp(gcUndo, { target: 'folder' }, deps)).data as {
      status: string;
      structureUndone?: string;
    };
    expect(undone.status).toBe('ok');
    expect(drive.trashed).toEqual(['FILE1']);
    expect(undone.structureUndone).toContain('корзину');
    expect(undone.structureUndone).toContain('руками');
    expect(journalled.some((r) => r.op === 'undo')).toBe(true);
  });

  it('G16: создать в таблице нельзя — отказ со списком того, что делать', async () => {
    const { deps, drive } = harness();
    const result = await callMcp(
      gcApply,
      { op: 'createSheet', target: 'log', name: 'Октябрь', dryRun: false, confirm: 'x' },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBe('create_needs_folder');
    expect(drive.created).toHaveLength(0);
  });

  it('G16: в созданный файл писать нельзя — его нет в реестре', async () => {
    const { deps, client } = harness();
    const result = await callMcp(
      gcApply,
      {
        op: 'upsertRow',
        target: 'FILE1000000000000000000000',
        key: { Проект: 'X' },
        values: { Часы: 1 },
        dryRun: false,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBe('write.allowlist');
    expect(client.writes).toHaveLength(0);
  });
});

describe('связь схемы транспорта с ядром (находка живого прогона 2026-09-04)', () => {
  /**
   * Оракул на СВЯЗЬ, а не на список.
   *
   * Живой прогон нашёл, что схема `gc_apply` объявляла девять операций, пока ядро знало
   * двадцать одну: рукописный список отставал, схема отклоняла правки до ядра, а правила
   * уверяли агента, что операции есть. Ни один из существовавших оракулов этого не видел —
   * они звали ядро напрямую. Проверять надо связь двух сторон, а не каждую по отдельности
   * (урок L14, третье появление того же класса).
   */
  it('перечисление операций инструмента совпадает с тем, что знает ядро', () => {
    const schema = applyInput.op;
    const exposed = [...schema.options].sort();
    const known = [...OPERATION_NAMES].sort();
    expect(exposed).toEqual(known);
  });

  it('каждое имя операции ядра проходит схему транспорта', () => {
    // Проверяется САМА схема, а не вызов инструмента: `runTool` в тестах зовут напрямую,
    // и схему входа применяет только MCP-сервер — то есть отказ транспорта в тестах не
    // наблюдаем в принципе. Это второе лицо той же дыры: оракул, который «проверяет
    // операцию», мог быть зелёным, пока протокол её отклонял. Сквозная проверка — в
    // `probe_mcp.mjs`, там схема читается у собранного сервера.
    for (const op of OPERATION_NAMES) {
      expect(applyInput.op.safeParse(op).success, `операция ${op}`).toBe(true);
    }
  });
});

describe('тексты, которые читает МОДЕЛЬ (находка читателя без прогона)', () => {
  it('подсказка разрушающей правки просит название, а не код плана', async () => {
    // Этот текст — источник правды для модели: живой прогон нашёл, что он требовал код,
    // когда механизм ждал фразу. Правку сделали, а оракула на неё не было — то есть
    // следующая правка текста могла бы вернуть дефект молча.
    const { deps } = harness();
    const result = await callMcp(
      gcApply,
      { op: 'deleteRows', target: 'log', where: { Проект: 'G connect' } },
      deps,
    );
    const data = result.data as { hint?: string; structural?: { confirmPhrase?: string } };
    expect(data.hint).toContain('НАЗВАНИЕМ');
    expect(data.hint).toContain(data.structural?.confirmPhrase ?? '—');
    expect(data.hint).toContain('Одного «да» ядро не примет');
  });

  it('подсказка отката перечисляет, что вернулось, и что НЕ вернулось', async () => {
    const applied = new MutableSheetsClient(snapshot());
    const { deps } = harness({ sheets: () => Promise.resolve(applied) });
    await applyConfirmed(
      { op: 'upsertRow', target: 'log', key: { Проект: 'G connect' }, values: { Часы: 9 } },
      deps,
    );
    const undone = (await callMcp(gcUndo, { target: 'log' }, deps)).data as { hint?: string };
    expect(undone.hint).toContain('Вернулось');
    expect(undone.hint).toContain('значения');
    expect(undone.hint).toContain('а не «откачено»');
  });
});
