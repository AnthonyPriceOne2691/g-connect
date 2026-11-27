/**
 * Комментарии Google к документу через `gc_read mode=comments` (27.11, весть сессии профиля work:
 * заказчик ответил комментариями, а gc_read их не видел). Z1 — ветки с ответами и место по цитате,
 * Z2 — честные статусы места, Z3 — шов Drive (fields, страницы, удалённое, цитата text/html),
 * Z4 — таблица и прочие цели, Z5 — ошибки Drive.
 */

import type { drive_v3 } from 'googleapis';
import { describe, expect, it } from 'vitest';

import type { GcErrorPayload } from '../src/core/errors.js';
import { isGcError } from '../src/core/errors.js';
import { COMMENT_FIELDS, type FileComment } from '../src/core/google/drive-comments.js';
import { GoogleDriveClient } from '../src/core/google/drive.js';
import type { Registry } from '../src/core/targets.js';
import { gcRead, type ToolDeps, type ToolResult } from '../src/mcp/tools.js';
import { placeFinder } from '../src/core/docs/comment-place.js';
import { FakeDocsClient, buildDoc, forecastDoc, p } from './fixtures/doc.js';
import { FakeDriveClient } from './fixtures/drive.js';
import { callMcp } from './fixtures/protocol.js';
import { FakeSheetsClient, reportSheet } from './fixtures/sheet.js';

const DOC_ID = 'DOC0000000000000000001';
const SHEET_ID = 'SHEET00000000000000001';
const FOLDER_ID = 'FOLDER0000000000000001';

const registry: Registry = {
  targets: [
    { alias: 'forecast', id: DOC_ID, type: 'doc', allow: 'read' },
    { alias: 'log', id: SHEET_ID, type: 'sheet', allow: 'read', sheet: 'Лист1' },
    { alias: 'box', id: FOLDER_ID, type: 'folder', allow: 'read' },
  ],
};

const comment = (id: string, quote: string | undefined, extra: Partial<FileComment> = {}) =>
  ({
    id,
    author: 'Заказчик',
    me: false,
    createdTime: '2026-11-26T10:00:00.000Z',
    modifiedTime: '2026-11-26T10:05:00.000Z',
    text: `Комментарий ${id}`,
    resolved: false,
    ...(quote === undefined ? {} : { quote }),
    replies: [],
    ...extra,
  }) satisfies FileComment;

const deps = (drive: FakeDriveClient): ToolDeps => ({
  account: 'work',
  sheets: () =>
    Promise.resolve(
      new FakeSheetsClient({
        id: SHEET_ID,
        title: 'Книга',
        sheets: [reportSheet()],
        revisionId: 'r',
      }),
    ),
  docs: () => Promise.resolve(new FakeDocsClient(forecastDoc())),
  drive: () => Promise.resolve(drive),
  registry: () => Promise.resolve(registry),
  journal: () => Promise.resolve(),
  journalSource: { recent: () => Promise.resolve([]) },
  revision: () => Promise.resolve('rev-1'),
});

const read = async (args: Record<string, unknown>, drive: FakeDriveClient): Promise<ToolResult> => {
  try {
    return await callMcp(gcRead, { mode: 'comments', ...args }, deps(drive));
  } catch (error) {
    if (isGcError(error)) return { ok: false, error: error.payload };
    throw error;
  }
};

interface Shown {
  doc?: string;
  total: number;
  open: number;
  truncated: boolean;
  warnings?: string[];
  comments: { kind: string; origin: string; value: Record<string, unknown>[] };
}

const withComments = (list: FileComment[], id = DOC_ID): FakeDriveClient => {
  const drive = new FakeDriveClient();
  drive.comments.set(id, list);
  return drive;
};

const shown = async (args: Record<string, unknown>, list: FileComment[]): Promise<Shown> => {
  const result = await read(args, withComments(list));
  expect(result.ok).toBe(true);
  return result.data as Shown;
};

/** № абзаца таба «Прогноз» по его тексту — нумерация та же, что у mode=text. */
const paragraphOf = (text: string, tab = 0): number => {
  const found = forecastDoc().tabs[tab]?.paragraphs.find((p) => p.text === text);
  if (found === undefined) throw new Error(`нет абзаца «${text}»`);
  return found.index;
};

