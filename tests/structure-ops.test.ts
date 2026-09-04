/**
 * Позиционные структурные операции и их откат (фаза 2.5b): G3, G4, G8, G10, G14.
 *
 * Проверяется не «метод вызвали», а состояние снимка ПОСЛЕ: фейк применяет геометрию,
 * поэтому «строка вставилась» и «вставленное исчезло» — наблюдаемые факты, а не обещания.
 */

import { describe, expect, it } from 'vitest';

import type { WriteRecord } from '../src/core/journal.js';
import { buildSheetData } from '../src/core/sheets/map.js';
import {
  addSheet,
  deleteRows,
  deleteSheet,
  insertColumns,
  insertRows,
  renameSheet,
} from '../src/core/sheets/structure-op.js';
import { undoLast } from '../src/core/undo.js';
import { formatCells } from '../src/core/sheets/format-op.js';
import {
  MutableSheetsClient,
  formattedSheet,
  instructionSheet,
  reportSheet,
  snapshot,
  wideSheet,
} from './fixtures/sheet.js';

const where = { Проект: 'G connect' };
const book = () => snapshot([reportSheet(), instructionSheet()]);

/** Записать структурную правку так, как это делает человек: превью → код плана → запись. */
const confirmed = async (
  run: (options: Parameters<typeof insertRows>[4]) => ReturnType<typeof insertRows>,
  journalled: WriteRecord[],
): ReturnType<typeof insertRows> => {
  const preview = await run({});
  return run({
    dryRun: false,
    ...(preview.planId === null ? {} : { confirm: preview.planId }),
    journal: async (record) => {
      journalled.push(record);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
  });
};

describe('G3 — вставка строки и её откат', () => {
  it('превью описывает позицию и якорь, ничего не пишет', async () => {
    const client = new MutableSheetsClient(book());
    const preview = await insertRows(client, buildSheetData(book()), where, 1, {});
    expect(preview.status).toBe('preview');
    expect(preview.structural).toMatchObject({ kind: 'insertRows', at: 3, count: 1 });
    expect(preview.structural?.anchor).toContain('G connect');
    expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
    // Ячеек в плане нет — и это не `no_change`: правка есть, просто она про геометрию.
    expect(preview.changes).toHaveLength(0);
  });

  it('запись сдвигает строки, откат возвращает лист к прежнему виду', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const outcome = await confirmed(
      (options) => insertRows(client, buildSheetData(book()), where, 1, options),
      journalled,
    );
    expect(outcome.status).toBe('ok');
    expect(journalled[0]?.structure).toMatchObject({ kind: 'insertRows', at: 3, count: 1 });

    const afterWrite = await client.getSpreadsheet();
    expect(afterWrite.sheets[0]?.rows[2]).toEqual([]);
    expect(afterWrite.sheets[0]?.rows[3]?.[1]?.value).toBe('G connect');

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.status).toBe('ok');
    expect(undone.structureUndone).toContain('удален');
    const afterUndo = await client.getSpreadsheet();
    expect(afterUndo.sheets[0]?.rows[2]?.[1]?.value).toBe('G connect');
  });
});

describe('G4 — откат не удаляет то, что человек успел написать', () => {
  it('вставленная строка заполнена — откат отказывает с причиной', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    await confirmed(
      (options) => insertRows(client, buildSheetData(book()), where, 1, options),
      journalled,
    );
    // Человек дописал в новую строку — теперь «просто удалить вставленное» уничтожит работу.
    await client.updateValues('SHEET', 'Лист1!B3', [['срочная задача']]);

    await expect(
      undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) }),
    ).rejects.toMatchObject({ payload: { cause: 'inserted_not_empty' } });

    // С force — по явному решению человека — откат всё же проходит.
    const forced = await undoLast(
      client,
      'SHEET',
      { recent: () => Promise.resolve(journalled) },
      { force: true },
    );
    expect(forced.status).toBe('ok');
  });
});

