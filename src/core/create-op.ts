/**
 * Создание файлов Drive: таблица, документ, папка (§6.2 — `Ctrl+N`, фаза 2.5b).
 *
 * Проходит через ТОТ ЖЕ контур записи, что правки таблиц: план, подтверждение, строка
 * журнала, откат. Поэтому и появился `WriteContext` — у создания файла карты листа нет
 * вовсе, а код плана и журнал нужны те же.
 *
 * Откат — в корзину Drive (`trashed: true`), и это единственная форма отката, которая нам
 * не принадлежит: достать файл из корзины человек может только сам, в интерфейсе Drive.
 * Ответ отката об этом говорит прямо, а не отчитывается «удалено».
 *
 * Право создавать даёт реестр, как и право писать: цель — ПАПКА с `allow: write`, — или
 * разрешение проекта (D-23): тогда и «Мой диск». Без разрешения созданный файл права записи
 * не получает — в реестре его нет (`write.allowlist`), и это осознанно: иначе агент мог бы
 * расширять себе доступ созданием. Под разрешением он пишется тем же разрешением, до срока.
 */

import { createHash } from 'node:crypto';

import { CREATE_MIME, type CreateKind, type DriveClient } from './google/drive.js';
import { gcError } from './errors.js';
import { limitOf } from './policy.js';
import { finishWrite, type Prepared, type WriteContext } from './sheets/commit.js';
import type { CellValue, SheetsClient } from './sheets/types.js';
import type { ApplyOutcome, RowOptions, StructuralPlan } from './sheets/write-types.js';

const empty = (): Prepared => ({
  resolved: [],
  assumptions: [],
  notes: [],
  questions: [],
  touches: [],
});

const WHAT: Record<CreateKind, string> = {
  sheet: 'таблицу',
  doc: 'документ',
  folder: 'папку',
};

export interface CreateInput {
  readonly kind: CreateKind;
  readonly name: string;
  /** В какой папке создавать. Не задана — корень «Мой диск». */
  readonly parentId?: string;
  readonly parentName?: string;
  /** Шапка и строки новой таблицы (D-23); только у `sheet`. */
  readonly content?: SheetContent;
  /** Созданный файл пишется сразу — разрешение проекта открывает свои файлы до срока. */
  readonly writable?: boolean;
}

export interface SheetContent {
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly CellValue[])[];
  /** Текстом (RAW) — по умолчанию; `false` — как набрал бы человек: даты распознаются. */
  readonly asText: boolean;
}

/** Строки содержимого в одну матрицу: шапка первой строкой. Пусто — содержимого нет. */
function contentMatrix(content: SheetContent | undefined): readonly (readonly CellValue[])[] {
  if (content === undefined) return [];
  return [...(content.columns === undefined ? [] : [content.columns]), ...(content.rows ?? [])];
}

/**
 * Содержимое проверяется ДО создания файла: строка длиннее шапки — вопрос, а не догадка,
 * куда легли лишние значения; больше бюджета изменений — отказ с советом дописать после.
 */
function assertContent(content: SheetContent | undefined): number {
  const width = content?.columns?.length;
  const rows = content?.rows ?? [];
  const tooWide = width === undefined ? -1 : rows.findIndex((row) => row.length > width);
  if (tooWide >= 0) {
    throw gcError('bad_request', {
      detail: `Строка ${tooWide + 1} длиннее шапки (${width} колонок): куда лягут лишние значения — решает человек.`,
      cause: 'row_wider_than_header',
    });
  }
  const cells = contentMatrix(content).reduce((sum, row) => sum + row.length, 0);
  const budget = limitOf('write.max-changes', 200);
  if (cells > budget) {
    throw gcError('bad_request', {
      detail: `Содержимое — ${cells} ячеек при бюджете ${budget} на одну правку: создай таблицу с шапкой и допиши строки после (appendRow).`,
      cause: 'change_budget',
    });
  }
  return cells;
}

/** Сверка содержимого для кода плана: человек подтверждает именно эти строки. */
const contentDigest = (content: SheetContent): string =>
  createHash('sha256')
    .update(JSON.stringify([contentMatrix(content), content.asText]))
    .digest('hex')
    .slice(0, 12);

/** Что запишется — человеку в превью: шапка и первые строки, без «и т. д.» молчком. */
function contentNotes(content: SheetContent): string[] {
  const rows = content.rows ?? [];
  const shown = rows.slice(0, 10).map((row) => `  ${row.map((v) => String(v ?? '')).join(' | ')}`);
  return [
    ...(content.columns === undefined ? [] : [`Шапка: ${content.columns.join(' | ')}`]),
    ...(rows.length === 0
      ? []
      : [`Строк: ${rows.length}${content.asText ? ', текстом (RAW)' : ''}:`, ...shown]),
    ...(rows.length > shown.length ? [`  …и ещё ${rows.length - shown.length}`] : []),
  ];
}