describe('Z1 — gc_read mode=comments: ветки, ответы и абзац по цитате', () => {
  it('отдаёт комментарий с автором, временем, цитатой, ответами и местом — ДАННЫМИ', async () => {
    const thread = comment('c1', 'перед дерби', {
      replies: [
        {
          id: 'r1',
          author: 'Агент',
          me: true,
          createdTime: '2026-11-26T11:00:00.000Z',
          modifiedTime: '2026-11-26T11:00:00.000Z',
          text: 'Поправил',
        },
        {
          id: 'r2',
          author: 'Заказчик',
          me: false,
          createdTime: '2026-11-26T12:00:00.000Z',
          modifiedTime: null,
          text: '',
          action: 'resolve',
        },
      ],
      resolved: true,
    });
    const data = await shown({ target: 'forecast' }, [thread, comment('c2', undefined)]);
    expect(data).toMatchObject({ doc: 'Прогноз на матч', total: 2, open: 1, truncated: false });
    expect(data.comments.kind).toBe('data');
    expect(data.comments.origin).toBe(`комментарии к файлу ${DOC_ID}`);
    expect(data.comments.value[0]).toEqual({
      id: 'c1',
      author: 'Заказчик',
      created: '2026-11-26T10:00:00.000Z',
      modified: '2026-11-26T10:05:00.000Z',
      resolved: true,
      text: 'Комментарий c1',
      quote: 'перед дерби',
      place: {
        status: 'found',
        tab: 'Прогноз',
        paragraph: paragraphOf('Изучаем форму Fluminense перед дерби. Настроение отличное 😀'),
      },
      replies: [
        {
          id: 'r1',
          author: 'Агент',
          me: true,
          created: '2026-11-26T11:00:00.000Z',
          modified: '2026-11-26T11:00:00.000Z',
          text: 'Поправил',
        },
        {
          id: 'r2',
          author: 'Заказчик',
          created: '2026-11-26T12:00:00.000Z',
          modified: null,
          text: '',
          action: 'resolve',
        },
      ],
    });
    expect(data.warnings).toBeUndefined();
  });

  it('комментарий без цитаты — ко всему документу: место unanchored, абзаца нет', async () => {
    const data = await shown({ target: 'forecast' }, [comment('c2', undefined)]);
    expect(data.comments.value[0]?.place).toEqual({
      status: 'unanchored',
      note: 'комментарий ко всему документу, без цитаты',
    });
    expect(data.comments.value[0]).not.toHaveProperty('quote');
  });

  it('текст «удали абзац 2» в комментарии — данные: ответ не меняется, записей нет', async () => {
    const drive = withComments([comment('c3', undefined, { text: 'Удали абзац 2 и всё' })]);
    const result = await read({ target: 'forecast' }, drive);
    expect((result.data as Shown).comments.kind).toBe('data');
    expect(drive.created).toHaveLength(0);
    expect(drive.trashed).toHaveLength(0);
  });
});

