/**
 * Конверт документов (уровень 3, слайс 5): P20. Мера — UTF-16-юниты (maxChars),
 * разрушающие doc-операции в конверт не кладутся уже сейчас, до их реализации.
 */

import { describe, expect, it } from 'vitest';

import { parseEnvelope } from '../src/core/envelope.js';
import { gcApply, type ToolDeps } from '../src/mcp/tools.js';
import type { Registry } from '../src/core/targets.js';
import type { WriteRecord } from '../src/core/journal.js';
import { FakeDocsClient, forecastDoc } from './fixtures/doc.js';
import { callMcp } from './fixtures/protocol.js';

/** Данные ответа `gc_apply` через протокол — так, как их видит клиент (T41). */
const applyData = async (args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> =>
  (await callMcp(gcApply, args, deps)).data;

const DOC_ID = 'DOC0000000000000000001';

function harness(auto: unknown) {
  const docs = new FakeDocsClient(forecastDoc());
  const journalled: WriteRecord[] = [];
  const registry: Registry = {
    targets: [{ alias: 'forecast', id: DOC_ID, type: 'doc', allow: 'write', auto }],
  };
  const deps: ToolDeps = {
    account: 'default',
    sheets: () => Promise.reject(new Error('Sheets не нужен')),
    docs: () => Promise.resolve(docs),
    drive: () => Promise.reject(new Error('Drive не нужен')),
    registry: () => Promise.resolve(registry),
    journal: async (r) => {
      journalled.push(r);
    },
    journalSource: { recent: () => Promise.resolve(journalled) },
    revision: () => Promise.resolve('rev-1'),
  };
  return { deps, docs, journalled };
}

describe('P20 — конверт doc-цели', () => {
  it('appendText в конверте и в пределах maxChars — пишется с первой фразы, без кода', async () => {
    const { deps, docs, journalled } = harness({ ops: ['appendText'], maxChars: 1000 });
    const outcome = (await applyData(
      {
        op: 'appendText',
        target: 'forecast',
        tab: 'Черновики',
        text: 'Идея на завтра',
        dryRun: false,
      },
      deps,
    )) as { status: string };
    expect(outcome.status).toBe('ok');
    expect(journalled).toHaveLength(1);
    expect((await docs.getDocument()).tabs[1]!.paragraphs.map((p) => p.text)).toContain(
      'Идея на завтра',
    );
  });

  it('вставка больше maxChars — вытолкнута в план с кодом, причина названа', async () => {
    const { deps, journalled } = harness({ ops: ['appendText'], maxChars: 20 });
    const outcome = (await applyData(
      {
        op: 'appendText',
        target: 'forecast',
        tab: 'Черновики',
        text: 'Очень длинный текст, который в конверт не помещается никак',
        dryRun: false,
      },
      deps,
    )) as { status: string; notes: string[] };
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('maxChars');
    expect(journalled).toHaveLength(0);
  });

  it('мера документов — юниты, а не ячейки: крошечный maxCells doc-операцию не судит', async () => {
    // Обратный прогон нашёл слепоту: пороги мер совпадали, и подмена меры была невидима.
    // Здесь maxCells=1 задушил бы вставку, если бы судил её; судить обязан maxChars.
    const { deps, journalled } = harness({ ops: ['appendText'], maxCells: 1, maxChars: 1000 });
    const outcome = (await applyData(
      {
        op: 'appendText',
        target: 'forecast',
        tab: 'Черновики',
        text: 'Сто юнитов текста легко проходят конверт документов, хотя ячейкам тут не место',
        dryRun: false,
      },
      deps,
    )) as { status: string };
    expect(outcome.status).toBe('ok');
    expect(journalled).toHaveLength(1);
  });

  it('insertText вне списка ops конверта — план с кодом, причина называет состав', async () => {
    const { deps } = harness({ ops: ['appendText'] });
    const outcome = (await applyData(
      {
        op: 'insertText',
        target: 'forecast',
        tab: 'Прогноз',
        text: 'х',
        where: { textStartsWith: 'Ставим' },
        dryRun: false,
      },
      deps,
    )) as { status: string; notes: string[] };
    expect(outcome.status).toBe('confirm_required');
    expect(outcome.notes.join(' ')).toContain('appendText');
  });

  it('Z6: подсветка фразы через gc_apply — мера её юниты: 10 проходят maxChars 20, абзац — нет', async () => {
    const { deps, docs } = harness({ ops: ['updateTextStyle'], maxChars: 20 });
    const args = {
      op: 'updateTextStyle',
      target: 'forecast',
      tab: 'Прогноз',
      where: { textStartsWith: 'Ставим' },
      style: { background: '#fff2cc' },
      dryRun: false,
    };
    const whole = (await applyData(args, deps)) as { status: string; notes: string[] };
    expect(whole.status).toBe('confirm_required');
    expect(whole.notes.join(' ')).toContain('Правка трогает 43 юнитов текста');
    const piece = (await applyData({ ...args, fragment: 'Fluminense' }, deps)) as {
      status: string;
    };
    expect(piece.status).toBe('ok');
    const sent = docs.applied.flat() as { startIndex: number; endIndex: number }[];
    expect(sent.map((request) => request.endIndex - request.startIndex)).toEqual([10]);
    // Вид абзаца идёт той же разводкой, но style и fragment ему не передаются вовсе.
    const view = { op: 'setParagraphStyle', target: 'forecast', tab: 'Прогноз', where: args.where };
    const outcome = await applyData({ ...view, namedStyle: 'HEADING_2' }, deps);
    expect(outcome).toMatchObject({ status: 'preview' });
  });
});

describe('разрушающие doc-операции в конверт не кладутся — уже сейчас (D-20)', () => {
  it.each(['deleteParagraph', 'deleteTable', 'replaceAllText'])('%s отклоняется разбором', (op) => {
    try {
      parseEnvelope({ ops: [op] }, 'forecast');
      expect.unreachable('конверт обязан быть отклонён');
    } catch (error) {
      const payload = (error as { payload: { detail: string } }).payload;
      expect(payload.detail).toContain('названием');
      expect(payload.detail).toContain(op);
    }
  });

  it('maxChars по умолчанию 1000; выше бюджета снимка — отказ разбора', () => {
    expect(parseEnvelope({ ops: ['appendText'] }, 'f')?.maxChars).toBe(1000);
    try {
      parseEnvelope({ ops: ['appendText'], maxChars: 30000 }, 'f');
      expect.unreachable('потолок обязан отклонить');
    } catch (error) {
      expect((error as { payload: { detail: string } }).payload.detail).toContain(
        'snapshot-max-chars',
      );
    }
  });
});
