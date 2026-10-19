# Verify report — длинные листы (D-26)

Статус: **код готов, живой прогон — впереди** (`live-run.md`). Мерж — словом владельца, через
`merge_guard`.

## Тест-воспроизведение (kind: bugfix)

`tests/long-sheets.test.ts` — настоящий `GoogleSheetsClient` через внедрённый API, заглушка
отвечает как Google (сетка только в запрошенном диапазоне, размер листа — в `gridProperties`,
хвост пустых строк не отдаётся). На коде до починки красный: `appendRow` на листе в 600 строк
писал в `Агентства!A501` — занятую строку; с пропуском в середине — отказ предусловия вместо
дозаписи; `upsertRow` по ключу в 550-й строке не находил его. На починке — зелёный.

## Оракулы по примерам

| id | Чем судится | Где |
|---|---|---|
| Q1 | 1629 строк одним вызовом, `truncated: false`, `sheetRows`, `fromRow` | `tests/long-sheets.test.ts`; живьём — «Агентства» |
| Q2 | 5000 строк, `truncated: true`, `nextFromRow`; продолжение — остаток | `tests/long-sheets.test.ts`; проба `read.max-rows` |
| Q3 | `fromRow` — строки с нужной; шапка и выше — с первой строки данных и предупреждением | `tests/long-sheets.test.ts`; живьём |
| Q4 | дозапись после последней строки: 602-я на листе в 600 строк, 42-я при пропуске в середине | `tests/long-sheets.test.ts`; живьём — тестовая таблица |
| Q5 | `upsertRow` по ключу в 550-й правит 550-ю | `tests/long-sheets.test.ts`; живьём |
| Q6 | лист больше 50 000 строк сетки — `write.full-sheet` до чтения сетки, ни одной записи | `tests/long-sheets.test.ts`; проба `write.full-sheet` |
| Q7 | карта — `sheetRows` и предупреждение о части листа; на коротком листе предупреждения нет | `tests/long-sheets.test.ts`; живьём |

## Обратные прогоны (каждый — красный на своём тесте, 2026-10-19)

- Запись снова по `A1:ZZ500` → 3 красных (Q4, Q5, шов «лист целиком»).
- `appendRow` по числу непустых строк → Q4 с пропуском красный.
- `truncated` по длине ответа → Q2 красный (2 теста).
- Карта молчит о части листа → Q7 красный.
- Без предела записи → Q6 красный.

## Мутации — доли считают, порог судит сумма (cqg@2.69)

Локально 2026-10-19, `MIN_KILLED=60`, база `main`: сумма 4 долей — убито 523 из 830 (63%).
Судятся два файла ядра в маске — `src/core/sheets/map.ts` и `rows.ts` (доли 1 и 2; доли 3 и 4 —
«0 0»). Шов Google (`src/core/google/sheets.ts`) и слой MCP (`read-values.ts`, `tools.ts`) — вне
маски Stryker, их судят тесты через настоящий клиент и протокол.

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md`, `src/policy/rules.json`, `src/mcp/tools.ts` — то, что уходит
агенту как `instructions`, `policy://rules`, `tools/list` и ответы.

1. **`gc_read`**: новое поле `fromRow`; `limit` до 5000 и по умолчанию — до предела; описание
   инструмента говорит про окна и `nextFromRow`.
2. **Ответ `values`**: `fromRow`, `sheetRows`, `truncated` по размеру сетки, `nextFromRow`.
3. **Карта**: `sheetRows` и предупреждение «карта построена по первым 500 строкам…».
4. **Отказ `write.full-sheet`** (`policy_denied`) — лист больше предела записи.
5. **Правила**: `read.max-rows` — 5000 за вызов и пометка усечения; новые `write.full-sheet`,
   `write.max-sheet-rows` с пробами (правил 52); раздел «Длинные листы» в `rules.md`.

По файлам: `src/mcp/tools.ts` — вход `fromRow`, описание `gc_read`, лёгкая карта (`MAP_ROWS`),
ветка `values` переехала в `read-values.ts`, остальные инструменты не изменены. Прогнал
`vitest` по протоколу (`tests/long-sheets.test.ts`, `tests/mcp-tools.test.ts`): зелёные.
at=2026-10-19

## Ревью рисковых мест (§12.5)

- **Безопасность** — главная цель поставки: запись больше не считается по части листа.
  Механизм — поведение по умолчанию (`rangesFor`: названный лист без `maxRows` — целиком);
  частичное чтение — только явным `maxRows` (карта) или окном (`readRows`). Путь, который
  забудет сказать, сколько читать, получит лист целиком, а не обрезку.
- **Предел записи** — 50 000 строк сетки: больше — отказ до чтения сетки. Названо, что сетка
  считает и пустые строки: лист с огромной пустой сеткой откажет, хотя данных мало, — человеку
  сказано, почему.
- **Деньги** — риска нет, потому что поставка ничего не тратит: «бюджет» — строки чтения.
- **Транзакция БД** — базы нет; запись по-прежнему через превью, предусловие (теперь по
  целому листу) и журнал с откатом.
