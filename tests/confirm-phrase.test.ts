/**
 * Фраза подтверждения разрушающей правки — одно правило для таблиц и документов (D-20,
 * поправка 2026-10-02, решение владельца). Фраза НАЗЫВАЕТ ПРЕДМЕТ: у абзаца — первые два
 * слова, у строки таблицы — первая непустая ячейка, у колонки — заголовок, у замены —
 * искомое. Глагол, регистр, «ё» и знаки препинания не считаются; экземпляр правки держит
 * код плана. Повод — живой прогон: пройти могла только фраза «удаляю абзац Устаревший
 * прогноз: Flamengo выиграет» с двоеточием, а «удаляю строку Иванов» не проходила.
 */

import { describe, expect, it } from 'vitest';

import { runDocDelete } from '../src/core/docs/delete-op.js';
import { runDocReplace } from '../src/core/docs/replace-op.js';
import { runDocTable } from '../src/core/docs/table-op.js';
import { namedSubject, type DocRunOptions } from '../src/core/docs/write-support.js';
import type { WriteRecord } from '../src/core/journal.js';
import { namesSubject } from '../src/core/sheets/write-guards.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';
import { named } from './fixtures/named.js';

const journalled: WriteRecord[] = [];
const options = (over: Partial<DocRunOptions> = {}): DocRunOptions => ({
  journal: async (r) => {
    journalled.push(r);
  },
  journalSource: { recent: () => Promise.resolve([...journalled]) },
  account: 'default',
  alias: 'forecast',
  ...over,
});
const fresh = () => {
  journalled.length = 0;
  return new FakeDocsClient(forecastDoc());
};

const deleteDraft = {
  op: 'deleteParagraph',
  tab: 'Черновики',
  where: { paragraphIndex: 1 },
} as const;
const deleteIvanov = { op: 'deleteTableRow', tab: 'Прогноз', rowWithCell: 'Иванов' } as const;

describe('фраза называет предмет — как человек говорит, а не как напечатано', () => {
  it('абзац: «удаляю абзац Устаревший прогноз» — двух слов достаточно, план так и просит', async () => {
    const client = fresh();
    const preview = await runDocDelete(client, await client.getDocument(), deleteDraft, options());
    expect(preview.notes.join(' ')).toContain('«удаляю абзац Устаревший прогноз»');
    const written = await named(
      runDocDelete,
      client,
      deleteDraft,
      'удаляю абзац Устаревший прогноз',
      options,
    );
    expect(written.status).toBe('ok');
  });

  it('пунктуация, кавычки, регистр, «ё» и глагол не считаются', async () => {
    for (const phrase of ['да, «устаревший ПРОГНОЗ»!', 'Устаревший прогноз — удаляй']) {
      const client = fresh();
      const written = await named(runDocDelete, client, deleteDraft, phrase, options);
      expect(written.status, phrase).toBe('ok');
    }
    expect(namesSubject('удаляю строку Пётр', 'Петр')).toBe(true);
  });

  it('строка таблицы называется первой ячейкой — и в падеже тоже', async () => {
    for (const phrase of ['удаляю строку Иванов', 'да, строку с Ивановым']) {
      const client = fresh();
      const written = await named(runDocTable, client, deleteIvanov, phrase, options);
      expect(written.status, phrase).toBe('ok');
    }
  });

  it('массовая замена называется искомым: «да, Fluminense» проходит', async () => {
    const client = fresh();
    const request = { op: 'replaceAllText', find: 'Fluminense', replace: 'Fluminense FC' } as const;
    const written = await named(runDocReplace, client, request, 'да, Fluminense', options);
    expect(written.status).toBe('ok');
  });
});

describe('и при этом не называет чужое', () => {
  it('голое «да» и чужая строка — confirm_required, записи нет', async () => {
    for (const [request, phrase] of [
      [deleteDraft, 'да'],
      [deleteIvanov, 'удаляю строку Петров'],
    ] as const) {
      const client = fresh();
      const run = request.op === 'deleteParagraph' ? runDocDelete : runDocTable;
      const outcome = await named(
        run as typeof runDocTable,
        client,
        request as never,
        phrase,
        options,
      );
      expect(outcome.status, phrase).toBe('confirm_required');
      expect(journalled, phrase).toHaveLength(0);
    }
  });

  it('предмет входит с начала слова; число и короткий предмет — целым словом', () => {
    expect(namesSubject('удаляю строку заИванов', 'Иванов')).toBe(false);
    expect(namesSubject('удаляю строку 12', '1')).toBe(false);
    expect(namesSubject('удаляю строку 1', '1')).toBe(true);
    expect(namesSubject('да, confirm', 'C')).toBe(false);
    expect(namesSubject('удаляю колонку C', 'C')).toBe(true);
    expect(namesSubject('удаляю Черновик 22', 'Черновик 2')).toBe(false);
  });

  it('предмет из слова согласия заменяется номером: абзац «Да.» не подтвердит голое «да»', () => {
    expect(namedSubject(['Да.'], 2, '№ 5')).toBe('№ 5');
    expect(namedSubject([], 2, '№ 5')).toBe('№ 5');
    expect(namedSubject(['Шапка'], 2, '№ 1')).toBe('Шапка');
    // Короткие ячейки добираются следующими: «а» назвало бы что угодно.
    expect(namedSubject(['а', 'б', 'в', 'г'], 1, '№ 2')).toBe('а б в');
  });

  it('у таблиц правило то же: ключ без скобок и плюсов называет строку', () => {
    const key = 'AutoLink Platform (Task 1 + Task 2 Discovery + Task 5 Crowd)';
    expect(
      namesSubject('удаляю строку AutoLink Platform Task 1 Task 2 Discovery Task 5 Crowd', key),
    ).toBe(true);
    expect(namesSubject('удаляю строку AutoLink Platform', key)).toBe(false);
  });
});