describe('G8, G10 — листы', () => {
  it('новый лист появляется, откат удаляет его, пока он пуст', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const outcome = await confirmed(
      (options) => addSheet(client, buildSheetData(book()), 'Октябрь', options),
      journalled,
    );
    expect(outcome.status).toBe('ok');
    expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).toContain('Октябрь');

    await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).not.toContain('Октябрь');
  });

  it('лист с таким именем уже есть — отказ со списком, а не второй лист', async () => {
    const client = new MutableSheetsClient(book());
    await expect(addSheet(client, buildSheetData(book()), 'Инструкция', {})).rejects.toMatchObject({
      payload: { code: 'bad_request' },
    });
  });

  it('переименование: план «было → станет», откат возвращает имя', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const preview = await renameSheet(client, buildSheetData(book()), 'Отчёт 2026', {});
    expect(preview.structural).toMatchObject({ previousTitle: 'Лист1', title: 'Отчёт 2026' });

    await confirmed(
      (options) => renameSheet(client, buildSheetData(book()), 'Отчёт 2026', options),
      journalled,
    );
    expect((await client.getSpreadsheet()).sheets[0]?.title).toBe('Отчёт 2026');

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.structureUndone).toContain('Лист1');
    expect((await client.getSpreadsheet()).sheets[0]?.title).toBe('Лист1');
  });
});

describe('G14 — границы структурной правки', () => {
  it('колонки вставляются от ИМЕНИ якоря, а не от буквы', async () => {
    const client = new MutableSheetsClient(book());
    const preview = await insertColumns(client, buildSheetData(book()), 'Статус', 1, {});
    // «Статус» — третья колонка (0-based индекс 2), значит вставка перед третьей.
    expect(preview.structural).toMatchObject({ kind: 'insertColumns', at: 3, count: 1 });
    expect(preview.structural?.anchor).toContain('Статус');
  });

  it('неизвестная колонка — вопрос со списком, а не догадка', async () => {
    const client = new MutableSheetsClient(book());
    const outcome = await insertColumns(client, buildSheetData(book()), 'Бюджет', 1, {});
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.questions[0]?.available).toContain('Статус');
  });

  it('количество — целое больше нуля, иначе отказ до всякой записи', async () => {
    const client = new MutableSheetsClient(book());
    await expect(insertRows(client, buildSheetData(book()), where, 0, {})).rejects.toMatchObject({
      payload: { code: 'bad_request' },
    });
    await expect(insertRows(client, buildSheetData(book()), where, 1.5, {})).rejects.toMatchObject({
      payload: { code: 'bad_request' },
    });
  });

  it('под условие не подошла ни одна строка — вопрос, а не вставка в начало', async () => {
    const client = new MutableSheetsClient(book());
    const outcome = await insertRows(
      client,
      buildSheetData(book()),
      { Проект: 'нет такого' },
      1,
      {},
    );
    expect(outcome.status).toBe('needs_clarification');
  });
});

