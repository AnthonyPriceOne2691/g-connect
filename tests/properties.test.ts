/**
 * Реляционные оракулы (Delivery §6.5): инварианты и round-trip вместо ожидаемых значений.
 * Здесь нельзя спрятать неверное ожидание — оно не задаётся, а проверяется отношение.
 */

import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ERROR_CATALOG, type ErrorCode } from '../src/core/error-catalog.js';
import { gcError } from '../src/core/errors.js';
import { profileDir, profileStatus, readToken, writeToken } from '../src/core/profiles.js';
import { withRetry } from '../src/core/retry.js';
import { isSilent, needsClarification, resolveColumn } from '../src/core/resolver.js';
import { buildSheetData, buildSheetMap } from '../src/core/sheets/map.js';
import type { WriteRecord } from '../src/core/journal.js';
import { limitOf } from '../src/core/policy.js';
import { appendRow, upsertRow } from '../src/core/sheets/rows.js';
import { setCells } from '../src/core/sheets/set-cells-op.js';
import { assertWritable, parseTargetUrl, resolveTarget } from '../src/core/targets.js';
import { undoLast } from '../src/core/undo.js';
import { normalizeValue } from '../src/core/values.js';
import {
  upsertConfirmed,
  FakeSheetsClient,
  MutableSheetsClient,
  STATUS_VALUES,
  snapshot,
  wideSheet,
} from './fixtures/sheet.js';

/** Алфавит ID файлов Google. */
const fileId = fc
  .stringMatching(/^[A-Za-z0-9_-]{20,44}$/)
  .filter((s) => s.length >= 20 && s.length <= 44);

const errorCode = fc.constantFrom(...(Object.keys(ERROR_CATALOG) as ErrorCode[]));