/**
 * Создать файл или папку. Ссылка на созданное уезжает в `notes` ответа: человеку нужна
 * ссылка, а не только «готово», и id файла попадает в журнал — им и откатывают.
 */
export async function createFile(
  sheets: SheetsClient,
  drive: DriveClient,
  input: CreateInput,
  options: RowOptions = {},
): Promise<ApplyOutcome> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw gcError('bad_request', { detail: 'Имя создаваемого файла не может быть пустым.' });
  }
  const { structural, content, cells } = createPlan(input, name);
  // Контекст записи для файла, которого ещё нет: цель — папка (или корень), «лист» — имя.
  const context: WriteContext = {
    targetId: input.parentId ?? 'root',
    sheet: name,
    sheetId: 0,
    revisionId: null,
  };
  // Ссылка и id появляются только по факту записи: до неё их не существует, и обещать
  // их в плане значило бы обещать то, чего ещё нет.
  const created: { id?: string; url?: string } = {};
  const prepared = { ...empty(), notes: content === undefined ? [] : contentNotes(content) };
  const outcome = await finishWrite(sheets, context, [], prepared, options, 'createFile', {
    structural,
    // Конверт судит ЗАПИСЫВАЕМЫЕ ячейки: таблица на двести строк с первой фразы мимо
    // границы конверта прошла бы, считай мы только сам факт создания.
    ...(content === undefined ? {} : { cells }),
    apply: async () => {
      const file = await drive.create(input.kind, name, input.parentId);
      created.id = file.id;
      created.url = file.url;
      if (content !== undefined) await writeContent(sheets, drive, file, content);
      return { fileId: file.id };
    },
  });
  if (outcome.status !== 'ok') return outcome;
  return { ...outcome, notes: [...outcome.notes, ...createdNotes(input, name, created)] };
}

/** План создания: что и где, сверка содержимого и сколько ячеек оно запишет. */
function createPlan(
  input: CreateInput,
  name: string,
): { structural: StructuralPlan; content: SheetContent | undefined; cells: number } {
  const where =
    input.parentName ?? (input.parentId === undefined ? 'корень «Мой диск»' : input.parentId);
  const cells = assertContent(input.content);
  const content = cells > 0 ? input.content : undefined;
  return {
    structural: {
      kind: 'createFile',
      sheet: name,
      title: name,
      anchor: `${WHAT[input.kind]} «${name}» в ${where}`,
      ...(content === undefined ? {} : { content: contentDigest(content) }),
    },
    content,
    cells,
  };
}

/** Что сказать человеку после создания: ссылка, право писать в созданное, цена отката. */
function createdNotes(
  input: CreateInput,
  name: string,
  created: { readonly id?: string; readonly url?: string },
): string[] {
  const link = created.url === undefined ? '' : `, ссылка: ${created.url}`;
  const id = created.id === undefined ? '' : ` Id: ${created.id}.`;
  return [
    `Создано: ${WHAT[input.kind]} «${name}»${link}.`,
    input.writable === true
      ? 'Под разрешением проекта новый файл пишется сразу — до срока разрешения.'
      : 'Права записи у нового файла нет: их даёт реестр целей или разрешение проекта. ' +
        'Добавь его в реестр, если собираешься в него писать.',
    `Откат отправит файл в корзину Drive; достать оттуда — руками, в интерфейсе Drive.${id}`,
  ];
}

/**
 * Шапка и строки — в первый лист новой таблицы (диапазон без имени листа: «Лист1» или
 * «Sheet1» зависит от языка аккаунта). Сбой записи содержимого не оставляет сироту: файл
 * без строки журнала `gc_undo` не нашёл бы, поэтому он уходит в корзину; не ушёл и туда —
 * человек получает ссылку, а не тишину.
 */
async function writeContent(
  sheets: SheetsClient,
  drive: DriveClient,
  file: { readonly id: string; readonly url: string },
  content: SheetContent,
): Promise<void> {
  try {
    await sheets.updateValues(
      file.id,
      'A1',
      contentMatrix(content),
      content.asText ? 'raw' : 'user',
    );
  } catch (error) {
    const trashed = await drive.trash(file.id).then(
      () => true,
      () => false,
    );
    if (trashed) throw error;
    throw gcError('write_outcome_unknown', {
      detail:
        `Таблица создана, а шапка и строки не записались, и в корзину она не ушла: ${file.url}. ` +
        'Удали её руками или допиши содержимое.',
      cause: 'create_content_failed',
    });
  }
}

/** mimeType по типу — для сообщений человеку и для проверки в тестах. */
export const mimeOf = (kind: CreateKind): string => CREATE_MIME[kind];
