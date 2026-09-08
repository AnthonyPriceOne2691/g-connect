/**
 * Запись в документ (уровень 3, слайс 3): перевод доменного запроса в форму библиотеки,
 * серверное предусловие ревизией (P16) и семантика правок фейка — всё по числам и
 * формулировкам документации Docs API (уроки L3, L23).
 */

import { describe, expect, it } from 'vitest';

import { toDocRequest } from '../src/core/google/doc-requests.js';
import { isGcError } from '../src/core/errors.js';
import { FakeDocsClient, buildDoc, forecastDoc, p, runs } from './fixtures/doc.js';

const singleTab = () =>
  buildDoc({
    tabs: [
      {
        title: 'Один',
        content: [
          p('Первый абзац'),
          runs({ text: 'Жирный ', style: { bold: true } }, { text: 'хвост' }),
          p('Третий абзац'),
        ],
      },
    ],
  });

describe('перевод доменного запроса → запрос библиотеки (числа из документации)', () => {
  it('insertText: позиция и tabId внутри location', () => {
    expect(
      toDocRequest({ kind: 'insertText', tabId: 't1', at: 14, text: 'Судья: Раморенко' }),
    ).toEqual({ insertText: { location: { index: 14, tabId: 't1' }, text: 'Судья: Раморенко' } });
  });

  it('deleteRange: полуинтервал [startIndex, endIndex) с tabId внутри range', () => {
    expect(toDocRequest({ kind: 'deleteRange', tabId: 't2', startIndex: 5, endIndex: 12 })).toEqual(
      {
        deleteContentRange: { range: { startIndex: 5, endIndex: 12, tabId: 't2' } },
      },
    );
  });
});

describe('P16-ядро — предусловие ревизией: отказ целиком, ни одной правки', () => {
  it('несовпадающая ревизия — doc_changed, документ не изменился', async () => {
    const client = new FakeDocsClient(singleTab());
    await expect(
      client.batchUpdate('d', [{ kind: 'insertText', tabId: 't1', at: 1, text: 'x' }], 'rev-0'),
    ).rejects.toMatchObject({ payload: { code: 'doc_changed' } });
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs[0]!.text).toBe('Первый абзац');
    expect(after.revisionId).toBe('rev-1');
  });

  it('совпавшая ревизия — запись идёт, ревизия растёт и возвращается новая', async () => {
    const client = new FakeDocsClient(singleTab());
    const { revisionId } = await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: 1, text: 'Ново: ' }],
      'rev-1',
    );
    expect(revisionId).toBe('rev-2');
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs[0]!.text).toBe('Ново: Первый абзац');
    expect(after.revisionId).toBe('rev-2');
  });
});

