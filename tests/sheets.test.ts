/** Примеры A1–A11 из delivery/active/spec.md. Ни одного обращения к Google. */

import { describe, expect, it } from 'vitest';

import { buildSheetData, buildSheetMap, detectHeaderRow } from '../src/core/sheets/map.js';
import { appendRow, upsertRow } from '../src/core/sheets/rows.js';
import { setCells } from '../src/core/sheets/set-cells-op.js';
import type { WriteRecord } from '../src/core/journal.js';
import type { CellValue, SpreadsheetSnapshot } from '../src/core/sheets/types.js';
import {
  MutableSheetsClient,
  appendConfirmed,
  formattedSheet,
  formulaSheet,
  reportSheet,
  setCellsConfirmed,
  upsertConfirmed,
  FakeSheetsClient,
  instructionSheet,
  snapshot,
  twoDatesSheet,
} from './fixtures/sheet.js';

const NOW = new Date(2026, 8, 1, 10, 0, 0);
const data = () => buildSheetData(snapshot());
const aliases = { Часы: ['затрачено', 'time'] };

describe('A1 — карта листа', () => {
  it('шапка найдена во второй строке, а не в первой', () => {
    const map = buildSheetMap(snapshot());
    expect(map.headerRow).toBe(2);
    expect(map.headerRowReason).toContain('строка 2');
    expect(map.columns.map((c) => c.name)).toEqual(['Дата', 'Проект', 'Статус', 'Часы']);
    expect(map.dataRowCount).toBe(2);
    expect(map.usedRange).toBe('Лист1!A1:D4');
  });

  it('типы колонок выведены, enum взят из проверки данных таблицы', () => {
    const map = buildSheetMap(snapshot());
    const byName = Object.fromEntries(map.columns.map((c) => [c.name, c]));
    expect(byName['Дата']?.type).toBe('date');
    expect(byName['Дата']?.dateFormat).toBe('iso');
    expect(byName['Часы']?.type).toBe('number');
    expect(byName['Статус']?.enumValues).toEqual(['в работе', 'готово', 'пауза']);
    expect(byName['Статус']?.enumSource).toBe('validation');
  });

  it('строки над шапкой попадают в предупреждения, а не теряются молча', () => {
    expect(buildSheetMap(snapshot()).warnings.join(' ')).toContain('над шапкой');
  });

  it('карта для агента не тащит все строки, данные лежат отдельно', () => {
    const { map, rows } = data();
    expect(map.sampleRows).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(map)).not.toContain('sampleAll');
  });

  it('headerRow можно задать вручную, когда эвристика не угадала', () => {
    const map = buildSheetMap(snapshot(), { headerRow: 1 });
    expect(map.headerRow).toBe(1);
    expect(map.headerRowReason).toContain('задана вызывающим');
  });

  it('эвристика не путает подпись отчёта с шапкой и на других формах листа', () => {
    const guess = detectHeaderRow([
      [{ value: 'Журнал' }, { value: null }],
      [{ value: null }, { value: null }],
      [{ value: 'Дата' }, { value: 'Проект' }],
      [{ value: '2026-09-01' }, { value: 'G connect' }],
    ]);
    expect(guess.row).toBe(3);
  });
});

describe('A2, A3 — upsert правит строку, а не плодит дубликаты', () => {
  it('A2: существующий ключ → одна правка D3, новых строк нет', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertConfirmed(
      client,
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 3 },
      { dryRun: false },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes).toEqual([
      { kind: 'set', a1: 'Лист1!D3', column: 'Часы', before: 2, after: 3 },
    ]);
    expect(client.writes).toHaveLength(1);
  });

  it('A3: нового ключа нет → добавляется строка 5', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertConfirmed(
      client,
      data(),
      { Дата: '2026-09-02', Проект: 'G connect' },
      { Статус: 'готово', Часы: 1 },
      { dryRun: false, now: NOW },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes.every((c) => c.kind === 'addRow')).toBe(true);
    expect(outcome.changes.map((c) => c.a1)).toEqual([
      'Лист1!A5',
      'Лист1!B5',
      'Лист1!C5',
      'Лист1!D5',
    ]);
  });

  it('dryRun по умолчанию: план есть, записи нет (§11.1)', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertRow(
      client,
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 9 },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.changes).toHaveLength(1);
    expect(client.writes).toHaveLength(0);
  });

  it('повторный upsert с теми же значениями не порождает изменений', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 2 },
    );
    expect(outcome.changes).toHaveLength(0);
  });
});

