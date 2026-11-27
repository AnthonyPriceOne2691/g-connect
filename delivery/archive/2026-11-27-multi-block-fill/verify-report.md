# Verify report — лист из нескольких таблиц (PR #24) и комментарии Google (PR #25)

Статус: **verify, мерж в main одним squash через `merge_guard`** — слово владельца 2026-11-27 «сливай».
Цепочка: PR #24 `fix/fill-multi-block` (хотфикс 16.11: числа в пустые ячейки блока, ссылки `u/N/`, граница
блока — Y1–Y6) и PR #25 `feat/doc-comments` поверх него (комментарии Google: чтение, ответы, свои
комментарии, подсветка фразы, подсказка в отказе разрешения — Z1–Z21, D-28).

- **Verifier:** human:anton

## Тест-воспроизведение (kind: hotfix)

`tests/multi-block-fill.test.ts` — на ядре `main` (`6b380ee`) красный: запись трёх чисел в пустые ячейки
блока — `write_blocked` (формулы итогов в той же колонке ниже) и `not_in_enum` (список из чужого блока);
`force` под конвертом писал в формулу без кода плана. На хотфиксе — зелёный. Диагноз — `diagnosis.md`.

Комментарии Google — новая способность, а не починка: на `main` режима `comments` и операций
`replyComment`/`addComment` нет, их тесты на базе не собираются (схема отказывает на границе).

## Оракулы по примерам

| id | Чем судится | Где |
|---|---|---|
| Y1–Y2 | пустые ячейки блока пишутся с первой фразы, заметки о формулах и выведенном списке; формула и строка над ней — `write_blocked`; `force` под конвертом — `confirm_required` | `tests/multi-block-fill.test.ts`; живьём — `live-run.md` (12 чисел, 16.11) |
| Y3 | ссылка с `u/N/` — та же цель | `tests/targets.test.ts` |
| Y4–Y6 | граница блока: данные шапки до следующей таблицы, `nextTable` и предупреждение; без ложной границы; `block_gap` у дозаписи | `tests/multi-block-fill.test.ts`; пробы `map.block-bound`, `write.append-keeps-block-gap` |
| Z1–Z5 | `gc_read mode=comments`: ветки, ответы, цитата, место по цитате (абзац только при одном вхождении), данные с источником, шов Drive (`fields`, страницы, удалённое, text/html), таблица и папка, 404 с ID | `tests/doc-comments.test.ts`, `tests/doc-fragment.test.ts`; пробы `read.comments-are-data`, `read.comment-place-exact`; живьём — T12 |
| Z6–Z9 | подсветка фразы: `background` и `fragment`, позиция в юнитах Google, откат прежнего фона, отказы без записи | `tests/doc-highlight.test.ts`, `tests/doc-envelope.test.ts`; проба `docs.fragment-exact` |
| Z10–Z19 | `replyComment`, `addComment`: превью ветки, конверт, код плана, `not_found`, отказы до Google, цитата без якоря, откат своего (отказ при чужом ответе, `reopen`), шов Drive | `tests/doc-comment-write.test.ts`; пробы `write.comment-undo-own-only`, `write.comment-unanchored-honest`; живьём — T13 (`replyComment` ×9) |
| Z20 | свой комментарий к фразе, затем подсветка; `gc_undo` — подсветка, затем комментарий | `tests/doc-comment-write.test.ts` |
| Z21 | `grant_declined` — подсказка перезапустить агент Secretive | `tests/grant.test.ts` |

## Обратные прогоны

- Y1–Y6 — 16.11: тесты хотфикса на ядре `main` красные (запись в блок, `force` под конвертом, граница блока),
  на хотфиксе зелёные; ложных границ среди 1301 теста нет.
- Z — способность новая; зубы тестов проверены мутациями (ниже): `comment-place.ts` — 100% после правки
  (было 84%: мёртвые ветки и непокрытая цитата через пустой абзац), `fragment.ts` — 100% (выжившие хвосты
  текстов отказа убиты сверкой текста целиком).

## Мутации — доли считают, порог судит сумма (cqg@2.69)