describe('семантика правок фейка — по документации', () => {
  it('P17 — вставка сдвигает индексы на длину текста в UTF-16 (эмодзи = 2), не внутрь пары', async () => {
    const client = new FakeDocsClient(singleTab());
    const before = await client.getDocument();
    const third = before.tabs[0]!.paragraphs[2]!;
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: 1, text: '😀!' }],
      'rev-1',
    );
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs[2]!.startIndex).toBe(third.startIndex + 3);
    expect(after.tabs[0]!.paragraphs[0]!.text).toBe('😀!Первый абзац');
  });

  it('вставленный текст наследует стиль прогона слева от точки вставки', async () => {
    const client = new FakeDocsClient(singleTab());
    const before = await client.getDocument();
    const second = before.tabs[0]!.paragraphs[1]!; // «Жирный хвост»
    // Вставка внутри жирного прогона: после «Жирный » (7 юнитов).
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: second.startIndex + 7, text: 'очень ' }],
      'rev-1',
    );
    const after = await client.getDocument();
    const paragraph = after.tabs[0]!.paragraphs[1]!;
    expect(paragraph.text).toBe('Жирный очень хвост');
    expect(
      paragraph.runs
        .filter((r) => r.style?.bold === true)
        .map((r) => r.text)
        .join(''),
    ).toBe('Жирный очень ');
  });

  it('перенос строки во вставке создаёт новый абзац со стилем исходного', async () => {
    const doc = buildDoc({
      tabs: [{ title: 'Т', content: [p('Заголовок', 'HEADING_2'), p('хвост')] }],
    });
    const client = new FakeDocsClient(doc);
    const heading = (await client.getDocument()).tabs[0]!.paragraphs[0]!;
    await client.batchUpdate(
      'd',
      [{ kind: 'insertText', tabId: 't1', at: heading.endIndex - 1, text: '\nНовый абзац' }],
      'rev-1',
    );
    const after = await client.getDocument();
    const texts = after.tabs[0]!.paragraphs.map((x) => x.text);
    expect(texts).toEqual(['Заголовок', 'Новый абзац', 'хвост']);
    // Стиль абзаца наследуется от исходного — оба HEADING_2 (так делает Google).
    expect(after.tabs[0]!.paragraphs[1]!.namedStyle).toBe('HEADING_2');
  });

  it('удаление внутри абзаца вырезает кусок, соседние абзацы не тронуты', async () => {
    const client = new FakeDocsClient(singleTab());
    const first = (await client.getDocument()).tabs[0]!.paragraphs[0]!;
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'deleteRange',
          tabId: 't1',
          startIndex: first.startIndex,
          endIndex: first.startIndex + 7,
        },
      ],
      'rev-1',
    );
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs.map((x) => x.text)).toEqual([
      'абзац',
      'Жирный хвост',
      'Третий абзац',
    ]);
  });

  it('удаление через границу абзацев склеивает их, стили выживших прогонов целы', async () => {
    const client = new FakeDocsClient(singleTab());
    const before = await client.getDocument();
    const first = before.tabs[0]!.paragraphs[0]!;
    const second = before.tabs[0]!.paragraphs[1]!;
    // От середины первого до середины второго: «абзац\nЖирный » исчезает.
    await client.batchUpdate(
      'd',
      [
        {
          kind: 'deleteRange',
          tabId: 't1',
          startIndex: first.startIndex + 7,
          endIndex: second.startIndex + 7,
        },
      ],
      'rev-1',
    );
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs.map((x) => x.text)).toEqual(['Первый хвост', 'Третий абзац']);
    expect(after.tabs[0]!.paragraphs[0]!.runs.some((r) => r.style?.bold === true)).toBe(false);
  });

  it('диапазон, пересекающий таблицу, отклоняется — как отклонил бы Google', async () => {
    const client = new FakeDocsClient(forecastDoc());
    const tab = (await client.getDocument()).tabs[0]!;
    const table = tab.tables[0]!;
    await expect(
      client.batchUpdate(
        'd',
        [
          {
            kind: 'deleteRange',
            tabId: tab.tabId,
            startIndex: table.startIndex - 2,
            endIndex: table.startIndex + 5,
          },
        ],
        'rev-forecast-1',
      ),
    ).rejects.toSatisfy((e: unknown) => isGcError(e) && e.payload.code === 'bad_request');
  });

  it('завершающий перенос последнего абзаца сегмента удалить нельзя', async () => {
    const client = new FakeDocsClient(singleTab());
    const tab = (await client.getDocument()).tabs[0]!;
    const last = tab.paragraphs[tab.paragraphs.length - 1]!;
    await expect(
      client.batchUpdate(
        'd',
        [
          {
            kind: 'deleteRange',
            tabId: tab.tabId,
            startIndex: last.startIndex,
            endIndex: last.endIndex,
          },
        ],
        'rev-1',
      ),
    ).rejects.toSatisfy((e: unknown) => isGcError(e) && e.payload.code === 'bad_request');
  });

  it('пакет применяется по порядку: второй запрос видит сдвинутые индексы', async () => {
    const client = new FakeDocsClient(singleTab());
    await client.batchUpdate(
      'd',
      [
        { kind: 'insertText', tabId: 't1', at: 1, text: 'AB' },
        // После вставки «AB» прежняя позиция 1 стала 3 — вставляем туда же по-новому.
        { kind: 'insertText', tabId: 't1', at: 3, text: 'CD' },
      ],
      'rev-1',
    );
    const after = await client.getDocument();
    expect(after.tabs[0]!.paragraphs[0]!.text).toBe('ABCDПервый абзац');
  });
});