- **Производительность** — запись на длинном листе читает его целиком (~60 тыс. ячеек на 1630
  строк) плюс запрос размера; чтение `values` — одним запросом окна до 5000 строк.

## Найдено по дороге

- **Фейк Google в тестах обрезку не моделировал** — отдавал лист целиком при любом диапазоне;
  потолок в 500 строк не видел ни один тест за все поставки (L23 — в четвёртый раз). Фейки
  теперь режут по диапазону, шов судится через внедрённый API.
- **Проба `read.max-rows` была оракулом на соседнем свойстве** (L22): сверяла число в коде с
  правилом, а обещание «усечение помечается» не исполнял никто.
- **`appendRow` целился по числу непустых строк** — на пропуске в середине и на коротком листе
  попадал внутрь данных (L16 — в третий раз); спасало только предусловие, отказом.
- **Мой тест с пропуском прошёл вхолостую** на коде до починки: «каждая запись — в 42-ю» верно
  при нуле записей (L7). Усилен: статус `ok` и хотя бы одна запись.
- **Гейт сложности отклонил** `getSpreadsheet` и `readRows` (11 при 10) и `buildSheetData` (51
  оператор при 50) — разнесено на `rangesFor`, `withRowLimit`, `toRowWindow` (L20).

## Риски и непокрытое

- Запись на длинном листе читает его целиком: 1630 × 37 ≈ 60 тыс. ячеек на запрос — секунды.
- Чтение без названного листа (по первому листу книги) по-прежнему тянет книгу целиком.
- Ревизия для журнала (`server.ts`, `revision`) читает книгу целиком — дорого, но верно.
- Колонки дальше ZZ не читаются ни картой, ни окном.

## Assertion digest (ревью ожиданий, не кода)

База: `main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **39**, из них без ссылки на пример спеки:
**1**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
-	import { expect } from 'vitest';
L22	expect(answer.rows.value).toHaveLength(cap);
L22	expect(answer.truncated).toBe(true);
L22	expect(answer.nextFromRow).toBe(cap + 2);
L11	await expect(client.getSpreadsheet('SHEET', { sheet: 'Лист' })).rejects.toMatchObject({
L11	expect(calls).toEqual(['размер']);
L11	expect(WRITE_MAX_SHEET_ROWS).toBe(limitOf('write.max-sheet-rows', -1));
L11	expect(WRITE_MAX_SHEET_ROWS).toBeGreaterThan(0);
Q4	expect(result.data).toMatchObject({ status: 'ok' });
Q4	expect(g.writes.length).toBeGreaterThan(0);
Q4	for (const range of g.writes) expect(range).toMatch(/602$/);
L7	expect(result.data).toMatchObject({ status: 'ok' });
L7	expect(g.writes.length).toBeGreaterThan(0);
L7	for (const range of g.writes) expect(range).toMatch(/42$/);
Q5	expect(result.data).toMatchObject({ status: 'ok' });
C550	expect(g.writes).toEqual([expect.stringMatching(/C550$/)]);
Q1	expect(rowsOfAnswer(data)).toHaveLength(1629);
Q1	expect(rowsOfAnswer(data).at(-1)).toMatchObject({ Компания: 'Компания 1629' });
Q1	expect(data).toMatchObject({ truncated: false, sheetRows: 1630, fromRow: 2 });
Q2	expect(rowsOfAnswer(result.data)).toHaveLength(5000);
Q2	expect(result.data).toMatchObject({ truncated: true, sheetRows: 6001, nextFromRow: 5002 });
Q2	expect(rowsOfAnswer(next.data)).toHaveLength(1000);
Q2	expect(next.data).toMatchObject({ truncated: false });
Q3	expect(from.data).toMatchObject({ fromRow: 1001 });
Q3	expect(rowsOfAnswer(from.data)[0]).toMatchObject({ Компания: 'Компания 1000' });
Q3	expect(rowsOfAnswer(from.data)).toHaveLength(630);
Q3	expect(header.data).toMatchObject({ fromRow: 2, truncated: true, nextFromRow: 5 });
Q3	expect((header.data as { warnings: string[] }).warnings.join(' ')).toContain('fromRow 1');
Q6	expect(result.error).toMatchObject({ code: 'policy_denied', cause: 'write.full-sheet' });
Q6	expect(result.error?.detail).toContain('60000 строк сетки');
Q6	expect(g.writes).toHaveLength(0);
Q6	expect(g.reads).not.toContain(`'${TITLE}'`);
Q7	expect(map.sheetRows).toBe(1630);
Q7	expect(map.warnings.join(' ')).toContain('карта построена по первым 500 строкам листа из 1630');
A1	expect(g.reads).toContain(`'${TITLE}'!A1:ZZ500`);
A1	expect((short.data as { warnings: string[] }).warnings.join(' ')).not.toContain(
A1	expect(g.reads).toContain(`'${TITLE}'`);
A1	expect(g.reads).not.toContain(`'${TITLE}'!A1:ZZ500`);
A1	expect(policyRules()).toHaveLength(52);
```

Привязаны к примерам: **A1 C550 L11 L22 L7 Q1 Q2 Q3 Q4 Q5 Q6 Q7**. Остальные 1 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 1