- CI PR #25 на `f792243`: четыре доли и сумма долей — зелёные; `quality` — зелёный.
- Локально: `comment-place.ts` 100% (68 + 6 timeout из 74), `fragment.ts` 100% (31/31), `googleFailure`
  100%; запись комментариев (агент C, свои строки и файлы) — 94.33% (449 из 478; выжившие —
  эквивалентные: спреды `x === undefined ? {} : {x}`, `journal?.`, имена операций в хэше кода плана,
  `resolvedBefore` при отказе повторного закрытия); подсветка (агент H) — 81.65% по изменённым кускам,
  на своих строках выжил один NoCoverage (`?? []` в `restyled()`, прежний).
- Шов Google (`src/core/google/`) и слой MCP — вне маски Stryker; их судят тесты через внедрённый API
  (урок L28) и настоящий протокол (`callMcp`).

## Изменение поверхности модели (§14.4)

- `gc_read`: `mode: "comments"` — описание и ответ (`comments` как данные, `place`
  found/ambiguous/notFound/unanchored с `note`).
- `gc_apply`: операции `replyComment`, `addComment`; поля `commentId`, `resolve`, `fragment` (одно на
  `updateTextStyle` и `addComment`), `style.background`; в описании — «сообщения людям», «без привязки к
  тексту» и рецепт «комментарий, затем подсветка; откат — gc_undo дважды».
- Превью ответа — ветка данными и «Google уведомит людей ветки»; превью своего комментария — «без
  привязки к тексту».