describe('A4, A4b, A4c — ступени резолва имени колонки', () => {
  it('A4: «Статус проекта» → «Статус» с оговоркой в превью (ступень 4)', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { 'Статус проекта': 'готово' },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.assumptions).toEqual(['«Статус проекта» → колонка «Статус»']);
    expect(outcome.changes[0]?.a1).toBe('Лист1!C3');
  });

  it('A4b: подтверждённый алиас пишет молча, оговорок нет (ступень 3)', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { Затрачено: 4 },
      { aliases },
    );
    expect(outcome.assumptions).toEqual([]);
    expect(outcome.changes[0]).toMatchObject({ column: 'Часы', a1: 'Лист1!D3', after: 4 });
  });

  it('A4c: опечатка «Стаус» → «Статус» с оговоркой', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { Стаус: 'готово' },
    );
    expect(outcome.assumptions).toEqual(['«Стаус» → колонка «Статус»']);
  });

  it('латинская «c» в «Cтатус» и регистр — ступень 2, молча', async () => {
    const outcome = await setCells(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { cтатус: 'готово' },
    );
    expect(outcome.assumptions).toEqual([]);
    expect(outcome.changes[0]?.column).toBe('Статус');
  });
});

describe('A5, A6 — неоднозначность и отсутствие спрашиваются', () => {
  it('A5: «Дата» при «Дата начала» и «Дата сдачи» → вопрос с кандидатами', async () => {
    const twoDates = buildSheetData(snapshot([twoDatesSheet()]));
    const outcome = await setCells(
      new FakeSheetsClient(),
      twoDates,
      { Проект: 'G connect' },
      { Дата: 'сегодня' },
      { now: NOW },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('ambiguous');
    expect(outcome.questions[0]?.candidates).toEqual(['Дата начала', 'Дата сдачи']);
    expect(outcome.changes).toHaveLength(0);
  });

  it('A6: колонки нет → вопрос со полным списком, колонка не создана', async () => {
    const client = new FakeSheetsClient();
    const outcome = await setCellsConfirmed(
      client,
      data(),
      { Проект: 'G connect' },
      { Бюджет: 100 },
      { dryRun: false },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('no_match');
    expect(outcome.questions[0]?.available).toEqual(['Дата', 'Проект', 'Статус', 'Часы']);
    expect(client.writes).toHaveLength(0);
  });
});

describe('A7, A8, A9 — значения', () => {
  it('A7: «В РАБОТЕ» приводится к «в работе» молча', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Статус: 'В РАБОТЕ' },
    );
    // Было `preview` с нулём строк — то есть план, который ничего не меняет. После
    // разбора живого прогона B13 такой ответ называется своим статусом.
    expect(outcome.status).toBe('no_change');
    expect(outcome.changes).toHaveLength(0);
    expect(outcome.notes.join(' ')).toContain('приведено к «в работе»');
  });

  it('A8: «почти готово» — новое значение, а не опечатка → вопрос со списком', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Статус: 'почти готово' },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('not_in_enum');
    expect(outcome.questions[0]?.candidates).toEqual(['в работе', 'готово', 'пауза']);
    expect(outcome.questions[0]?.detail).toContain('проверкой данных');
  });

  it('A9: «3ч» записывается числом 3', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: '3ч' },
    );
    expect(outcome.changes[0]?.after).toBe(3);
    expect(outcome.notes.join(' ')).toContain('разобрано как 3');
  });

  it('«много» в числовую колонку — вопрос, а не 0 и не NaN', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Дата: '2026-09-01', Проект: 'G connect' },
      { Часы: 'много' },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('not_a_number');
  });

  it('«сегодня» пишется в формате колонки: точки там, где точки', async () => {
    const twoDates = buildSheetData(snapshot([twoDatesSheet()]));
    const outcome = await setCells(
      new FakeSheetsClient(),
      twoDates,
      { Проект: 'G connect' },
      { 'Дата сдачи': 'сегодня' },
      { now: NOW },
    );
    expect(outcome.changes[0]?.after).toBe('01.09.2026');
  });
});