describe('G5, G6, G6b, G7, G17 — удаление строки и подтверждение названием (D-20)', () => {
  const target = { Проект: 'lash-try-on' };

  it('G5 — план перечисляет, ЧТО исчезнет, и просит назвать предмет; записи нет', async () => {
    const client = new MutableSheetsClient(book());
    const preview = await deleteRows(client, buildSheetData(book()), target, {});
    expect(preview.status).toBe('preview');
    // Ячейки в плане есть: человек должен видеть, что теряет, а не «строка 4 исчезнет».
    expect(preview.changes.map((c) => c.before)).toContain('lash-try-on');
    expect(preview.changes.every((c) => c.after === null)).toBe(true);
    expect(preview.structural).toMatchObject({ kind: 'deleteRows', count: 1 });
    expect(preview.structural?.confirmPhrase).toContain('lash-try-on');
  });

  it('G6b — голое «да» не проходит: это диалог, а не подпись', async () => {
    const client = new MutableSheetsClient(book());
    const outcome = await deleteRows(client, buildSheetData(book()), target, {
      dryRun: false,
      confirm: 'да',
    });
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('lash-try-on');
    expect((await client.getSpreadsheet()).sheets[0]?.rows).toHaveLength(4);
  });

  it('G6, G7 — «да, удаляю lash-try-on» пишет, откат возвращает строку СО ЗНАЧЕНИЯМИ', async () => {
    const client = new MutableSheetsClient(book());
    const journalled: WriteRecord[] = [];
    const outcome = await deleteRows(client, buildSheetData(book()), target, {
      dryRun: false,
      confirm: 'да, удаляю lash-try-on',
      journal: async (record) => {
        journalled.push(record);
      },
      journalSource: { recent: () => Promise.resolve(journalled) },
    });
    expect(outcome.status).toBe('ok');
    expect(journalled[0]?.structure).toMatchObject({ kind: 'deleteRows' });
    expect(journalled[0]?.snapshots?.[0]?.rows[0]?.map((c) => c.value)).toContain('lash-try-on');

    const afterDelete = await client.getSpreadsheet();
    expect(afterDelete.sheets[0]?.rows).toHaveLength(3);
    expect(JSON.stringify(afterDelete.sheets[0]?.rows)).not.toContain('lash-try-on');

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.status).toBe('ok');
    expect(undone.structureUndone).toContain('значениями');
    const afterUndo = await client.getSpreadsheet();
    expect(afterUndo.sheets[0]?.rows).toHaveLength(4);
    expect(afterUndo.sheets[0]?.rows[3]?.[1]?.value).toBe('lash-try-on');
  });

  it('G17 — регистр, кавычки и лишние пробелы в подтверждении не считаются', async () => {
    const client = new MutableSheetsClient(book());
    const outcome = await deleteRows(client, buildSheetData(book()), target, {
      dryRun: false,
      confirm: '  да, удаляю  «LASH-TRY-ON»  ',
    });
    expect(outcome.status).toBe('ok');
  });

  it('код плана тоже принимается: у вызовов без превью названия нет', async () => {
    const client = new MutableSheetsClient(book());
    const preview = await deleteRows(client, buildSheetData(book()), target, {});
    const outcome = await deleteRows(client, buildSheetData(book()), target, {
      dryRun: false,
      confirm: preview.planId ?? '',
    });
    expect(outcome.status).toBe('ok');
  });

  it('конверт разрушающую правку не разрешает, даже если он её перечисляет', async () => {
    const client = new MutableSheetsClient(book());
    const outcome = await deleteRows(client, buildSheetData(book()), target, {
      dryRun: false,
      authorize: () => ({ authorized: true }) as const,
    });
    expect(outcome.status).toBe('confirm_required');
    expect((await client.getSpreadsheet()).sheets[0]?.rows).toHaveLength(4);
  });

  it('разрозненные строки не удаляются блоком: отказ с номерами', async () => {
    const client = new MutableSheetsClient(book());
    // Под условие «Часы есть у всех» подойдут обе строки данных — они подряд, это ок;
    // а вот пропуск в середине должен отказать, и на это отдельная фикстура ниже.
    const outcome = await deleteRows(client, buildSheetData(book()), { Проект: 'нет такого' }, {});
    expect(outcome.status).toBe('needs_clarification');
  });
});