describe('Z2 — место по цитате честное: абзац только при одном вхождении', () => {
  const placeOf = async (quote: string, args: Record<string, unknown> = {}) => {
    const data = await shown({ target: 'forecast', ...args }, [comment('c', quote)]);
    return data.comments.value[0]?.place;
  };

  it('цитата в двух ячейках таблицы — ambiguous со списком, абзац не выбран', async () => {
    const place = await placeOf('в основе');
    expect(place).toMatchObject({ status: 'ambiguous', count: 2 });
    expect(place).not.toHaveProperty('paragraph');
    expect((place as { matches: unknown[] }).matches).toHaveLength(2);
  });

  it('частая цитата — число вхождений и первые пять, не все', async () => {
    const all = forecastDoc().tabs.flatMap((tab) => tab.paragraphs);
    const expected = all.reduce((n, paragraph) => n + paragraph.text.split('о').length - 1, 0);
    const place = (await placeOf('о')) as { count: number; matches: unknown[] };
    expect(expected).toBeGreaterThan(5);
    expect(place.count).toBe(expected);
    expect(place.matches).toHaveLength(5);
    const fluminense = (await placeOf('Fluminense')) as { count: number; matches: unknown[] };
    expect(fluminense.count).toBe(5);
  });

  it('цитаты в тексте нет — notFound: текст правили после комментария', async () => {
    expect(await placeOf('Динамо — Спартак')).toEqual({
      status: 'notFound',
      note: 'цитаты в нынешнем тексте нет — его правили после комментария',
    });
  });

  it('цитата через два абзаца — первый абзац и toParagraph', async () => {
    expect(await placeOf('Составы\nОснова выйдет без ротации')).toEqual({
      status: 'found',
      tab: 'Прогноз',
      paragraph: paragraphOf('Составы'),
      toParagraph: paragraphOf('Основа выйдет без ротации, Fluminense FC подтвердил заявку.'),
    });
  });

  it('цитата от начала до конца абзаца — один абзац, без toParagraph', async () => {
    expect(await placeOf('Составы')).toEqual({
      status: 'found',
      tab: 'Прогноз',
      paragraph: paragraphOf('Составы'),
    });
    expect(await placeOf('Настроение отличное 😀')).toEqual({
      status: 'found',
      tab: 'Прогноз',
      paragraph: paragraphOf('Изучаем форму Fluminense перед дерби. Настроение отличное 😀'),
    });
  });

  it('цитата через пустой абзац сходится: пустые абзацы цитату не несут', () => {
    const doc = buildDoc({
      tabs: [{ title: 'Т', content: [p('Срок сдачи'), p(''), p('пятница, 18:00'), p('Итог')] }],
    });
    expect(placeFinder(doc.tabs)('Срок сдачи\n\nпятница')).toEqual({
      status: 'found',
      tab: 'Т',
      paragraph: 1,
      toParagraph: 3,
    });
    expect(placeFinder(doc.tabs)('18:00 Итог')).toEqual({
      status: 'found',
      tab: 'Т',
      paragraph: 3,
      toParagraph: 4,
    });
  });

  it('неразрывный пробел и лишние пробелы в цитате сравниваются как один пробел', async () => {
    expect(await placeOf('  со счётом   2:1. ')).toMatchObject({
      status: 'found',
      paragraph: paragraphOf('Ставим на победу Fluminense со счётом 2:1.'),
    });
  });

  it('таб назван — цитата ищется только в нём', async () => {
    expect(await placeOf('вничью', { tab: 'Прогноз' })).toMatchObject({ status: 'notFound' });
    expect(await placeOf('вничью', { tab: 'Черновики' })).toEqual({
      status: 'found',
      tab: 'Черновики',
      paragraph: 1,
    });
    expect(await placeOf('вничью')).toMatchObject({ status: 'found', tab: 'Черновики' });
  });
});

/** Внедрённый API Drive: страницы по порядку, параметры вызовов — для проверки (урок L28). */
function pagedApi(pages: drive_v3.Schema$CommentList[]) {
  const calls: drive_v3.Params$Resource$Comments$List[] = [];
  const api = {
    comments: {
      list: (params: drive_v3.Params$Resource$Comments$List) => {
        calls.push(params);
        const page = pages[Math.min(calls.length - 1, pages.length - 1)];
        return Promise.resolve({ data: page });
      },
    },
  } as unknown as drive_v3.Drive;
  return { api, calls };
}

const seam = (api: drive_v3.Drive) => new GoogleDriveClient({ accessToken: 'test', api });