describe('A10, A11 — блокировки и похожие ключи', () => {
  it('A10: запись в формульную колонку блокируется с внятной причиной', async () => {
    const formulas = buildSheetData(snapshot([formulaSheet()]));
    await expect(
      setCells(new FakeSheetsClient(), formulas, { Проект: 'G connect' }, { Итого: 10 }),
    ).rejects.toMatchObject({
      payload: {
        code: 'write_blocked',
        cause: 'formula_column',
        action: { kind: 'confirm_explicitly' },
      },
    });
  });

  it('A10b: с осознанным подтверждением запись разрешена', async () => {
    const formulas = buildSheetData(snapshot([formulaSheet()]));
    const outcome = await setCells(
      new FakeSheetsClient(),
      formulas,
      { Проект: 'G connect' },
      { Итого: 10 },
      { force: true },
    );
    expect(outcome.status).toBe('preview');
  });

  it('A11: «Gconnect» вместо «G connect» → вопрос вместо новой строки', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Проект: 'Gconnect' },
      { Часы: 1 },
    );
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.reason).toBe('key_not_found');
    expect(outcome.questions[0]?.candidates).toEqual(['G connect']);
  });

  it('ревизия изменилась с момента чтения → revision_conflict, а не слепая запись', async () => {
    await expect(
      upsertConfirmed(
        new FakeSheetsClient(),
        data(),
        { Проект: 'G connect' },
        { Часы: 1 },
        { expectRevision: 'rev-0', dryRun: false },
      ),
    ).rejects.toMatchObject({ payload: { code: 'revision_conflict' } });
  });

  it('ключ подошёл нескольким строкам → уточнить, а не править все', async () => {
    const many = buildSheetData(
      snapshot([
        {
          title: 'Лист1',
          sheetId: 0,
          rows: [
            [{ value: 'Проект' }, { value: 'Часы' }],
            [{ value: 'G connect' }, { value: 1 }],
            [{ value: 'G connect' }, { value: 2 }],
          ],
        },
      ]),
    );
    await expect(
      upsertConfirmed(new FakeSheetsClient(), many, { Проект: 'G connect' }, { Часы: 5 }),
    ).rejects.toMatchObject({ payload: { code: 'ambiguous_target' } });
  });

  it('appendRow пишет дубликат осознанно — там это законно', async () => {
    const client = new FakeSheetsClient();
    const outcome = await appendConfirmed(
      client,
      data(),
      { Дата: '2026-09-01', Проект: 'G connect', Часы: 2 },
      { dryRun: false },
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.changes).toHaveLength(3);
    expect(client.writes.map((w) => w.range)).toEqual(['Лист1!A5', 'Лист1!B5', 'Лист1!D5']);
  });
});

