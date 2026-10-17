/**
 * Карта документа (P21): оглавление, таблицы, счётчики, предупреждения.
 * Фикстура — «Прогноз на матч» из spec.md: 2 таба, таблица составов, эмодзи, стили.
 */

import { describe, expect, it } from 'vitest';

import { buildDocMap } from '../src/core/docs/map.js';
import { buildDoc, forecastDoc, p } from './fixtures/doc.js';

describe('P21 — карта документа', () => {
  const map = buildDocMap(forecastDoc());

  it('табы: заголовок, id, счётчики', () => {
    expect(map.tabs.map((t) => t.title)).toEqual(['Прогноз', 'Черновики']);
    expect(map.revisionId).toBe('rev-forecast-1');
    const first = map.tabs[0]!;
    // 6 абзацев тела + 12 абзацев ячеек таблицы
    expect(first.paragraphs).toBe(18);
    expect(first.chars).toBeGreaterThan(100);
  });

  it('оглавление: уровень, текст, № абзаца — абзацы ячеек не заголовки', () => {
    expect(map.tabs[0]!.headings).toEqual([
      { level: 1, text: 'Прогноз на матч Fluminense — Palmeiras', paragraph: 1 },
      { level: 2, text: 'Составы', paragraph: 3 },
      { level: 2, text: 'Прогноз', paragraph: 17 },
    ]);
    expect(map.tabs[1]!.headings).toEqual([]);
  });

  it('таблицы: номер, размер, первая строка как имя', () => {
    expect(map.tabs[0]!.tables).toEqual([
      { n: 1, rows: 4, columns: 3, firstRow: ['Игрок', 'Позиция', 'Статус'] },
    ]);
  });

  it('предупреждение о suggestions — только когда они есть', () => {
    expect(map.warnings).toEqual([]);
    const withSuggestions = buildDocMap({ ...forecastDoc(), hasSuggestions: true });
    expect(withSuggestions.warnings.join(' ')).toContain('предложения');
  });

  it('скрытые сегменты названы числом, пустой документ назван пустым', () => {
    const withHeaders = buildDocMap({ ...forecastDoc(), headerCount: 1, footnoteCount: 2 });
    const text = withHeaders.warnings.join(' ');
    expect(text).toContain('колонтитулы верхние: 1');
    expect(text).toContain('сноски: 2');
    const empty = buildDocMap(buildDoc({ tabs: [{ title: 'Пустой', content: [] }] }));
    expect(empty.warnings.join(' ')).toContain('пуст');
  });

  it('превью — первые слова первых абзацев тела, длинный абзац усечён', () => {
    const long = buildDocMap(
      buildDoc({
        tabs: [
          {
            title: 'Т',
            content: [p('одно два три четыре пять шесть семь восемь девять десять')],
          },
        ],
      }),
    );
    expect(long.tabs[0]!.preview[0]).toBe('одно два три четыре пять шесть семь восемь…');
    expect(map.tabs[1]!.preview[0]).toContain('Устаревший прогноз');
  });
});
