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
 * Право создавать даёт реестр, как и право писать: цель — ПАПКА с `allow: write`. Файл,
 * который мы создали, права записи не получает — в реестре его нет (правило
 * `write.allowlist`), и это осознанно: иначе агент мог бы расширять себе доступ созданием.
 */

import { CREATE_MIME, type CreateKind, type DriveClient } from './google/drive.js';
import { gcError } from './errors.js';
import { finishWrite, type Prepared, type WriteContext } from './sheets/commit.js';
import type { SheetsClient } from './sheets/types.js';
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
  const where =
    input.parentName ?? (input.parentId === undefined ? 'корень «Мой диск»' : input.parentId);
  const structural: StructuralPlan = {
    kind: 'createFile',
    sheet: name,
    title: name,
    anchor: `${WHAT[input.kind]} «${name}» в ${where}`,
  };
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
  const outcome = await finishWrite(sheets, context, [], empty(), options, 'createFile', {
    structural,
    apply: async () => {
      const file = await drive.create(input.kind, name, input.parentId);
      created.id = file.id;
      created.url = file.url;
      return { fileId: file.id };
    },
  });
  if (outcome.status !== 'ok') return outcome;
  const url = created.url;
  return {
    ...outcome,
    notes: [
      ...outcome.notes,
      `Создано: ${WHAT[input.kind]} «${name}»${url === undefined ? '' : `, ссылка: ${url}`}.`,
      'Права записи у нового файла нет: их даёт только реестр целей. Добавь его туда, если ' +
        'собираешься в него писать.',
      `Откат отправит файл в корзину Drive; достать оттуда — руками, в интерфейсе Drive.${
        created.id === undefined ? '' : ` Id: ${created.id}.`
      }`,
    ],
  };
}

/** mimeType по типу — для сообщений человеку и для проверки в тестах. */
export const mimeOf = (kind: CreateKind): string => CREATE_MIME[kind];