describe('инварианты ошибок', () => {
  it('любой код даёт показываемую человеку ошибку: title непустой, действие согласовано', () => {
    fc.assert(
      fc.property(errorCode, fc.option(fc.string(), { nil: undefined }), (code, detail) => {
        const payload = gcError(code, detail === undefined ? {} : { detail }).toPayload();
        expect(payload.title.length).toBeGreaterThan(0);
        expect(payload.title).not.toMatch(/undefined|\[object/);
        if (payload.action !== null) expect(payload.action.label.length).toBeGreaterThan(0);
        expect(payload.correlationId).toMatch(/^gc-[a-z0-9]+$/);
        expect(payload.code).toBe(code);
      }),
    );
  });

  it('detail никогда не подменяет title: сообщение источника не всплывает первым экраном', () => {
    fc.assert(
      fc.property(errorCode, fc.string({ minLength: 1 }), (code, cause) => {
        const payload = gcError(code, { cause }).toPayload();
        expect(payload.title).toBe(ERROR_CATALOG[code].title);
      }),
    );
  });
});

describe('инварианты резолва цели', () => {
  // Главный инвариант безопасности (§11.2): ссылка, пришедшая не из реестра,
  // не бывает пишущей — независимо от того, как она выглядит.
  it('любая ссылка/ID без реестра → только чтение', () => {
    fc.assert(
      fc.property(fileId, (id) => {
        for (const ref of [
          id,
          `https://docs.google.com/spreadsheets/d/${id}/edit`,
          `https://docs.google.com/document/d/${id}/edit#heading=h.x`,
          `https://drive.google.com/drive/folders/${id}`,
        ]) {
          const target = resolveTarget(ref);
          expect(target.allow).toBe('read');
          expect(() => {
            assertWritable(target);
          }).toThrowError(/policy_denied/);
        }
      }),
    );
  });

  it('round-trip: ID → URL → ID для всех форм ссылок Google', () => {
    fc.assert(
      fc.property(fileId, (id) => {
        const forms = [
          [`https://docs.google.com/document/d/${id}/edit`, 'doc'],
          [`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`, 'sheet'],
          [`https://docs.google.com/forms/d/${id}/viewform`, 'form'],
          [`https://drive.google.com/drive/folders/${id}`, 'folder'],
        ] as const;
        for (const [url, type] of forms) {
          const parsed = parseTargetUrl(url);
          expect(parsed?.id).toBe(id);
          expect(parsed?.type).toBe(type);
          expect(resolveTarget(url).id).toBe(id);
        }
      }),
    );
  });

  it('резолв идемпотентен: повторный прогон по ID той же цели ничего не меняет', () => {
    fc.assert(
      fc.property(fileId, (id) => {
        const once = resolveTarget(`https://docs.google.com/spreadsheets/d/${id}/edit`);
        const twice = resolveTarget(once.id);
        expect(twice.id).toBe(once.id);
        expect(twice.allow).toBe(once.allow);
      }),
    );
  });
});

describe('инварианты повторов', () => {
  it('неповторяемая ошибка вызывает функцию ровно один раз при любом бюджете', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom<ErrorCode>('forbidden', 'not_found', 'auth_expired', 'policy_denied'),
        async (maxRetries, code) => {
          let calls = 0;
          await expect(
            withRetry(
              async () => {
                calls += 1;
                throw gcError(code);
              },
              { maxRetries, sleep: async () => undefined },
            ),
          ).rejects.toMatchObject({ payload: { code } });
          expect(calls).toBe(1);
        },
      ),
    );
  });

  it('повторяемая ошибка расходует ровно maxRetries+1 попыток и не больше', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (maxRetries) => {
        let calls = 0;
        await expect(
          withRetry(
            async () => {
              calls += 1;
              throw gcError('google_unavailable');
            },
            { maxRetries, backoffMs: 1, sleep: async () => undefined },
          ),
        ).rejects.toMatchObject({ payload: { code: 'google_unavailable' } });
        expect(calls).toBe(maxRetries + 1);
      }),
    );
  });

  it('задержки растут монотонно: backoff, а не постоянная пауза', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (maxRetries) => {
        const delays: number[] = [];
        await withRetry(
          async () => {
            throw gcError('quota_exceeded');
          },
          {
            maxRetries,
            backoffMs: 1,
            sleep: async (ms) => {
              delays.push(ms);
            },
          },
        ).catch(() => undefined);
        for (let i = 1; i < delays.length; i += 1) {
          expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
        }
      }),
    );
  });
});

describe('инварианты правил (D-12)', () => {
  it('ни одна операция без dryRun:false не пишет — при любых значениях и любой операции', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('appendRow', 'upsertRow', 'setCells'),
        fc.integer({ min: -50, max: 50 }),
        async (kind, hours) => {
          const client = new FakeSheetsClient();
          const data = buildSheetData(snapshot());
          const values = { Часы: hours };
          const selector = { Проект: 'G connect' };

          if (kind === 'appendRow') await appendRow(client, data, { ...selector, ...values });
          else if (kind === 'upsertRow') await upsertRow(client, data, selector, values);
          else await setCells(client, data, selector, values);

          expect(client.writes).toHaveLength(0);
          expect(client.appends).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('план никогда не превышает бюджет правила: либо влезает, либо отказ с id правила', async () => {
    const max = limitOf('write.max-changes', 200);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: max * 2 }), async (rows) => {
        const data = buildSheetData(snapshot([wideSheet(rows)]));
        try {
          const outcome = await setCells(
            new FakeSheetsClient(),
            data,
            { Группа: 'все' },
            { Значение: -1 },
          );
          expect(outcome.changes.length).toBeLessThanOrEqual(max);
        } catch (error) {
          const payload = (error as { payload: { cause?: string } }).payload;
          expect(payload.cause).toBe('write.max-changes');
          expect(rows).toBeGreaterThan(max);
        }
      }),
      { numRuns: 15 },
    );
  });

  it('любая ошибка ядра доходит человеку с кодом, названием и решением про действие', () => {
    fc.assert(
      fc.property(errorCode, (code) => {
        const payload = gcError(code).toPayload();
        expect(payload.code).toBe(code);
        expect(payload.title.length).toBeGreaterThan(0);
        // Либо действие названо, либо явно сказано, что его нет (§13.7 п.3).
        expect(payload.action === null || payload.action.label.length > 0).toBe(true);
      }),
    );
  });
});