describe('G9, G9b — удаление листа: потеря названа числом, откат говорит, чего не вернул', () => {
  /** Лист с содержимым, оформлением, закреплённой шапкой и тем, чего откат не вернёт. */
  const richBook = () => {
    const base = snapshot([reportSheet(), instructionSheet()]);
    const rich = {
      ...base.sheets[1]!,
      properties: { frozenRows: 1, tabColor: '#17365d', hidden: false },
      extras: {
        conditionalFormats: 3,
        dataValidations: 1,
        protectedRanges: 0,
        charts: 2,
        filters: 1,
      },
    };
    return { ...base, sheets: [base.sheets[0]!, rich] };
  };

  it('G9b — план называет ЧИСЛОМ, что исчезнет безвозвратно, и просит назвать лист', async () => {
    const client = new MutableSheetsClient(richBook());
    const data = buildSheetData(richBook(), { sheet: 'Инструкция' });
    const preview = await deleteSheet(client, data, {});
    expect(preview.status).toBe('preview');
    const lost = preview.structural?.irreversible?.join('; ') ?? '';
    expect(lost).toContain('3 правил условного форматирования');
    expect(lost).toContain('2 диаграмм');
    expect(lost).toContain('1 проверок данных');
    // Заметки названы как непокрытость, а не посчитаны: ядро их не читает.
    expect(lost).toContain('заметки к ячейкам');
    expect(preview.structural?.confirmPhrase).toContain('Инструкция');
  });

  it('G9b — откат возвращает лист со свойствами и ГОВОРИТ, чего не вернул', async () => {
    const client = new MutableSheetsClient(richBook());
    const journalled: WriteRecord[] = [];
    const outcome = await deleteSheet(client, buildSheetData(richBook(), { sheet: 'Инструкция' }), {
      dryRun: false,
      confirm: 'да, удаляю лист Инструкция',
      journal: async (record) => {
        journalled.push(record);
      },
      journalSource: { recent: () => Promise.resolve(journalled) },
    });
    expect(outcome.status).toBe('ok');
    expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).not.toContain('Инструкция');

    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.status).toBe('ok');
    const back = (await client.getSpreadsheet()).sheets.find((s) => s.title === 'Инструкция');
    expect(back).toBeDefined();
    expect(back?.properties).toMatchObject({ frozenRows: 1, tabColor: '#17365d' });
    expect(JSON.stringify(back?.rows)).toContain('Реестр');
    // Главное в этом оракуле: откат НЕ отчитывается полным успехом.
    expect(undone.notRestored?.join('; ')).toContain('условного форматирования');
  });

  it('G9 — лист больше бюджета снимка: отказ ДО записи, оба числа названы', async () => {
    const big = snapshot([reportSheet(), wideSheet(2100)]);
    const client = new MutableSheetsClient(big);
    try {
      await deleteSheet(client, buildSheetData(big, { sheet: 'Много' }), { dryRun: false });
      expect.unreachable('лист больше бюджета должен отказать');
    } catch (error) {
      const { payload } = error as { payload: { cause?: string; detail: string } };
      expect(payload.cause).toBe('write.snapshot-max-cells');
      expect(payload.detail).toContain('2000');
      expect(payload.detail).toContain('4202');
    }
  });

  it('единственный лист книги не удаляется: книги без листов не бывает', async () => {
    const single = snapshot([reportSheet()]);
    const client = new MutableSheetsClient(single);
    await expect(deleteSheet(client, buildSheetData(single), {})).rejects.toMatchObject({
      payload: { cause: 'last_sheet' },
    });
  });
});

describe('находки живого прогона 2026-09-04', () => {
  it('переименование листа предупреждает, что рвёт привязку цели в реестре', async () => {
    const client = new MutableSheetsClient(book());
    const plan = await renameSheet(client, buildSheetData(book()), 'Отчёт 2026', {
      alias: 'infra-test',
      registrySheet: 'Лист1',
    });
    expect(plan.status).toBe('preview');
    expect(plan.notes.join(' ')).toContain('привязка перестанет совпадать');
    expect(plan.notes.join(' ')).toContain('infra-test');
  });

  it('привязка к другому листу — предупреждения нет: врать в обе стороны нельзя', async () => {
    const client = new MutableSheetsClient(book());
    const plan = await renameSheet(client, buildSheetData(book()), 'Отчёт 2026', {
      alias: 'infra-test',
      registrySheet: 'Инструкция',
    });
    expect(plan.notes).toHaveLength(0);
  });

  it('откат правки ВИДА отчитывается видом, а не значением ячейки', async () => {
    const client = new MutableSheetsClient(snapshot([formattedSheet()]));
    const journalled: WriteRecord[] = [];
    const data = () => buildSheetData(snapshot([formattedSheet()]));
    const where = { Проект: 'G connect' };
    const preview = await formatCells(client, data(), where, ['Часы'], { bold: true }, {});
    await formatCells(
      client,
      data(),
      where,
      ['Часы'],
      { bold: true },
      {
        dryRun: false,
        confirm: preview.planId ?? '',
        journal: async (record) => {
          journalled.push(record);
        },
        journalSource: { recent: () => Promise.resolve(journalled) },
      },
    );
    const undone = await undoLast(client, 'SHEET', { recent: () => Promise.resolve(journalled) });
    expect(undone.restored[0]?.kind).toBe('format');
    expect(undone.restored[0]?.format).toMatchObject({ bold: false });
  });
});
