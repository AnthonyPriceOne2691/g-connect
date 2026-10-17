/**
 * Селекторы документа (уровень 3, слайс 2): P10, границы разделов (L16), таблицы.
 * Фикстура — «Прогноз на матч»: слово «прогноз» нарочно живёт в нескольких абзацах.
 */

import { describe, expect, it } from 'vitest';

import {
  paragraphLabel,
  resolveParagraph,
  resolveSection,
  resolveTable,
} from '../src/core/docs/selectors.js';
import { buildDoc, forecastDoc, p } from './fixtures/doc.js';

const forecast = forecastDoc().tabs[0]!;
const drafts = forecastDoc().tabs[1]!;

describe('P10 — неоднозначный селектор — вопрос с кандидатами', () => {
  it('textContains «прогноз» совпал с несколькими абзацами: вопрос, кандидаты с №', () => {
    const result = resolveParagraph(forecast, { textContains: 'прогноз' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('ambiguous');
    expect(result.question.detail).toContain('уточни');
    expect(result.question.candidates.length).toBeGreaterThan(1);
    expect(result.question.candidates[0]).toMatch(/^№ \d+: /);
    // Кандидаты — ИМЕННО совпавшие абзацы, а не первые попавшиеся (находка читателя).
    const matched = forecast.paragraphs
      .filter((x) => x.text.toLowerCase().includes('прогноз'))
      .map((x) => x.index);
    const named = result.question.candidates.map((c) => Number(/^№ (\d+):/.exec(c)![1]));
    expect(named).toEqual(matched.slice(0, named.length));
  });

  it('одно совпадение — абзац без вопросов', () => {
    const result = resolveParagraph(forecast, { textStartsWith: 'Ставим на победу' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.text).toContain('2:1');
  });

  it('пустое совпадение — ближайшие кандидаты, а не голое «нет»', () => {
    const result = resolveParagraph(forecast, { textStartsWith: 'Составы команд на матч' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('no_match');
    expect(result.question.candidates.join(' ')).toContain('Составы');
  });

  it('сравнение нормализовано: регистр и латинская «C» в кириллице не мешают', () => {
    const result = resolveParagraph(forecast, { textStartsWith: 'соСтавы' });
    expect(result.status).toBe('ok');
  });

  it('paragraphIndex вне диапазона называет, сколько абзацев есть', () => {
    const result = resolveParagraph(drafts, { paragraphIndex: 99 });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.detail).toContain('их 2');
  });

  it('first/lastParagraph берут абзацы тела, а не ячейки таблиц', () => {
    const first = resolveParagraph(forecast, { firstParagraph: true });
    const last = resolveParagraph(forecast, { lastParagraph: true });
    expect(first.status).toBe('ok');
    expect(last.status).toBe('ok');
    if (first.status !== 'ok' || last.status !== 'ok') return;
    expect(first.value.namedStyle).toBe('HEADING_1');
    expect(last.value.text).toContain('Ставим на победу');
    expect(last.value.inTable).toBeUndefined();
  });
});

describe('раздел заголовка — граница по следующему заголовку, не по счётчику (L16)', () => {
  it('раздел «Составы» кончается перед «Прогноз» и включает таблицу', () => {
    const result = resolveSection(forecast, 'Составы');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.heading.text).toBe('Составы');
    const texts = result.value.paragraphs.map((p) => p.text);
    expect(texts[0]).toContain('Основа выйдет');
    expect(texts).toContain('Иванов'); // содержимое таблицы — в разделе
    expect(texts).not.toContain('Прогноз'); // следующий H2 — уже не раздел
    const lastOfSection = result.value.paragraphs[result.value.paragraphs.length - 1]!;
    expect(result.value.endIndex).toBeGreaterThanOrEqual(lastOfSection.endIndex);
  });

  it('младший заголовок раздел не закрывает, старший — закрывает', () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            p('Раздел', 'HEADING_2'),
            p('текст раздела'),
            p('Подраздел', 'HEADING_3'),
            p('текст подраздела'),
            p('Соседний раздел', 'HEADING_2'),
            p('чужой текст'),
          ],
        },
      ],
    });
    const result = resolveSection(doc.tabs[0]!, 'Раздел');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const texts = result.value.paragraphs.map((p) => p.text);
    expect(texts).toEqual(['текст раздела', 'Подраздел', 'текст подраздела']);
  });

  it('раздел H2 закрывает и следующий H1 (старший), а не только H2 того же уровня', () => {
    // В фикстуре P16 раздел закрывал заголовок ТОГО ЖЕ уровня — мутация «<=» → «===» в
    // границе выживала (находка читателя 2026-10-01).
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [
            p('Раздел', 'HEADING_2'),
            p('текст раздела'),
            p('Глава', 'HEADING_1'),
            p('текст главы'),
          ],
        },
      ],
    });
    const result = resolveSection(doc.tabs[0]!, 'Раздел');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.paragraphs.map((x) => x.text)).toEqual(['текст раздела']);
  });

  it('нет такого заголовка — вопрос со списком заголовков', () => {
    const result = resolveSection(forecast, 'Травмы');
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.available).toContain('Составы');
  });
});

describe('таблица по номеру и по якорю ячейки', () => {
  it('по содержимому ячейки', () => {
    const result = resolveTable(forecast, { tableWithCell: 'Иванов' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.rows).toBe(4);
  });

  it('несуществующий номер называет, сколько таблиц есть, с их шапками', () => {
    const result = resolveTable(forecast, { table: 3 });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.detail).toContain('их 1');
    expect(result.question.candidates[0]).toContain('Игрок');
  });

  it('якорь в двух таблицах — вопрос с номерами', () => {
    const doc = buildDoc({
      tabs: [
        {
          title: 'Т',
          content: [{ table: [['Иванов', 'да']] }, { table: [['Иванов', 'нет']] }],
        },
      ],
    });
    const result = resolveTable(doc.tabs[0]!, { tableWithCell: 'Иванов' });
    expect(result.status).toBe('question');
    if (result.status !== 'question') return;
    expect(result.question.reason).toBe('ambiguous');
    expect(result.question.candidates).toHaveLength(2);
  });
});

describe('подпись кандидата', () => {
  it('длинный абзац усечён по словам', () => {
    const doc = buildDoc({
      tabs: [{ title: 'Т', content: [p('одно два три четыре пять шесть семь восемь')] }],
    });
    expect(paragraphLabel(doc.tabs[0]!.paragraphs[0]!)).toBe(
      '№ 1: одно два три четыре пять шесть…',
    );
  });
});
