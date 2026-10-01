/**
 * Встроенные объекты абзаца глазами человека и селектора.
 *
 * В снимке объект стоит знаком OBJECT_MARK — так индексы текста равны индексам Google. Но
 * человеку знак ничего не говорит, а селектор «Фото: подпись» не должен спотыкаться о
 * картинку посередине. Отсюда два вида текста: ПОКАЗАННЫЙ (объект — меткой «[картинка]»)
 * и ВИДИМЫЙ (знаки убраны) — для сравнения с тем, что человек набрал.
 */

import { OBJECT_MARK, type DocObjectKind, type DocTextRun } from './types.js';

const LABELS: Readonly<Record<DocObjectKind, string>> = {
  image: '[картинка]',
  person: '[@чип]',
  date: '[дата]',
  pageBreak: '[разрыв страницы]',
  columnBreak: '[разрыв колонки]',
  footnote: '[сноска]',
  equation: '[формула]',
  richLink: '[ссылка-чип]',
  autoText: '[автотекст]',
  horizontalRule: '[линия]',
};

/** Текст для показа человеку: объекты — метками. */
export const shownText = (runs: readonly DocTextRun[]): string =>
  runs.map((r) => (r.object === undefined ? r.text : LABELS[r.object])).join('');

/** Текст для сравнения с набранным человеком: знаки объектов убраны. */
export const visibleText = (text: string): string => text.split(OBJECT_MARK).join('');

/** Объекты среди прогонов — метками, для отказа «откат их не вернёт». */
export const objectLabels = (runs: readonly DocTextRun[]): string[] =>
  runs.flatMap((r) => (r.object === undefined ? [] : [LABELS[r.object]]));