describe('живой лист-инструкция: две таблицы и объединённые ячейки (§9.3)', () => {
  const map = () => buildSheetMap(snapshot([instructionSheet()]));

  it('шапка найдена в строке 7, а не в баннере строки 1', () => {
    expect(map().headerRow).toBe(7);
    expect(map().columns.map((c) => c.name)).toEqual([
      'Вкладка',
      'Кто заполняет',
      'Когда обновлять',
      'Критерии завершения задачи',
    ]);
  });

  it('пустая колонка D и подписи правее — предупреждение про ДВА блока, а не тишина', () => {
    const text = map().warnings.join(' | ');
    expect(text).toContain('колонка D пуста');
    expect(text).toContain('ДВА блока');
    expect(text).toContain('с E');
  });

  it('объединение в области данных названо диапазоном', () => {
    const text = map().warnings.join(' | ');
    expect(text).toContain('в области данных');
    expect(text).toContain('E8:H14');
  });

  it('объединённый баннер ВЫШЕ шапки молчит — он ничего не искажает', () => {
    // Строка 1 A:H объединена, но шапка в строке 7: разбор не страдает,
    // и лишнее предупреждение только зашумило бы вывод.
    expect(map().warnings.join(' ')).not.toContain('шапку задевают');
  });

  it('а вот объединение В САМОЙ шапке — предупреждение: имена читаются не как выглядят', () => {
    const merged = buildSheetMap(
      snapshot([
        {
          title: 'Свод',
          sheetId: 9,
          rows: [
            [{ value: 'Проект' }, { value: 'Сроки' }, { value: null }],
            [{ value: 'G connect' }, { value: '2026-09-01' }, { value: '2026-09-30' }],
          ],
          merges: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 2 }],
        },
      ]),
    );
    expect(merged.warnings.join(' ')).toContain('шапку задевают объединённые ячейки');
  });

  it('строки над шапкой тоже названы — их шесть', () => {
    expect(map().warnings.join(' ')).toContain('над шапкой');
  });

  it('врезка не притворяется полноценной колонкой: заполнена одна ячейка из трёх', () => {
    const column = map().columns.find((c) => c.name === 'Критерии завершения задачи');
    expect(column?.filled).toBe(1);
    // Данные при этом читаются без искажения — просто про блок сказано вслух.
    expect(map().dataRowCount).toBe(3);
  });
});

describe('универсальность ядра (D-10)', () => {
  it('в коде ядра нет имён листов, колонок и таблиц', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(path)));
        else if (entry.name.endsWith('.ts')) out.push(path);
      }
      return out;
    };

    // Имена из фикстуры: если они всплывут в КОДЕ, значит ядро подогнали под таблицу.
    // Комментарии вырезаются: пример в прозе («„Бюджет“ не должен быть похож на „Часы“»)
    // объясняет порог и ничего не зашивает — первая версия теста краснела именно на нём.
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const forbidden = ['Лист1', 'Проект', 'Часы', 'Отчёт за сентябрь', 'daily-log', 'Сроки'];
    for (const file of await walk('src')) {
      const code = stripComments(await readFile(file, 'utf8'));
      for (const word of forbidden) {
        expect(code, `${file} зашивает «${word}» в код`).not.toContain(word);
      }
    }
  });
});

/**
 * Оракул на дефект живого прогона B13 (Cursor, 2026-09-02): «значение уже такое»
 * возвращалось как обычное превью, а с `dryRun:false` — как `ok` без строки журнала.
 * Человек читал «готово» при пустом факте.
 */
describe('нулевое изменение — не выполненная запись', () => {
  const noChange = () =>
    upsertRow(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { Статус: 'в работе' },
      { now: NOW, aliases },
    );

  it('превью получает статус no_change и объясняет причину', async () => {
    const outcome = await noChange();
    expect(outcome.status).toBe('no_change');
    expect(outcome.changes).toHaveLength(0);
    expect(outcome.notes.join(' ')).toContain('уже такие значения');
  });

  it('запись нулевого плана не идёт в Google, не журналируется и не зовётся ok', async () => {
    const client = new FakeSheetsClient();
    const journalled: WriteRecord[] = [];
    let revisionReads = 0;
    const outcome = await upsertConfirmed(
      client,
      data(),
      { Проект: 'G connect' },
      { Статус: 'в работе' },
      {
        now: NOW,
        aliases,
        dryRun: false,
        journal: async (record) => {
          journalled.push(record);
        },
        readRevision: async () => {
          revisionReads += 1;
          return 'rev-2';
        },
      },
    );
    expect(outcome.status).toBe('no_change');
    expect(client.writes).toHaveLength(0);
    expect(journalled).toHaveLength(0);
    // Ни одного лишнего обращения к Google: ревизию после записи читать незачем.
    expect(revisionReads).toBe(0);
  });
});