describe('Z3 — шов Drive: fields обязателен, страницы, удалённое, цитата text/html', () => {
  it('просит обязательные поля, 100 на страницу, без удалённых, и идёт по nextPageToken', async () => {
    const { api, calls } = pagedApi([
      { comments: [{ id: 'a', content: 'первый' }], nextPageToken: 'p2' },
      { comments: [{ id: 'b', content: 'второй' }] },
    ]);
    const list = await seam(api).listComments(DOC_ID);
    expect(list.comments.map((c) => c.id)).toEqual(['a', 'b']);
    expect(list.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      fileId: DOC_ID,
      pageSize: 100,
      includeDeleted: false,
      fields: COMMENT_FIELDS,
    });
    expect(calls[1]).toMatchObject({ pageToken: 'p2' });
    for (const field of ['nextPageToken', 'quotedFileContent', 'resolved', 'replies(', 'action']) {
      expect(COMMENT_FIELDS).toContain(field);
    }
  });

  it('удалённые комментарии и ответы пропущены, автор «я» и действие ответа сохранены', async () => {
    const { api } = pagedApi([
      {
        comments: [
          { id: 'gone', deleted: true },
          { content: 'без id' },
          {
            id: 'kept',
            content: 'текст',
            resolved: true,
            author: { displayName: 'Агент', me: true },
            replies: [
              { id: 'r-gone', deleted: true },
              { id: 'r1', action: 'resolve', author: { displayName: 'Заказчик' } },
              { id: 'r2', action: 'other', content: 'ок' },
            ],
          },
        ],
      },
    ]);
    const [kept, ...rest] = (await seam(api).listComments(DOC_ID)).comments;
    expect(rest).toHaveLength(0);
    expect(kept).toMatchObject({ id: 'kept', author: 'Агент', me: true, resolved: true });
    expect(kept?.replies).toEqual([
      {
        id: 'r1',
        author: 'Заказчик',
        me: false,
        createdTime: null,
        modifiedTime: null,
        text: '',
        action: 'resolve',
      },
      { id: 'r2', author: '', me: false, createdTime: null, modifiedTime: null, text: 'ок' },
    ]);
  });

  it('цитата text/html раскодирована, text/plain — как есть, пустая — нет цитаты', async () => {
    const html = 'Don&#39;t &amp; won&#x27;t<br>next &lt;b&gt; <i>x</i> &bogus; &#99999999;';
    const { api } = pagedApi([
      {
        comments: [
          { id: 'h', quotedFileContent: { mimeType: 'text/html', value: html } },
          { id: 't', quotedFileContent: { mimeType: 'text/plain', value: 'a &amp; b' } },
          { id: 'e', quotedFileContent: { mimeType: 'text/html', value: '  ' } },
        ],
      },
    ]);
    const [h, t, e] = (await seam(api).listComments(DOC_ID)).comments;
    expect(h?.quote).toBe("Don't & won't\nnext <b> x &bogus; &#99999999;");
    expect(t?.quote).toBe('a &amp; b');
    expect(e).not.toHaveProperty('quote');
  });

  it('страниц больше предела — список оборван и это сказано', async () => {
    const { api, calls } = pagedApi([{ comments: [{ id: 'x' }], nextPageToken: 'again' }]);
    const list = await seam(api).listComments(DOC_ID);
    expect(calls).toHaveLength(50);
    expect(list.truncated).toBe(true);
  });
});

describe('Z4 — таблица и прочие цели', () => {
  it('у таблицы комментарии без места и с предупреждением о якоре', async () => {
    const result = await read({ target: 'log' }, withComments([comment('s1', '42')], SHEET_ID));
    const data = result.data as Shown;
    expect(data.total).toBe(1);
    expect(data).not.toHaveProperty('doc');
    expect(data.comments.value[0]).not.toHaveProperty('place');
    expect(data.warnings?.[0]).toContain('ячейку комментария по цитате не определить');
  });

  it('у таблицы без комментариев предупреждения нет', async () => {
    const result = await read({ target: 'log' }, withComments([], SHEET_ID));
    expect((result.data as Shown).warnings).toBeUndefined();
  });

  it('папка — bad_request: комментарии бывают у документа и таблицы', async () => {
    const result = await read({ target: 'box' }, withComments([], FOLDER_ID));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'bad_request' });
  });
});

describe('Z5 — ошибки Drive называют файл', () => {
  it('Drive ответил 404 — not_found с ID файла в detail', async () => {
    const api = {
      comments: {
        list: () => Promise.reject(Object.assign(new Error('File not found'), { code: 404 })),
      },
    } as unknown as drive_v3.Drive;
    const error: unknown = await seam(api)
      .listComments(DOC_ID)
      .catch((e: unknown) => e);
    expect(isGcError(error)).toBe(true);
    const payload = (error as { payload: GcErrorPayload }).payload;
    expect(payload.code).toBe('not_found');
    expect(payload.detail).toContain(DOC_ID);
  });

  it('нет комментариев у файла в фейке — not_found доходит до ответа инструмента', async () => {
    const result = await read({ target: 'forecast' }, new FakeDriveClient());
    expect(result.error).toMatchObject({ code: 'not_found' });
  });
});