- `rules.md`: раздел «Комментарии Google»; подсветка фразы в «Про документы»; раздел о листе из нескольких
  таблиц (PR #24). Правила 65–71.
- Отказ `grant_declined` — подсказка про зависший агент Secretive.
- Сессиям нужен Reconnect: схема инструментов изменилась (L47); живьём — схема в контексте сессии после
  Reconnect оставалась прежней, сервер вызов принимал (`live-run.md`).

- Затронутые элементы поверхности (at=2026-11-27; PR #24 — at=2026-11-16):
  - `src/mcp/tools.ts` — описание `gc_read` (`mode=comments`) и `gc_apply` (ответ, свой комментарий, подсветка, рецепт);
  - `src/mcp/apply-schema.ts` — поля `commentId`, `resolve`, `fragment`, `style.background` и их описания;
  - `src/mcp/read-comments.ts` — ответ `mode=comments`: `comments` данными, `place` с `note`;
  - `src/mcp/run-comment.ts` — превью ответа (ветка данными, «Google уведомит») и своего комментария («без привязки»);
  - `src/policy/rules.json` — правила 65–71 (их заголовки уходят агенту в `policy://rules`);
  - `src/mcp/read-values.ts` (PR #24) — окно `values` кончается на блоке, `truncated` по блоку;
  - `src/core/sheets/types.ts` (PR #24) — карта получила `nextTable`, предупреждение «ниже ещё одна таблица».

## Ревью рисковых мест (§12.5)

- **Сообщения людям** — ответ и свой комментарий видит заказчик, Google рассылает письмо; откат удаляет
  комментарий, письмо не отзывает. Объявлено необратимой поверхностью и подписано владельцем
  (`irreversible.sig`, `.github/allowed_signers`); в конверте — по ответу «Сразу, в конверте».
- **Откат чужого** — удаляется только своё (`author.me`), комментарий с чужими ответами — отказ
  `policy_denied`: Drive удаляет ветку целиком.
- **Дубликат при обрыве сети** — создание не повторяется; обрыв — `offline`, комментарий мог появиться,
  повтор агента даст второй (как `files.create`).
- **Подсветка и откат других записей** — маска точного восстановления включает фон: откат записи прежних
  сборок сбрасывает выделение в своём диапазоне (прежде оно тоже не возвращалось — текст наследовал фон
  соседа).
- **Запись в формулу под конвертом** (PR #24) — закрыта: `force` под конвертом — только код плана.
- **Интеграция** — `src/core/google/drive-comments.ts` (новый шов Drive: `comments.list/get/create/delete`,
  `replies.create/delete`), `google/docs.ts` и `google/doc-requests.ts` (фон текста в чтении и `updateTextStyle`):
  `fields` обязателен у всех методов, кроме delete; без `anchor`; создание без повтора, удаление с повтором
  (404 после повтора — успех); шов судится внедрённым API (Z3, Z18, шов вида прогона Z6).
- **Транзакция БД** — риска нет, потому что базы нет: журнал — файл строк, запись комментария — одна строка
  журнала после ответа Drive, как у остальных операций.
- **Деньги** — риска нет, потому что поставка ничего не тратит.

## Исполнение рисковых путей (§12.6)

Новый шов — `src/core/google/drive-comments.ts` (`runtime_paths`), at=2026-11-27: чтение исполнено живьём (T12, 14
комментариев), ответ — живьём (T13, `replyComment` ×11), откат своего ответа по `record` — живьём (×2, после
чужих записей в документе). `addComment`, подсветка и откат своего комментария — тестами через внедрённый API
Drive и протокол; живьём — нет (в документе заказчика проверочных записей не делаем).

## Найдено по дороге

- **Ошибка Drive после повтора теряла `detail`** с ID файла — общий `googleFailure` в `errors.ts`.
- **Гейты в worktree агента молчат без `node_modules/.bin`** (находка агента C): слои отказали явно, а
  jscpd и TS-половина сложности пропустили проверку с предупреждением и «Passed». Агенты гоняли с
  временной ссылкой на `.bin` основного клона.
- **`cd` ведущего в worktree агента перенёс рабочую папку сессии** — в worktree агентов только `git -C`.
- **Завис агент Secretive** (27.11 13:17–13:32): запросы подписи копились без окна — разрешение G connect и
  подпись другой поставки. Лечение — перезапуск агента; отказ теперь это подсказывает (Z21).
- **Поле `fragment` объявили оба агента** — при сведении одно описание на две операции.

## Риски и непокрытое

- `addComment`, подсветка и откат своего комментария — не исполнены живьём; сдвигает ли комментарий ревизию Docs — не мерено
  (порядок «комментарий, затем подсветка» от этого не зависит).
- Кому именно Google шлёт письмо — не мерено; тексты говорят «участникам ветки» и «может уведомить».
- Комментарии таблицы — без ячейки (якорь таблиц не разбирается).
- Фраза через встроенный объект не находится (`fragment_not_found`), подсказка ведёт в `mode=text`, где
  объект — метка.
- PR #24: граница блока живьём на «Смете» не проверена (ждала Reconnect сессии профиля work 16.11); блок без
  своей шапки и таблица без заголовка с одним признаком границы не получают.

## Assertion digest (ревью ожиданий, не кода)

База: `main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **281**, из них без ссылки на пример спеки:
**76**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
L28	expect(result.error).toBeUndefined();
Z10	expect(plan.status).toBe('preview');
Z10	expect(plan.planId).toMatch(/^[0-9a-f]{6}$/);
Z10	expect(plan.thread).toEqual({
Z10	expect(plan.changes).toEqual([
Z10	expect(plan.notes).toEqual([
Z10	expect(plan.questions).toEqual([]);
Z10	expect(plan.target).toEqual({ id: DOC, alias: null });
Z10	expect(h.drive.calls).toEqual(['getComment']);
Z10	expect(h.journalled).toHaveLength(0);
Z10	expect(new Set([plan.planId, plain.planId, other.planId]).size).toBe(3);
Z10	expect(plain.notes.at(-1)).toBe('Откат — gc_undo: удалит ответ.');
Z10	expect(plain.notes).toHaveLength(2);
Z11	expect(done.status).toBe('ok');
Z11	expect(thread).toMatchObject({ resolved: true, replies: [{ text, action: 'resolve' }] });
Z11	expect(h.journalled).toEqual([
Z11	expect(done.notes.at(-1)).toBe(
Z11	expect(refused.status).toBe('confirm_required');
Z11	expect(refused.notes.join(' ')).toContain('1001 юнитов текста');
Z11	expect(h.drive.calls.filter((call) => call.startsWith('create'))).toEqual(['createReply']);
Z12	expect(refused.status).toBe('confirm_required');
Z12	expect(refused.notes.join(' ')).toContain(`пиши ${refused.planId}`);
Z12	expect(h.drive.calls).not.toContain('createComment');
Z12	expect(written.notes.at(-1)).toContain(`Записано: комментарий ${h.threads()[1]!.id}.`);
Z12	expect(again.error).toMatchObject({ code: 'plan_already_applied' });
Z12	expect(h.threads()).toHaveLength(2);
Z13	expect(missing.error).toMatchObject({
Z13	expect(deleted.error).toMatchObject({ code: 'not_found', cause: 'comment_not_found' });
Z13	expect(h.drive.calls).not.toContain('createReply');
Z13	expect((await h.apply(reply)).error).toMatchObject({
Z14	expect(await refusal({ op: 'replyComment', commentId: THREAD })).toContain(
Z14	expect(await refusal({ op: 'addComment', text: 'x', ...loose })).toContain(
Z14	expect(twice.error).toMatchObject({
Z14	expect(h.drive.calls).not.toContain('createReply');
Z14	expect(applyInput.commentId.description).toBe(
Z14	expect(applyInput.resolve.description).toBe(
Z14	expect(applyInput.text.description).toBe(
Z14	expect(applyInput.fragment.description).toBe(
Z14	expect(applyInput.where.description).toContain('; у addComment — абзац цитаты');
Z14	expect(gcApply.description).toContain(
Z14	expect(gcApply.description).toContain(
Z15	expect(plan.changes).toEqual([
Z15	expect(plan.notes).toEqual([
Z15	expect(asked.status).toBe('needs_clarification');
Z15	expect(asked.questions).toHaveLength(1);
Z15	expect(made).toMatchObject({ me: true, quote: 'Fluminense', text: 'Точно?' });
Z15	expect(h.journalled.at(-1)?.comment).toEqual({
Z15	expect(elsewhere.planId).not.toBe(written.planId);
Z15	expect(h.threads().at(-1)?.quote).toBe(QUOTE);
Z15	expect(all.changes).toEqual([
Z15	expect(all.notes[0]).toBe('Комментарий ко всему документу, без цитаты.');
Z15	expect(h.threads().at(-1)).not.toHaveProperty('quote');
Z15	expect(absent.error).toMatchObject({ code: 'bad_request', cause: 'fragment_not_found' });
Z15	expect((await blank.apply(first)).error).toMatchObject({
Z16	expect(undone.status).toBe('ok');
Z16	expect(undone.docUndone).toBe('Комментарий «Первый» удалён вместе со своей веткой.');
Z16	expect(undone.restored).toEqual([]);
Z16	expect(undone.hint).toContain('«Первый» удалён');
Z16	expect(h.threads().map((c) => c.id)).toEqual([THREAD]);
Z16	expect(h.journalled.at(-1)).toEqual({
Z16	expect(refused.error).toMatchObject({
Z16	expect(refused.error?.detail).toContain(
Z16	expect(h.threads()).toContainEqual(expect.objectContaining({ id: ours.id }));
Z16	expect(gone.docUndone).toBe(`Комментария ${ours.id} уже нет — его удалили в Docs.`);
Z16	expect(data<Undone>(await h.undo()).status).toBe('nothing_to_undo');
Z16	expect(data<Undone>(await h.undo()).docUndone).toContain(`«${'а'.repeat(60)}…»`);
R0	expect(reopened.docUndone).toBe(
R0	expect(h.threads()[0]).toMatchObject({
R0	expect(data<Undone>(await h.undo()).docUndone).toBe(
R0	expect(h.threads()[0]!.replies).toEqual([]);
R3	expect(touched.notRestored).toEqual([
R2	expect(h.threads()[0]).toMatchObject({ resolved: true, replies: [{ id: 'R2' }, { id: 'R3' }] });
Z17	expect(data<Undone>(await h.undo()).docUndone).toBe(`Ответ «Да» удалён из ветки ${THREAD}.`);
Z17	expect(gone.docUndone).toBe(`Ответа ${ours!.id} уже нет — его удалили в Docs.`);
R1	expect(refused.error).toMatchObject({ cause: 'write.comment-undo-own-only' });
R1	expect(refused.error?.detail).toContain(
R1	expect(h.threads()[0]!.replies).toHaveLength(1);
R1	expect(lost.docUndone).toBe(`Ответа ${third.id} уже нет — его удалили в Docs.`);
Z19	expect(foreign.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-project' });
Z19	expect(work.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-profile' });
Z19	expect(data<Undone>(bare).docUndone).toContain('«Мой» удалён');
Z19	await expect(
Z18	expect(await seam.client.getComment(DOC, THREAD)).toMatchObject({ id: THREAD, resolved: true });
Z18	expect(await googleApi({}, true).client.getComment(DOC, THREAD)).toBeNull();
Z18	await expect(seam.client.createComment(DOC, 'Так?', 'Fluminense')).rejects.toMatchObject({
T1	expect(await seam.client.createComment(DOC, 'Всем')).toEqual({ id: 'CMT1', createdTime: 'T1' });
T1	expect(seam.calls).toStrictEqual([
Z18	await expect(pending).resolves.toBeUndefined();
Z18	await expect(seam.client.deleteReply(DOC, THREAD, 'RPL1')).rejects.toMatchObject({
Z18	expect(seam.calls).toEqual([
Z18	const failing = expect(down.deleteComment(DOC, 'CMT1')).rejects.toMatchObject({
Z18	await expect(client.getComment(DOC, 'X')).rejects.toMatchObject(
Z18	await expect(client.createReply(DOC, THREAD, { text: 'x' })).rejects.toMatchObject(
Z18	await expect(client.deleteComment(DOC, 'CMT1')).rejects.toMatchObject(
Z18	await expect(client.createComment(DOC, 'x')).rejects.toMatchObject(
Z18	expect(COMMENT_FIELDS).toBe(`nextPageToken,comments(${THREAD_FIELDS})`);
-	expect(added.status).toBe('ok');
-	expect(ours).toMatchObject({ text: 'Проверьте счёт', quote: fragment });
-	expect(highlighted.status).toBe('ok');
-	expect(await lit()).toEqual([fragment]);
-	expect(data<Undone>(await run(gcUndo, {})).status).toBe('ok');
-	expect(await lit()).toEqual([]);
-	expect(h.threads().some((thread) => thread.me)).toBe(true);
-	expect(data<Undone>(await run(gcUndo, {})).status).toBe('ok');
-	expect(h.threads().some((thread) => thread.me)).toBe(false);
-	expect(h.threads()).toHaveLength(1);
Z4	expect(result.ok).toBe(true);
-	expect(data).toMatchObject({ doc: 'Прогноз на матч', total: 2, open: 1, truncated: false });
-	expect(data.comments.kind).toBe('data');
-	expect(data.comments.origin).toBe(`комментарии к файлу ${DOC_ID}`);
-	expect(data.comments.value[0]).toEqual({
-	expect(data.warnings).toBeUndefined();
-	expect(data.comments.value[0]?.place).toEqual({
-	expect(data.comments.value[0]).not.toHaveProperty('quote');
-	expect((result.data as Shown).comments.kind).toBe('data');
-	expect(drive.created).toHaveLength(0);
-	expect(drive.trashed).toHaveLength(0);
-	expect(place).toMatchObject({ status: 'ambiguous', count: 2 });
-	expect(place).not.toHaveProperty('paragraph');
-	expect((place as { matches: unknown[] }).matches).toHaveLength(2);
-	expect(expected).toBeGreaterThan(5);
-	expect(place.count).toBe(expected);
-	expect(place.matches).toHaveLength(5);
-	expect(fluminense.count).toBe(5);
-	expect(await placeOf('Динамо — Спартак')).toEqual({
-	expect(await placeOf('Составы\nОснова выйдет без ротации')).toEqual({
-	expect(await placeOf('Составы')).toEqual({
-	expect(await placeOf('Настроение отличное 😀')).toEqual({
-	expect(placeFinder(doc.tabs)('Срок сдачи\n\nпятница')).toEqual({
-	expect(placeFinder(doc.tabs)('18:00 Итог')).toEqual({
-	expect(await placeOf('  со счётом   2:1. ')).toMatchObject({
-	expect(await placeOf('вничью', { tab: 'Прогноз' })).toMatchObject({ status: 'notFound' });
-	expect(await placeOf('вничью', { tab: 'Черновики' })).toEqual({
-	expect(await placeOf('вничью')).toMatchObject({ status: 'found', tab: 'Черновики' });
-	expect(list.comments.map((c) => c.id)).toEqual(['a', 'b']);
-	expect(list.truncated).toBe(false);
-	expect(calls).toHaveLength(2);
-	expect(calls[0]).toEqual({
-	expect(calls[1]).toMatchObject({ pageToken: 'p2' });
-	expect(COMMENT_FIELDS).toContain(field);
-	expect(rest).toHaveLength(0);
-	expect(kept).toMatchObject({ id: 'kept', author: 'Агент', me: true, resolved: true });
-	expect(kept?.replies).toEqual([
-	expect(h?.quote).toBe("Don't & won't\nnext <b> x &bogus; &#99999999;");
-	expect(t?.quote).toBe('a &amp; b');
-	expect(e).not.toHaveProperty('quote');
-	expect(calls).toHaveLength(50);
-	expect(list.truncated).toBe(true);
-	expect(data.total).toBe(1);
-	expect(data).not.toHaveProperty('doc');
-	expect(data.comments.value[0]).not.toHaveProperty('place');
-	expect(data.warnings?.[0]).toContain('ячейку комментария по цитате не определить');
-	expect((result.data as Shown).warnings).toBeUndefined();
-	expect(result.ok).toBe(false);
-	expect(result.error).toMatchObject({ code: 'bad_request' });
-	expect(isGcError(error)).toBe(true);
-	expect(payload.code).toBe('not_found');
-	expect(payload.detail).toContain(DOC_ID);
-	expect(result.error).toMatchObject({ code: 'not_found' });
Z6	expect(whole.status).toBe('confirm_required');
Z6	expect(whole.notes.join(' ')).toContain('Правка трогает 43 юнитов текста');
Z6	expect(piece.status).toBe('ok');
Z6	expect(sent.map((request) => request.endIndex - request.startIndex)).toEqual([10]);
Z6	expect(outcome).toMatchObject({ status: 'preview' });
-	expect(fragmentRange(paragraph, 'Fluminense FC')).toEqual({
-	expect(fragmentRange(paragraph, 'подпись')).toEqual({
-	expect(fragmentRange(paragraph, 'Основа')).toEqual({
-	expect(() => fragmentRange(nth(1), fragment)).toThrow(
-	expect(() => fragmentRange(nth(1), 'Palmeiras')).toThrow(
-	expect(() => fragmentRange(nth(3), 'аа')).toThrow(
-	expect(() => fragmentRange(nth(2), 'фото')).not.toThrow();
-	expect(() => fragmentRange(nth(1), 'о')).toThrow(
Z6	expect((await style(client, hl('Fluminense'))).status).toBe('ok');
Z6	expect(client.applied).toEqual([[restyle(at, at + 10, { background: '#fff2cc' })]]);
Z6	expect(toDocRequest(client.applied[0]![0]!)).toEqual(
Z6	expect(marked(await paragraphOf(client, 'Ставим'))).toEqual(['Fluminense']);
Z6	expect(piece.planId).not.toBe(whole.planId);
Z6	expect(piece.changes[0]!.anchor).toMatch(/^фраза «Fluminense» в абзаце № \d+: Ставим на/);
Z6	expect(piece.notes).toEqual([
Z6	expect(whole.notes).toEqual([
Z6	expect(toDocRequest(client.applied[0]![0]!)).toEqual(google(14, 18, { backgroundColor: {} }));
Z6	expect(marked(await paragraphOf(client, 'Важно'))).toEqual([]);
Z6	expect((await paragraphOf(client, 'Важно')).runs[1]).toEqual({ text: 'срок', style: was });
Z7	expect(client.applied).toEqual([[restyle(start, end, { background: '#fff2cc' })]]);
Z7	expect(marked(await paragraphOf(client, parts[0]!.text))).toEqual([fragment]);
Z8	expect(marked(await paragraphOf(client, 'Итог:'))).toEqual(['счёт ', '2:1', ' в']);
Z8	expect(client.applied[1]).toEqual([
Z8	expect(unitStyles(await paragraphOf(client, 'Итог:'))).toEqual(unitStyles(original));
Z8	expect(undone.docUndone).toBe(
Z8	expect(marked(await paragraphOf(client, 'Ставим'))).toEqual([original.text]);
Z8	expect(unitStyles(await paragraphOf(client, 'Ставим'))).toEqual(unitStyles(original));
Z8	expect(undone.docUndone).toBe('Стили возвращены: 1 абзац(ев), текст не тронут.');
Z8	expect(toDocRequest(restyle(3, 5, {}, true))).toEqual(google(3, 5, {}, mask));
Z8	expect(none).toEqual(google(3, 5, { backgroundColor: {}, foregroundColor: green }, mask));
Z9	await expect(style(client, hl(fragment))).rejects.toMatchObject({
Z9	expect(client.applied).toHaveLength(0);
Z9	expect(journalled).toHaveLength(0);
Z9	await expect(counted).rejects.toMatchObject({
Z9	await expect(style(client, asView)).rejects.toMatchObject({
Z9	expect(client.applied).toHaveLength(0);
Z9	expect(journalled).toHaveLength(0);
Z9	await expect(style(client, hl('нет такой', { firstParagraph: true }))).rejects.toMatchObject({
Z9	expect(client.applied).toHaveLength(0);
Z9	for (const value of ['#09afAF', 'none']) expect(background.safeParse(value).success).toBe(true);
Z9	expect(issue, value).toBe('фон задаётся как #RRGGBB или "none" (без выделения)');
Z9	expect(updateTextStyleOp.shape.fragment.safeParse('').success).toBe(false);
Z6	expect(paragraph.runs.map((r) => r.style ?? null)).toEqual([
Z6	import { expect } from 'vitest';
Z6	expect(out.comments).toMatchObject({ kind: 'data', origin: 'комментарии к файлу DOC' });
Z6	expect(out.comments.value[0]?.text).toBe(text);
Z6	expect(drive.created).toHaveLength(0);
Z6	expect(drive.trashed).toHaveLength(0);
Z6	expect(twice).toMatchObject({ status: 'ambiguous', count: 2 });
Z6	expect(twice).not.toHaveProperty('paragraph');
Z6	expect(find('Бюджет согласован')).toEqual({ status: 'notFound' });
Z6	expect(find(undefined)).toEqual({ status: 'unanchored' });
Z6	expect(find('  ')).toEqual({ status: 'unanchored' });
Z6	expect(find('Бюджет утверждён')).toEqual({ status: 'found', tab: 'Т', paragraph: 3 });
Z6	import { expect } from 'vitest';
R9	await expect(undoComment(DOC, added, options)).rejects.toMatchObject({
R9	expect(drive.calls).not.toContain('deleteComment');
R9	expect(drive.comments.get(DOC)).toEqual([]);
R9	expect(sent).toEqual([
R9	expect(notes).toContain('«Все комментарии» без привязки к тексту');
R9	expect(notes).toContain('цитатой «со счётом 2:1»');
R9	expect(data.map.nextTable).toEqual({ row: 6, headerRow: 7, blankRows: 1 });
R9	expect(data.rows).toHaveLength(3);
R9	expect(whole.map.nextTable).toBeUndefined();
R9	expect(whole.rows).toHaveLength(3);
R9	await expect(
R9	expect(client.writes).toHaveLength(0);
R9	import { expect } from 'vitest';
R9	await expect(
R9	expect(client.applied).toHaveLength(0);
Y1	expect(byName.get('Мин, ч')).toMatchObject({ hasFormula: true });
Y1	expect(byName.get('Обычно, ч')).toMatchObject({
Y1	expect(preview.error).toBeUndefined();
Y1	expect(plan.status).toBe('preview');
Y1	expect(plan.changes.map((c) => [c.a1, c.after])).toEqual([
D7	expect(plan.notes).toContain(
D7	expect(plan.notes.join('\n')).toMatch(/«24» нет в списке, выведенном по уже записанному/);
D7	expect(written.error).toBeUndefined();
D7	expect((written.data as ApplyOutcome).status).toBe('ok');
D7	expect(after[6]!.slice(1, 4).map((c) => c?.value)).toEqual([16, 24, 32]);
B36	expect(after.slice(35, 38).map((r) => r[1]?.formula)).toEqual([
Y2	expect(blocked.error).toMatchObject({ code: 'write_blocked', cause: 'formula_column' });
Y2	expect(outcome.status).toBe('confirm_required');
Y2	expect(outcome.notes.join('\n')).toMatch(/задевает формулу — это решает человек кодом плана/);
Y2	await expect(
Y2	expect(outcome.status).toBe('preview');
B2	expect(outcome.changes.map((c) => c.a1)).toEqual(['Итоги!B2']);
Y4	expect(map.dataRowCount).toBe(4);
Y4	expect(map.nextTable).toEqual({ row: 12, headerRow: 13, blankRows: 1 });
Y4	expect(map.warnings).toContain(
Y4	expect(byName.get('Мин, ч')).toMatchObject({ hasFormula: false });
Y4	expect(byName.get('Обычно, ч')).toMatchObject({ enumValues: null, enumSource: null });
B7	expect(plan.changes.map((c) => c.a1)).toEqual(['Оценка!B7', 'Оценка!C7', 'Оценка!D7']);
B7	expect(plan.notes.join('\n')).not.toMatch(/других строках|выведенном по уже записанному/);
B7	expect(values.rows.value).toHaveLength(4);
B7	expect(values.truncated).toBe(false);
Y4	expect((found.data as ApplyOutcome).questions).toMatchObject([
Y4	expect(data.map.nextTable).toEqual({ row: 5, headerRow: 6, blankRows: 1 });
Y4	expect(data.rows).toHaveLength(2);
Y5	expect(data.map.nextTable).toBeUndefined();
Y5	expect(data.rows).toHaveLength(rows.length - 1);
Y6	await expect(
Y6	expect(data.map.nextTable).toEqual({ row: 13, headerRow: 14, blankRows: 2 });
A11	expect(plan.changes.map((c) => c.a1)).toEqual(['Оценка!A11']);
A11	expect(enveloped.status).toBe('confirm_required');
A11	expect(c.writes).toHaveLength(0);
A11	expect(policyRules()).toHaveLength(71);
-	expect(parseTargetUrl(`https://drive.google.com/drive/u/2/folders/${ID}`)).toEqual({
-	expect(parseTargetUrl(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit#gid=0`)).toEqual({
-	expect(parseTargetUrl(`https://docs.google.com/document/u/0/d/${ID}/edit`)?.type).toBe('doc');
-	expect(parseTargetUrl(`https://docs.google.com/forms/u/3/d/${ID}/edit`)?.type).toBe('form');
-	expect(parseTargetUrl(`https://drive.google.com/u/1/open?id=${ID}`)?.id).toBe(ID);
-	expect(parseTargetUrl(`https://drive.google.com/drive/u/x/folders/${ID}`)).toBeNull();
Q40	expect(labeled.status).toBe('preview');
B14	expect(labeled.changes).toMatchObject([{ a1: 'Отчёт!B14', after: 'почти готово' }]);
B14	expect(labeled.notes).toContain(
A14	expect(unlabeled.changes).toMatchObject([{ a1: 'Отчёт!A14', after: 'почти готово' }]);
```

Привязаны к примерам: **A11 A14 B14 B2 B36 B7 D7 L28 Q40 R0 R1 R2 R3 R9 T1 Y1 Y2 Y4 Y5 Y6 Z10 Z11 Z12 Z13 Z14 Z15 Z16 Z17 Z18 Z19 Z4 Z6 Z7 Z8 Z9**. Остальные 76 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 76

## Ревью ожиданий

- **asserts_reviewed_by:** human:anton at=2026-11-27 (слово владельца в сессии: ответ «Подписываю» на вопрос с
  вариантами — в вопросе названы 281 новая или изменённая проверка цепочки PR #24 + #25 относительно `main`, 205
  привязанных к примерам спеки и 76 непривязанных (тексты отказов и превью, коды ошибок, статусы места по
  цитате, вызовы фейка Drive и Docs) и путь к полному списку; дайджест выше — тот же, база `main`)