/**
 * Предусловие записи (D-17, фаза 2.6): в ячейке всё ещё то, что показывало превью.
 *
 * План строится из снимка `data()`, а клиент перед записью отдаёт ДРУГОЙ снимок — так
 * выглядит правка человеком между «покажи план» и «пиши».
 */
class AlteredClient extends FakeSheetsClient {
  constructor(private readonly altered: () => SpreadsheetSnapshot) {
    super();
  }
  override async getSpreadsheet(): Promise<SpreadsheetSnapshot> {
    return this.altered();
  }
}

const withRow = (index: number, cells: CellValue[]): SpreadsheetSnapshot => {
  const s = snapshot();
  const sheet = s.sheets[0]!;
  const rows = sheet.rows.map((r) => [...r]);
  rows[index] = cells.map((value) => ({ value }));
  return { ...s, sheets: [{ ...sheet, rows }] };
};

type Thrown = { payload: { code: string; cause?: string; detail: string } };
const thrown = async (run: Promise<unknown>): Promise<Thrown> =>
  run.then(
    () => {
      throw new Error('ожидался отказ, а вызов прошёл');
    },
    (e: unknown) => e as Thrown,
  );

describe('запись не идёт на изменившееся значение', () => {
  const statusChanged = () => withRow(2, ['2026-09-01', 'G connect', 'пауза', 2]);

  it('превью отдаёт код плана и значения «до» по каждой ячейке', async () => {
    const outcome = await upsertRow(
      new FakeSheetsClient(),
      data(),
      { Проект: 'G connect' },
      { Часы: 4 },
      { now: NOW, aliases },
    );
    expect(outcome.status).toBe('preview');
    expect(outcome.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(outcome.changes[0]?.before).toBe(2);
  });

  it('значение изменилось после превью → stale_value, ни одной записи', async () => {
    const client = new AlteredClient(statusChanged);
    const failure = await thrown(
      upsertConfirmed(
        client,
        data(),
        { Проект: 'G connect' },
        { Статус: 'готово' },
        {
          now: NOW,
          aliases,
          dryRun: false,
        },
      ),
    );
    expect(failure.payload.code).toBe('stale_value');
    expect(failure.payload.cause).toBe('value_changed_after_preview');
    expect(client.writes).toHaveLength(0);
  });

  it('отказ называет ячейку, прежнее и текущее значение', async () => {
    const failure = await thrown(
      upsertConfirmed(
        new AlteredClient(statusChanged),
        data(),
        { Проект: 'G connect' },
        { Статус: 'готово' },
        {
          now: NOW,
          aliases,
          dryRun: false,
        },
      ),
    );
    expect(failure.payload.detail).toContain('Лист1!C3');
    expect(failure.payload.detail).toContain('в работе');
    expect(failure.payload.detail).toContain('пауза');
  });

  it('appendRow не затирает строку, которую занял кто-то другой между превью и записью', async () => {
    const occupied = () => withRow(4, ['2026-09-02', 'чужая строка', null, 1]);
    const client = new AlteredClient(occupied);
    const failure = await thrown(
      appendConfirmed(
        client,
        data(),
        { Проект: 'новый', Часы: 1 },
        { now: NOW, aliases, dryRun: false },
      ),
    );
    expect(failure.payload.code).toBe('stale_value');
    expect(client.writes).toHaveLength(0);
  });
});

/** Подтверждение как подпись (D-16): слайсы 2 и 3. */
describe('запись идёт только по коду плана', () => {
  const key = { Проект: 'G connect' };

  it('B15 — без кода плана запись не проходит, и это отказ с действием', async () => {
    const client = new FakeSheetsClient();
    const failure = await thrown(
      upsertRow(client, data(), key, { Часы: 7 }, { now: NOW, aliases, dryRun: false }),
    );
    expect(failure.payload.code).toBe('confirm_required');
    expect(failure.payload.cause).toBe('write.plan-confirmation');
    expect(client.writes).toHaveLength(0);
  });

  it('B16 — код от другого плана: записи нет, в ответе новый план и его код', async () => {
    const client = new FakeSheetsClient();
    const outcome = await upsertRow(
      client,
      data(),
      key,
      { Часы: 7 },
      {
        now: NOW,
        aliases,
        dryRun: false,
        confirm: 'ffffff',
      },
    );
    expect(outcome.status).toBe('plan_mismatch');
    expect(outcome.planId).toMatch(/^[0-9a-f]{6}$/);
    expect(outcome.planId).not.toBe('ffffff');
    expect(outcome.changes).toHaveLength(1);
    expect(outcome.notes.join(' ')).toContain('ffffff');
    expect(client.writes).toHaveLength(0);
  });

  it('B19 — в журнал уходят ровно ячейки плана и его код', async () => {
    const client = new FakeSheetsClient();
    const journalled: WriteRecord[] = [];
    const preview = await upsertRow(client, data(), key, { Часы: 7 }, { now: NOW, aliases });
    const outcome = await upsertRow(
      client,
      data(),
      key,
      { Часы: 7 },
      {
        now: NOW,
        aliases,
        dryRun: false,
        confirm: preview.planId ?? '',
        journal: async (r) => {
          journalled.push(r);
        },
      },
    );
    expect(outcome.status).toBe('ok');
    expect(journalled[0]?.planId).toBe(preview.planId);
    expect(journalled[0]?.changes.map((c) => c.a1)).toEqual(preview.changes.map((c) => c.a1));
  });

  it('B20 — тот же план второй раз: отказ, второй строки нет', async () => {
    const client = new FakeSheetsClient();
    const journalled: WriteRecord[] = [];
    const options = {
      now: NOW,
      aliases,
      journal: async (r: WriteRecord) => {
        journalled.push(r);
      },
      journalSource: { recent: () => Promise.resolve(journalled) },
    };
    const preview = await appendRow(client, data(), { Проект: 'ещё один', Часы: 1 }, options);
    const code = preview.planId ?? '';
    const first = await appendRow(
      client,
      data(),
      { Проект: 'ещё один', Часы: 1 },
      {
        ...options,
        dryRun: false,
        confirm: code,
      },
    );
    expect(first.status).toBe('ok');
    const failure = await thrown(
      appendRow(
        client,
        data(),
        { Проект: 'ещё один', Часы: 1 },
        {
          ...options,
          dryRun: false,
          confirm: code,
        },
      ),
    );
    expect(failure.payload.code).toBe('plan_already_applied');
    expect(failure.payload.cause).toBe('write.plan-once');
    // Записи ровно одна порция ячеек, второй строки нет.
    expect(journalled).toHaveLength(1);
  });

  it('после откатa тот же план снова законен: повтор осознанного действия не запрещён', async () => {
    const client = new FakeSheetsClient();
    const journalled: WriteRecord[] = [
      {
        at: NOW.toISOString(),
        account: 'default',
        targetId: 'SHEET1',
        alias: 'log',
        sheet: 'Лист1',
        op: 'upsertRow',
        changes: [{ a1: 'Лист1!D3', column: 'Часы', before: 2, after: 7 }],
        revisionBefore: 'rev-1',
        revisionAfter: 'rev-2',
        correlationId: 'gc-first',
        planId: 'abc123',
      },
      {
        at: NOW.toISOString(),
        account: 'default',
        targetId: 'SHEET1',
        alias: 'log',
        sheet: 'Лист1',
        op: 'undo',
        changes: [{ a1: 'Лист1!D3', column: 'Часы', before: 7, after: 2 }],
        revisionBefore: 'rev-2',
        revisionAfter: null,
        correlationId: 'gc-undo',
        undoOf: 'gc-first',
        planId: 'abc123',
      },
    ];
    const preview = await upsertRow(client, data(), key, { Часы: 7 }, { now: NOW, aliases });
    const outcome = await upsertRow(
      client,
      data(),
      key,
      { Часы: 7 },
      {
        now: NOW,
        aliases,
        dryRun: false,
        confirm: preview.planId ?? '',
        journalSource: {
          recent: () =>
            Promise.resolve(journalled.map((r) => ({ ...r, planId: preview.planId ?? 'abc123' }))),
        },
      },
    );
    expect(outcome.status).toBe('ok');
  });
});

/** B18: `force` перестаёт быть самоподтверждением модели. */
describe('force работает только вместе с кодом плана', () => {
  const formulaData = () => buildSheetData(snapshot([formulaSheet()]));
  const write = { Итого: 42 };
  const key = { Проект: 'G connect' };

  it('без force запись в формульную колонку блокируется и в превью', async () => {
    const failure = await thrown(upsertRow(new FakeSheetsClient(), formulaData(), key, write));
    expect(failure.payload.code).toBe('write_blocked');
  });

  it('force без кода плана не проходит: модель не подтверждает сама за человека', async () => {
    const client = new FakeSheetsClient(snapshot([formulaSheet()]));
    const failure = await thrown(
      upsertRow(client, formulaData(), key, write, { dryRun: false, force: true }),
    );
    expect(failure.payload.code).toBe('confirm_required');
    expect(client.writes).toHaveLength(0);
  });

  it('force с кодом плана проходит, и код помнит, что план лез в формулы', async () => {
    const client = new FakeSheetsClient(snapshot([formulaSheet()]));
    const preview = await upsertRow(client, formulaData(), key, write, { force: true });
    expect(preview.status).toBe('preview');
    const outcome = await upsertRow(client, formulaData(), key, write, {
      dryRun: false,
      force: true,
      confirm: preview.planId ?? '',
    });
    expect(outcome.status).toBe('ok');
    expect(client.writes).toHaveLength(1);
    // Тот же набор ячеек без пометки «формула» дал бы другой код — оракул в plan.test.ts.
    expect(outcome.planId).toBe(preview.planId);
  });
});

/**
 * Порядок веток в `finish` закрепляем оракулом, а не оставляем случайным.
 *
 * Живой прогон 2026-09-02: второе «пиши» с тем же кодом дало `no_change`, а не
 * `plan_already_applied` — потому что после первой записи значение уже целевое, и план
 * пуст. Это верно: менять нечего, и говорить «план уже записан» было бы менее точно.
 * `write.plan-once` остаётся достижимым там, где повтор ВСЁ ЕЩЁ меняет лист, — у
 * `appendRow`, ради которого правило и написано.
 */
describe('повтор подтверждённой правки', () => {
  it('тот же код на уже применённом значении даёт no_change, а не plan_already_applied', async () => {
    const client = new MutableSheetsClient();
    const journalled: WriteRecord[] = [];
    const options = {
      journal: async (r: WriteRecord) => {
        journalled.push(r);
      },
      journalSource: { recent: () => Promise.resolve(journalled) },
    };
    const key = { Проект: 'G connect' };
    const values = { Статус: 'готово' };
    const first = await upsertConfirmed(
      client,
      buildSheetData(await client.getSpreadsheet()),
      key,
      values,
      options,
    );
    expect(first.status).toBe('ok');

    const again = await upsertRow(
      client,
      buildSheetData(await client.getSpreadsheet()),
      key,
      values,
      { ...options, dryRun: false, confirm: first.planId ?? '' },
    );
    expect(again.status).toBe('no_change');
    // Главное: второй записи нет — гарантия та же, что дало бы plan_already_applied.
    expect(journalled).toHaveLength(1);
  });
});

/** Фаза 2.5a, слайс 1: вид ячейки виден ядру. */
describe('V1, V9 — вид и формулы в карте', () => {
  const formatted = () => buildSheetMap(snapshot([formattedSheet()]));

  it('V1: вид шапки и вид данных попадают в профиль колонки', () => {
    const byName = Object.fromEntries(formatted().columns.map((c) => [c.name, c]));
    expect(byName['Проект']?.headerFormat).toEqual({ bold: true, align: 'center' });
    expect(byName['Часы']?.format).toEqual({ align: 'right' });
    expect(byName['Статус']?.format).toEqual({ background: '#ffcc00' });
  });

  it('вид не кладётся в карту пустым объектом, когда его не задавали', () => {
    const plain = buildSheetMap(snapshot());
    for (const column of plain.columns) {
      expect(column.format, column.name).toBeUndefined();
      expect(column.headerFormat, column.name).toBeUndefined();
    }
    // Карта остаётся дешёвой: поля вида не появляются ни у одной колонки.
    expect(JSON.stringify(plain)).not.toContain('"format"');
  });

  it('V9: значение с «=» видно как формула — отдельной операции для этого не нужно', async () => {
    const client = new FakeSheetsClient(snapshot([formulaSheet()]));
    const data = buildSheetData(snapshot([formulaSheet()]));
    const preview = await upsertRow(
      client,
      data,
      { Проект: 'G connect' },
      { Итого: '=B2*3' },
      {
        force: true,
      },
    );
    expect(preview.changes[0]?.after).toBe('=B2*3');
    // Запись уходит как значение: USER_ENTERED на стороне Google делает из него формулу,
    // и это проверяется живой пробой, а не фейком (урок L3).
    const outcome = await upsertRow(
      client,
      data,
      { Проект: 'G connect' },
      { Итого: '=B2*3' },
      {
        force: true,
        dryRun: false,
        confirm: preview.planId ?? '',
      },
    );
    expect(outcome.status).toBe('ok');
    expect(client.writes[0]?.values[0]?.[0]).toBe('=B2*3');
    // Карта уже помечает такую колонку формульной — значит следующая правка потребует force.
    expect(
      buildSheetMap(snapshot([formulaSheet()])).columns.find((c) => c.name === 'Итого')?.hasFormula,
    ).toBe(true);
  });
});

/** Найдено живой проверкой 2026-09-03: карта отдавала строку за границей данных. */
describe('карта не отдаёт пустой хвост сетки', () => {
  const padded = () => {
    const base = reportSheet();
    return snapshot([
      { ...base, rows: [...base.rows, ...Array.from({ length: 30 }, () => [{ value: null }])] },
    ]);
  };

  it('sampleRows и rows кончаются там, где кончаются данные', () => {
    const { map, rows } = buildSheetData(padded());
    expect(map.dataRowCount).toBe(2);
    expect(rows).toHaveLength(2);
    expect(map.sampleRows).toHaveLength(2);
  });

  it('пустая строка ВНУТРИ данных не обрезает хвостовой блок', () => {
    const base = reportSheet();
    const withGap = snapshot([
      {
        ...base,
        rows: [
          ...base.rows,
          [{ value: null }, { value: null }, { value: null }, { value: null }],
          [{ value: '2026-09-03' }, { value: 'после пропуска' }, { value: 'готово' }, { value: 1 }],
          [{ value: null }],
        ],
      },
    ]);
    const { rows } = buildSheetData(withGap);
    // Три строки данных, пустая посередине сохранена, пустой хвост отрезан.
    expect(rows).toHaveLength(4);
    expect(rows[3]?.['Проект']).toBe('после пропуска');
  });
});