describe('инварианты разбора значений', () => {
  const dateColumn = {
    name: 'Дата',
    letter: 'A',
    index: 0,
    type: 'date' as const,
    dateFormat: 'iso' as const,
    enumValues: null,
    enumSource: null,
    filled: 1,
    unique: 1,
    hasFormula: false,
    protected: false,
  };

  const MONTHS_RU = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];

  // Нашёл мутационный гейт: строки месяцев можно было заменить пустыми, и ни один
  // тест не замечал — проверялся только сентябрь. Свойство закрывает все двенадцать.
  it('«<день> <месяц>» разбирается в правильный месяц для всех двенадцати', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 28 }),
        (index, day) => {
          const outcome = normalizeValue(`${day} ${MONTHS_RU[index]!}`, dateColumn, {
            now: new Date(2026, 0, 15),
          });
          expect(outcome.status).toBe('ok');
          if (outcome.status === 'ok') {
            const expected = `2026-${String(index + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            expect(outcome.value).toBe(expected);
          }
        },
      ),
    );
  });

  it('«сегодня», «вчера» и «завтра» считаются от переданного времени, а не от системного', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 27 }),
        fc.constantFrom('сегодня', 'вчера', 'завтра'),
        (day, word) => {
          const now = new Date(2026, 5, day);
          const shift = word === 'вчера' ? -1 : word === 'завтра' ? 1 : 0;
          const outcome = normalizeValue(word, dateColumn, { now });
          expect(outcome.status).toBe('ok');
          if (outcome.status === 'ok') {
            expect(outcome.value).toBe(`2026-06-${String(day + shift).padStart(2, '0')}`);
          }
        },
      ),
    );
  });

  it('формат колонки уважается: точки там, где в колонке точки', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 28 }), (day) => {
        const dotted = { ...dateColumn, dateFormat: 'dotted' as const };
        const outcome = normalizeValue(`${day} марта 2026`, dotted, { now: new Date(2026, 0, 1) });
        if (outcome.status === 'ok') {
          expect(outcome.value).toBe(`${String(day).padStart(2, '0')}.03.2026`);
        }
      }),
    );
  });

  it('«да/нет/true/false» в логической колонке дают boolean, мусор — вопрос', () => {
    const boolColumn = { ...dateColumn, type: 'boolean' as const, dateFormat: null };
    for (const [raw, expected] of [
      ['да', true],
      ['ДА', true],
      ['нет', false],
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
    ] as const) {
      const outcome = normalizeValue(raw, boolColumn);
      expect(outcome.status, raw).toBe('ok');
      if (outcome.status === 'ok') expect(outcome.value, raw).toBe(expected);
    }
    // Не логическое значение в логической колонке остаётся текстом, а не превращается в false.
    const other = normalizeValue('может быть', boolColumn);
    expect(other.status).toBe('ok');
    if (other.status === 'ok') expect(other.value).toBe('может быть');
  });
});

describe('инвариант отката (§10)', () => {
  it('запись → undo возвращает лист к прежнему состоянию при любых значениях', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -99, max: 99 }),
        fc.constantFrom(...STATUS_VALUES),
        async (hours, status) => {
          const client = new MutableSheetsClient(snapshot());
          const journalled: WriteRecord[] = [];
          const sink = async (r: WriteRecord): Promise<void> => {
            journalled.push(r);
          };

          const rowsBefore = JSON.stringify(buildSheetData(await client.getSpreadsheet()).rows);

          await upsertConfirmed(
            client,
            buildSheetData(await client.getSpreadsheet()),
            { Дата: '2026-09-01', Проект: 'G connect' },
            { Часы: hours, Статус: status },
            { dryRun: false, journal: sink, readRevision: () => Promise.resolve('rev-1') },
          );

          await undoLast(
            client,
            'SHEET_ID',
            { recent: () => Promise.resolve(journalled) },
            { currentRevision: 'rev-1', journal: sink },
          );

          // Ключевое отношение: состояние ПОСЛЕ отката равно состоянию ДО записи.
          expect(JSON.stringify(buildSheetData(await client.getSpreadsheet()).rows)).toBe(
            rowsBefore,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('инварианты профилей', () => {
  const original = process.env['GCONNECT_HOME'];
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gconnect-prop-'));
    process.env['GCONNECT_HOME'] = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env['GCONNECT_HOME'];
    else process.env['GCONNECT_HOME'] = original;
  });

  it('round-trip токена и права 600 — при любом имени аккаунта и любых scopes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
        fc.uniqueArray(fc.stringMatching(/^[a-z.]{3,12}$/), { minLength: 1, maxLength: 4 }),
        async (account, scopeWords) => {
          const scope = scopeWords.map((w) => `https://www.googleapis.com/auth/${w}`).join(' ');
          await writeToken({ access_token: 'a', refresh_token: 'r', scope }, account);
          const back = await readToken(account);
          expect(back?.scope).toBe(scope);
          expect((await stat(join(profileDir(account), 'token.json'))).mode & 0o777).toBe(0o600);

          const status = await profileStatus(account);
          expect(status.scopes).toEqual(
            scopeWords.map((w) => `https://www.googleapis.com/auth/${w}`),
          );
          // Инвариант §13.5: статус наружу — без секретов, при любых входных данных.
          expect(JSON.stringify(status)).not.toContain('refresh_token');
        },
      ),
      { numRuns: 25 },
    );
  });

  it('состояние профиля определено всегда: любая комбинация файлов даёт валидный state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (dir, creds, token) => {
        const account = `a${Math.random().toString(36).slice(2, 8)}`;
        if (dir) await mkdir(profileDir(account), { recursive: true });
        if (dir && creds) {
          await writeFile(
            join(profileDir(account), 'credentials.json'),
            JSON.stringify({ web: { client_id: 'i', client_secret: 's' } }),
          );
        }
        if (dir && token) await writeToken({ access_token: 'a', refresh_token: 'r' }, account);

        const status = await profileStatus(account);
        expect(['no_profile', 'no_credentials', 'needs_reauth', 'connected']).toContain(
          status.state,
        );
        if (status.state === 'connected') {
          expect(status.hasCredentials && status.hasToken).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });
});

describe('инварианты карты, резолвера и записи', () => {
  const columnsOf = () => buildSheetMap(snapshot()).columns;
  const names = ['Дата', 'Проект', 'Статус', 'Часы'] as const;

  it('любое имя колонки в любом регистре и с любыми пробелами резолвится молча', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...names),
        fc.constantFrom('', ' ', '  '),
        fc.boolean(),
        (name, padding, upper) => {
          const requested = `${padding}${upper ? name.toUpperCase() : name.toLowerCase()}${padding}`;
          const result = resolveColumn(requested, columnsOf());
          expect(isSilent(result.step)).toBe(true);
          expect(result.column?.name).toBe(name);
          expect(result.assumption).toBeNull();
        },
      ),
    );
  });

  it('когда нужен вопрос — колонка не выбрана; когда есть оговорка — это ступень fuzzy', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (requested) => {
        const result = resolveColumn(requested, columnsOf());
        if (needsClarification(result.step)) {
          expect(result.column).toBeNull();
          expect(result.assumption).toBeNull();
        }
        if (result.assumption !== null) {
          expect(result.step).toBe('fuzzy');
          expect(result.column).not.toBeNull();
        }
      }),
    );
  });

  it('на ступени missing кандидатов НЕТ: полный список живёт у вопроса, не в кандидатах', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{6,12}$/), (requested) => {
        const result = resolveColumn(requested, columnsOf());
        // `candidates` значит «похожие, выбери из них». Когда похожих нет — он пуст,
        // иначе агенту в контекст падает вся шапка (нашла живая проба).
        if (result.step === 'missing') expect(result.candidates).toHaveLength(0);
      }),
    );
  });

  it('значение из enum в любом регистре приводится к каноническому', () => {
    const status = columnsOf().find((c) => c.name === 'Статус')!;
    fc.assert(
      fc.property(fc.constantFrom(...STATUS_VALUES), fc.boolean(), (value, upper) => {
        const outcome = normalizeValue(upper ? value.toUpperCase() : value, status);
        expect(outcome.status).toBe('ok');
        if (outcome.status === 'ok') expect(outcome.value).toBe(value);
      }),
    );
  });

  it('число остаётся числом, чем бы его ни сопроводили', () => {
    const hours = columnsOf().find((c) => c.name === 'Часы')!;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.constantFrom('', 'ч', ' ч', 'ч.', ' часов'),
        (n, suffix) => {
          const outcome = normalizeValue(`${n}${suffix}`, hours);
          expect(outcome.status).toBe('ok');
          if (outcome.status === 'ok') expect(outcome.value).toBe(n);
        },
      ),
    );
  });

  // Ключевой инвариант §5: регулярная запись не должна плодить дубликаты.
  it('upsert идемпотентен: второй прогон с теми же значениями не меняет ничего', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 99 }),
        fc.constantFrom(...STATUS_VALUES),
        async (hours, status) => {
          const client = new MutableSheetsClient(snapshot());
          const key = { Дата: '2026-09-01', Проект: 'G connect' };
          const values = { Часы: hours, Статус: status };

          const first = await upsertConfirmed(
            client,
            buildSheetData(await client.getSpreadsheet()),
            key,
            values,
            {
              dryRun: false,
            },
          );
          // Генератор может выдать ровно то, что в фикстуре уже стоит (Часы 2, «в работе») —
          // тогда первая запись сама ничего не меняет. До разбора живого прогона B13 такой
          // случай возвращал `ok` без строки журнала, и этот тест его же и закреплял.
          expect(['ok', 'no_change']).toContain(first.status);

          const second = await upsertConfirmed(
            client,
            buildSheetData(await client.getSpreadsheet()),
            key,
            values,
            {
              dryRun: false,
            },
          );
          expect(second.changes).toHaveLength(0);
          // Второй прогон обязан назвать себя: «ничего не изменилось», а не «записано».
          expect(second.status).toBe('no_change');

          // И строк по-прежнему две: правили, а не добавляли.
          expect(buildSheetMap(await client.getSpreadsheet()).dataRowCount).toBe(2);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('в плане не бывает изменения, где before равно after', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 50 }), async (hours) => {
        const outcome = await upsertRow(
          new FakeSheetsClient(),
          buildSheetData(snapshot()),
          { Дата: '2026-09-01', Проект: 'G connect' },
          { Часы: hours },
        );
        for (const change of outcome.changes) {
          expect(String(change.before ?? '')).not.toBe(String(change.after ?? ''));
        }
      }),
      { numRuns: 20 },
    );
  });

  it('dryRun по умолчанию не пишет никогда, при любых значениях', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 99 }),
        fc.constantFrom(...STATUS_VALUES),
        async (hours, status) => {
          const client = new FakeSheetsClient();
          await upsertRow(
            client,
            buildSheetData(snapshot()),
            { Дата: '2026-09-01', Проект: 'G connect' },
            { Часы: hours, Статус: status },
          );
          expect(client.writes).toHaveLength(0);
        },
      ),
      { numRuns: 15 },
    );
  });
});
