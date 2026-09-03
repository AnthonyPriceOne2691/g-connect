# Verify report

Класс L, verifier — человек. Здесь то, что прогнано машиной, и прямо названо то, что
машиной прогнать нельзя.

## Оракулы

- `npx vitest run` — **363 теста зелёные** (было 326 на входе слайса 3: +37).
- `npx tsc --noEmit`, `npx eslint src tests`, `npx prettier --check` — чисто.
- `bash delivery/evals/smoke/run.sh` — **11 из 11**; `node scripts/probe_mcp.mjs` — зелёный.
- Все 23 хука pre-commit проходят. Правил 34, у каждого проба (оракул «у КАЖДОГО правила
  есть проба — и наоборот»).

## Что гейты отклонили по ходу — и почему были правы

Двадцать три отклонения за поставку, и ни одно не про форму:

- **Сложность (7):** перевод доменных запросов стал типизированной таблицей вместо
  одиннадцати `if`; `inverseOf` и тексты отката — тоже таблицами; `namedConfirmOutcome`,
  `decisionFor`, `journalUndo`, `parseOps` вынесены. Каждый вынос — ответ на «это разные
  вопросы в одной функции».
- **Длина файла (6):** шов разделён на «ответ → домен» и «домен → запрос»; порядок строк
  уехал в `order-op.ts`, общие якоря — в `structure-support.ts`, разводка создания — в
  `run-create.ts`, схема входа `gc_apply` — в `apply-schema.ts` (её описания читает
  МОДЕЛЬ, и им место в файле, чей дифф видно).
- **Копипаст (4):** «история без откаченного» сведена в `standingWrites` — разъехавшись,
  копии дали бы «план уже записан» и «дубля нет» одновременно; резолв колонки-якоря — в
  `columnAnchored`; снимок тела колонки — один на удаление и на перенос; поля переноса в
  схеме — один объект на копирование и вырезание.
- **Слои (1):** вынос структурного отката создал цикл `undo → undo-structure → undo`;
  общие типы уехали вниз в `undo-types.ts`, а не развернули слой импортом обратно.
- **eqeqeq, неиспользуемые импорты, readonly-массивы в тестах (5)** — мелочь, но каждая
  правка честная.

**Снимок гейта дублей пере-снят 0 → 1** с названной причиной: остаток — ПОДПИСЬ функции
(`deleteColumns` и `autoFill` имеют одинаковый список параметров и одинаковый трёхстрочный
преамбул после выноса `columnAnchored`). Дальше «дедуплицировать» значило бы слить две
несвязанные операции. Ратчет продолжает работать: следующий настоящий дубль даст 2.

## Обратный прогон новых оракулов (урок L7)

- Ревизия обратно в подпись плана → краснеют ровно три оракула (R1, R6, R7).
- Правило без пробы → красный «у каждого правила есть проба».
- `lastUndoable` без ветки на структуру → `gc_undo` отвечает «откатывать нечего» сразу
  после успешной вставки. **Эту дыру нашёл сам оракул G3**, а не ревью: запись без ячеек
  считалась неоткатываемой, а у структурной правки ячеек не бывает вовсе.
- Наивный обратный ход перемещения (`вернуть туда, откуда взяли`) → красный оракул на
  числах из документации Google.

## Исполнение рисковых путей

Задетые поверхности: `src/core/google/sheets.ts`, `src/core/google/requests.ts`,
`src/core/google/drive.ts`, `src/core/undo-structure.ts`, `src/core/sheets/*`, `src/mcp/*`.

- **Прогнал** `npm run build` + `bash delivery/evals/smoke/run.sh` (S11 поднимает
  СОБРАННЫЙ сервер из `dist` и говорит с ним по протоколу), **увидел** шесть инструментов,
  девятнадцать операций в схеме `gc_apply`, 34 правила в `dist/policy/rules.json`,
  идентичных `src`. at=2026-09-04
- **Прогнал** `node scripts/probe_mcp.mjs` (протокольный режим), **увидел** зелёные
  проверки схемы и `instructions` со словом «конверт». at=2026-09-04
- **НЕ прогнал и честно называю:** ни одной структурной записи на живой таблице. Причина
  по построению: подтверждение названием произносит человек, а проба, называющая предмет
  правки сама, проверяла бы передачу строки между двумя вызовами, а не подпись (урок
  L15). Чек-лист — `live-run.md` этой поставки, пять пар фраз, каждая возвращает таблицу к
  исходному виду.
- **Самое непроверенное место — `moveDimension`.** У Google на него пустой ответ, формула
  обратного хода выведена из документации и покрыта оракулом на числах (включая пример
  Google `0,1,2,3,4` → `0,3,1,2,4`), но глазами на живой таблице не виделась. В чек-листе
  она отдельным необязательным пунктом, и я бы его не пропускал.

## Ревью рисковых мест (§12.5)

Дифф задел безопасность в одном смысле: правки, которые уничтожают данные.

- **`assertSnapshotBudget` в `structure-support.ts`** — единственное, что стоит между
  «удалить 5000 ячеек» и «удалить без возможности вернуть». Порядок вызова важен: он стоит
  ДО `finishWrite`, то есть до подтверждения и до записи. Переставь его после — и человек
  получит отказ уже после того, как назвал предмет правки, но данные ещё не потеряет;
  убери вовсе — потеряет.
- **`SNAPSHOT_ONLY` в `undo-structure.ts`** — множество форм, у которых обратной операции
  нет. Попади сюда `deleteRows` по ошибке — откат зальёт снимок в НЕ ВОССТАНОВЛЕННУЮ
  геометрию, то есть затрёт живые строки ниже. Оракул G7 это ловит (строка возвращается на
  своё место), но перечисление стоит читать глазами при каждой новой форме.
- **`inverseMove` в `move-math.ts`** — арифметика, чья ошибка выглядит как успех. Покрыта
  оракулом на числах из документации; на живой таблице не проверялась.
- **`undoCreate` в `undo-structure.ts`** — отправляет в корзину файл по `fileId` из
  журнала. Если `fileId` окажется чужим (журнал подменили руками), откат отправит в
  корзину чужой файл. Названная непокрытость: журнал — доверенный источник, и защиты от
  его подмены нет и не планируется.
- **`runCreate` в `run-create.ts`** — проверяет, что цель папка, но право по-прежнему
  даёт `assertWritable` до него. Порядок: сначала право, потом тип цели.
- **Риска нет там, где его можно было ждать:** `deleteSheet` не удаляет единственный лист
  книги (`last_sheet`), `duplicateSheet` не удаляется откатом, если копию правили
  (`copy_changed`), а вставка не откатывается, если во вставленное написали
  (`inserted_not_empty`).

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md` и `rules.json` — текст, который уходит агенту как
`instructions` и как ресурс `policy://rules`.

1. **Прежний текст стал ложью и это исправлено.** Раздел «Про строки, колонки и листы»
   утверждал: «сортировки, перемещения строк, копирования, вырезания и автозаполнения нет
   — не предлагай их». Теперь всё это есть, и агент, читающий старый текст, отказывал бы
   человеку в том, что продукт умеет. Это ровно тот класс, про который §14.4: реализация
   поменялась, а молчало бы всё, кроме этой строки.
2. **Названо, чего по-прежнему нет** — с причиной, а не списком: произвольный
   прямоугольник (выделения в продукте нет по построению), объединение ячеек, условное
   форматирование, проверка данных, Docs.
3. **Добавлены три обещания:** подтверждение названием требуют шесть правок; создание
   файла идёт в папку из реестра и права записи не даёт; откат удаления листа называет,
   чего не вернул. Каждое исполняется кодом и покрыто пробой правила.

Прогнал `npm run build` и smoke, увидел 34 правила в `dist/policy/rules.json`, идентичных
`src`, и обновлённый `rules.md` в собранном сервере. at=2026-09-04

## Ревью ожиданий

- **asserts_reviewed_by:** deferred (reason=ожидания выведены из примеров G1–G17 подписанной спеки и из документации Google для арифметики перемещения; непривязанные в дайджесте — структурные, про форму плана и про «превью не пишет». Подпись закрывается вместе с живым прогоном до handoff — тем же заходом, которым владелец проходит `live-run.md`)
## Assertion digest (ревью ожиданий, не кода)

База: `origin/main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **273**, из них без ссылки на пример спеки:
**145**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
G13	expect(() => parseEnvelope({ ops: ['upsertRow', 'deleteRows'] }, 'infra-test')).toThrow();
G13	expect(payload.cause).toBe('write.envelope-invalid');
G13	expect(payload.detail).toContain('deleteRows');
G13	expect(payload.detail).toContain('названием');
G13	expect(payload.detail).toContain('upsertRow');
-	expect([...ENVELOPE_OPS]).toEqual([
-	expect(ENVELOPE_OPS).not.toContain(op);
-	for (const op of NAMED_CONFIRM_OPS) expect(ENVELOPE_OPS).not.toContain(op);
-	expect(verdict.authorized).toBe(false);
-	expect(verdict.authorized === false && verdict.reason).toContain('назвать');
-	expect(() => parseEnvelope({ ops: [] }, 'x')).toThrow();
-	expect(() => parseEnvelope({ ops: 'upsertRow' }, 'x')).toThrow();
-	expect(() => parseEnvelope(['upsertRow'], 'x')).toThrow();
-	expect(() => parseEnvelope({ ops: ['upsertRow'], maxCells: 0 }, 'x')).toThrow();
-	expect(() => parseEnvelope({ ops: ['upsertRow'], maxCells: 1.5 }, 'x')).toThrow();
-	expect(detail).toContain('write.max-changes');
-	expect(detail).toContain('500');
-	expect(parseEnvelope(undefined, 'x')).toBeNull();
-	expect(parseEnvelope(null, 'x')).toBeNull();
-	expect(parseEnvelope({ ops: ['setCells'] }, 'x')?.maxCells).toBe(DEFAULT_MAX_CELLS);
K2	expect(verdict.authorized).toBe(false);
K2	expect(verdict.authorized === false && verdict.reason).toContain('нет конверта');
-	expect(verdict.authorized).toBe(false);
-	expect(verdict.authorized === false && verdict.reason).toContain('findReplace');
-	expect(verdict.authorized === false && verdict.reason).toContain('upsertRow');
K3	expect(verdict.authorized).toBe(false);
K3	expect(verdict.authorized === false && verdict.reason).toContain('60');
K3	expect(verdict.authorized === false && verdict.reason).toContain('50');
-	expect(envelopeAuthorizes(envelope(), 'upsertRow', 1).authorized).toBe(true);
-	expect(envelopeAuthorizes(envelope({ maxCells: 50 }), 'setCells', 50).authorized).toBe(true);
-	expect(preview.status).toBe('preview');
-	expect(failure.payload.code).toBe('stale_value');
-	expect(failure.payload.cause).toBe('format_changed_after_preview');
-	expect(client.writes).toHaveLength(0);
-	expect(data.targets).toHaveLength(5);
-	expect(data.targets.find((t) => t.alias === 'log')?.auto).toBeNull();
-	expect(data.targets.find((t) => t.alias === 'combat')?.auto).toMatchObject({ maxCells: 2 });
-	expect(String(data.targets.find((t) => t.alias === 'broken')?.auto)).toContain('deleteRows');
R6	expect(undone?.revisionBefore).toBe('rev-1');
R6	expect(undone?.revisionAfter).toBe('rev-1');
K1	expect(result.ok).toBe(true);
K1	expect(data.status).toBe('ok');
L6	expect(data.correlationId).toBeDefined();
L6	expect(data.hint).toContain('gc_undo');
L6	expect(journalled).toHaveLength(1);
L6	expect(journalled[0]?.correlationId).toBe(data.correlationId);
K9	expect(undone.status).toBe('ok');
K9	expect(undone.restored[0]?.value).toBe(2);
K9	expect(journalled.map((r) => r.op)).toEqual(['upsertRow', 'undo']);
K3	expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
K3	expect(data.notes.join(' ')).toContain('конверт');
K3	expect(data.status).toBe('ok');
K3	expect(journalled.some((r) => r.op === 'setCells' && r.changes.length > 2)).toBe(false);
K3	expect(client.writes.length).toBeLessThanOrEqual(2);
-	expect(result.ok).toBe(false);
-	expect(result.error?.cause).toBe('write.envelope-invalid');
-	expect(client.writes).toHaveLength(0);
-	expect(data.status).toBe('confirm_required');
-	expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
-	expect(client.writes).toHaveLength(0);
K4	expect(data.status).toBe('needs_clarification');
K4	expect(data.questions[0]?.available).toContain('Часы');
K4	expect(client.writes).toHaveLength(0);
K5	expect(data.status).toBe('needs_clarification');
K5	expect(data.questions[0]?.reason).toBe('not_in_enum');
K5	expect(client.writes).toHaveLength(0);
K6	expect(result.ok).toBe(false);
K6	expect(result.error?.cause).toBe('formula_column');
K6	expect(applied.writes).toHaveLength(0);
K7	expect(first.status).toBe('ok');
K7	expect(second.status).toBe('no_change');
K7	expect(second.notes.join(' ')).toContain('уже дописана');
K7	expect(journalled.filter((r) => r.op === 'appendRow')).toHaveLength(1);
G15	expect(preview.status).toBe('preview');
G15	expect(drive.created).toHaveLength(0);
G15	expect(data.status).toBe('ok');
G15	expect(drive.created[0]).toMatchObject({
G15	expect(data.notes.join(' ')).toContain('drive.google.com');
G15	expect(data.notes.join(' ')).toContain('Права записи у нового файла нет');
G15	expect(journalled[0]?.structure).toMatchObject({ kind: 'createFile' });
G15	expect(journalled[0]?.structure?.fileId).toBe('FILE1');
G15	expect(undone.status).toBe('ok');
G15	expect(drive.trashed).toEqual(['FILE1']);
G15	expect(undone.structureUndone).toContain('корзину');
G15	expect(undone.structureUndone).toContain('руками');
G15	expect(journalled.some((r) => r.op === 'undo')).toBe(true);
G16	expect(result.ok).toBe(false);
G16	expect(result.error?.cause).toBe('create_needs_folder');
G16	expect(drive.created).toHaveLength(0);
G16	expect(result.ok).toBe(false);
G16	expect(result.error?.cause).toBe('write.allowlist');
G16	expect(client.writes).toHaveLength(0);
-	expect(movedStart(1, 2, 4)).toBe(2);
-	expect(movedStart(2, 3, 9)).toBe(6);
-	expect(inverseMove(2, 3, 9)).toEqual({ from: 6, to: 2 });
-	expect(movedStart(6, 3, 2)).toBe(2);
-	expect(movedStart(7, 2, 1)).toBe(1);
-	expect(inverseMove(7, 2, 1)).toEqual({ from: 1, to: 9 });
-	expect(movedStart(1, 2, 9)).toBe(7);
-	expect(movedStart(3, 4, 5)).toBe(3);
-	expect(denied.status).toBe('confirm_required');
-	expect(after.sheets[0]?.rows[2]?.[1]?.value).toBe('lash-try-on');
-	expect(journalled[0]?.structure).toMatchObject({ kind: 'moveRows', to: 2 });
-	expect(undone.structureUndone).toContain('прежнее место');
-	expect((await client.getSpreadsheet()).sheets[0]?.rows[2]?.[1]?.value).toBe('G connect');
-	await expect(
-	expect(preview.structural).toMatchObject({ kind: 'sortRange', count: 2 });
-	expect(preview.structural?.confirmPhrase).toContain('Проект');
-	expect(after.sheets[0]?.rows[2]?.[1]?.value).toBe('G connect');
-	expect(journalled[0]?.snapshots?.[0]?.rows).toHaveLength(2);
-	expect(undone.structureUndone).toContain('снимка');
-	await expect(sortRange(client, buildSheetData(single), 'Проект', {})).rejects.toMatchObject({
G2	expect(parsed).toHaveLength(6);
G2	expect(parsed.slice(0, 3)).toEqual(['SHEET1', 'Лист1', 'upsertRow']);
G2	expect(parsed[5]).toEqual([]);
G2	expect(denied.status).toBe('confirm_required');
G2	expect(c.writes).toHaveLength(0);
G2	expect(allowed.status).toBe('ok');
G2	expect(c.writes).toHaveLength(1);
G2	expect(payload.cause).toBe('write.envelope-invalid');
G2	expect(payload.detail).toContain('названием');
G2	expect(snap?.rows[0]?.map((cell) => cell.value)).toContain('lash-try-on');
G2	expect(undone.restored.length).toBeGreaterThan(0);
G2	expect(JSON.stringify((await c.getSpreadsheet()).sheets[0]?.rows)).toContain('lash-try-on');
G2	expect(denied.status).toBe('confirm_required');
G2	expect(allowed.status).toBe('ok');
L5	expect(undone.status).toBe('ok');
L5	expect(undone.notRestored?.join('; ')).toContain('условного форматирования');
L5	expect(payload.code).toBe('policy_denied');
L5	expect(payload.cause).toBe('write.snapshot-max-cells');
L5	expect(payload.detail).toContain('2000');
L5	expect(c.writes).toHaveLength(0);
L5	expect(limitOf('write.snapshot-max-cells', 0)).toBe(2000);
L5	expect(second.planId).toBe(first.planId);
L5	expect(c.writes).toHaveLength(0);
L5	expect(first.status).toBe('ok');
L5	expect(second.status).toBe('no_change');
L5	expect(second.notes.join(' ')).toContain('уже дописана');
L5	expect(c.writes).toHaveLength(afterFirst);
L5	expect(journalled).toHaveLength(1);
L5	expect(limitOf('write.append-dedupe-window', 0)).toBe(10);
L10	expect(outcome.status).toBe('confirm_required');
L10	expect(outcome.planId).toMatch(/^[0-9a-f]{6}$/);
L10	expect(outcome.status).toBe('confirm_required');
R8	expect(rule.probe.length).toBeGreaterThan(10);
R8	expect(rule.enforced_in).toMatch(/src\//);
R8	expect(policyRules()).toHaveLength(34);
-	expect(preview.status).toBe('preview');
-	expect(preview.changes).toHaveLength(2);
-	expect(preview.changes[0]).toMatchObject({ column: 'Статус', before: 'в работе', after: 2 });
-	expect(preview.structural?.anchor).toContain('Часы');
-	expect(after.sheets[0]?.rows[2]?.[2]?.value).toBe(2);
-	expect(undone.structureUndone).toContain('получатель');
-	expect((await client.getSpreadsheet()).sheets[0]?.rows[2]?.[2]?.value).toBe('в работе');
-	await expect(
-	expect(outcome.status).toBe('confirm_required');
-	expect(outcome.notes.join(' ')).toContain('Часы');
-	expect(afterCut.sheets[0]?.rows[2]?.[2]?.value).toBe(2);
-	expect(afterCut.sheets[0]?.rows[2]?.[3]?.value).toBeNull();
-	expect(journalled[0]?.snapshots).toHaveLength(2);
-	expect(undone.structureUndone).toContain('обе колонки');
-	expect(afterUndo.sheets[0]?.rows[2]?.[3]?.value).toBe(2);
-	expect(afterUndo.sheets[0]?.rows[2]?.[2]?.value).toBe('в работе');
-	expect(preview.structural).toMatchObject({ kind: 'autoFill', count: 1 });
-	expect(preview.structural?.anchor).toContain('образец из 1');
-	expect((await client.getSpreadsheet()).sheets[0]?.rows[3]?.[3]?.value).toBe(2);
-	expect(undone.structureUndone).toContain('снято');
-	expect((await client.getSpreadsheet()).sheets[0]?.rows[3]?.[3]?.value).toBeNull();
-	await expect(autoFill(client, data(), 'Часы', {})).rejects.toMatchObject({
-	expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).toContain('Лист1 копия');
-	expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).not.toContain('Лист1 копия');
A9	await expect(
L10	expect(outcome.status).toBe('confirm_required');
L10	expect(outcome.planId).toMatch(/^[0-9a-f]{6}$/);
L10	expect(outcome.changes).toHaveLength(1);
L10	expect(outcome.notes.join(' ')).toContain(outcome.planId ?? '');
B20	expect(outcome.status).toBe('confirm_required');
-	expect(request.insertDimension?.range).toEqual({
-	expect(request.insertDimension?.inheritFromBefore).toBe(false);
-	expect(request.deleteDimension?.range).toEqual({
-	expect(toRequest({ kind: 'addSheet', title: 'Октябрь' }).addSheet?.properties?.title).toBe(
-	expect(toRequest({ kind: 'deleteSheet', sheetId: 5 }).deleteSheet?.sheetId).toBe(5);
-	expect(renamed.updateSheetProperties?.properties).toEqual({
-	expect(renamed.updateSheetProperties?.fields).toBe('title');
L14	expect(planId(remove)).not.toBe(planId(base));
-	expect(planId({ ...base, structural: { ...base.structural!, at: 5 } })).not.toBe(planId(base));
-	expect(planId({ ...base, structural: { ...base.structural!, count: 2 } })).not.toBe(
-	expect(canonicalPlan(reordered)).toBe(canonicalPlan(base));
-	expect(planId(anchored)).not.toBe(planId(base));
F4	expect(planId(cellPlan)).toMatch(/^[0-9a-f]{6}$/);
F4	expect(JSON.parse(canonicalPlan(cellPlan))).toHaveLength(6);
-	expect(preview.status).toBe('preview');
-	expect(preview.structural).toMatchObject({ kind: 'insertRows', at: 3, count: 1 });
-	expect(preview.structural?.anchor).toContain('G connect');
-	expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
-	expect(preview.changes).toHaveLength(0);
-	expect(outcome.status).toBe('ok');
-	expect(journalled[0]?.structure).toMatchObject({ kind: 'insertRows', at: 3, count: 1 });
-	expect(afterWrite.sheets[0]?.rows[2]).toEqual([]);
-	expect(afterWrite.sheets[0]?.rows[3]?.[1]?.value).toBe('G connect');
-	expect(undone.status).toBe('ok');
-	expect(undone.structureUndone).toContain('удален');
-	expect(afterUndo.sheets[0]?.rows[2]?.[1]?.value).toBe('G connect');
B3	await expect(
B3	expect(forced.status).toBe('ok');
-	expect(outcome.status).toBe('ok');
-	expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).toContain('Октябрь');
-	expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).not.toContain('Октябрь');
-	await expect(addSheet(client, buildSheetData(book()), 'Инструкция', {})).rejects.toMatchObject({
-	expect(preview.structural).toMatchObject({ previousTitle: 'Лист1', title: 'Отчёт 2026' });
-	expect((await client.getSpreadsheet()).sheets[0]?.title).toBe('Отчёт 2026');
-	expect(undone.structureUndone).toContain('Лист1');
-	expect((await client.getSpreadsheet()).sheets[0]?.title).toBe('Лист1');
-	expect(preview.structural).toMatchObject({ kind: 'insertColumns', at: 3, count: 1 });
-	expect(preview.structural?.anchor).toContain('Статус');
-	expect(outcome.status).toBe('needs_clarification');
-	expect(outcome.questions[0]?.available).toContain('Статус');
-	await expect(insertRows(client, buildSheetData(book()), where, 0, {})).rejects.toMatchObject({
-	await expect(insertRows(client, buildSheetData(book()), where, 1.5, {})).rejects.toMatchObject({
-	expect(outcome.status).toBe('needs_clarification');
G5	expect(preview.status).toBe('preview');
G5	expect(preview.changes.map((c) => c.before)).toContain('lash-try-on');
G5	expect(preview.changes.every((c) => c.after === null)).toBe(true);
G5	expect(preview.structural).toMatchObject({ kind: 'deleteRows', count: 1 });
G5	expect(preview.structural?.confirmPhrase).toContain('lash-try-on');
-	expect(outcome.status).toBe('confirm_required');
-	expect(outcome.notes.join(' ')).toContain('lash-try-on');
-	expect((await client.getSpreadsheet()).sheets[0]?.rows).toHaveLength(4);
G6	expect(outcome.status).toBe('ok');
G6	expect(journalled[0]?.structure).toMatchObject({ kind: 'deleteRows' });
G6	expect(journalled[0]?.snapshots?.[0]?.rows[0]?.map((c) => c.value)).toContain('lash-try-on');
G6	expect(afterDelete.sheets[0]?.rows).toHaveLength(3);
G6	expect(JSON.stringify(afterDelete.sheets[0]?.rows)).not.toContain('lash-try-on');
G6	expect(undone.status).toBe('ok');
G6	expect(undone.structureUndone).toContain('значениями');
G6	expect(afterUndo.sheets[0]?.rows).toHaveLength(4);
G6	expect(afterUndo.sheets[0]?.rows[3]?.[1]?.value).toBe('lash-try-on');
G17	expect(outcome.status).toBe('ok');
-	expect(outcome.status).toBe('ok');
-	expect(outcome.status).toBe('confirm_required');
-	expect((await client.getSpreadsheet()).sheets[0]?.rows).toHaveLength(4);
-	expect(outcome.status).toBe('needs_clarification');
-	expect(preview.status).toBe('preview');
-	expect(lost).toContain('3 правил условного форматирования');
-	expect(lost).toContain('2 диаграмм');
-	expect(lost).toContain('1 проверок данных');
-	expect(lost).toContain('заметки к ячейкам');
-	expect(preview.structural?.confirmPhrase).toContain('Инструкция');
-	expect(outcome.status).toBe('ok');
-	expect((await client.getSpreadsheet()).sheets.map((s) => s.title)).not.toContain('Инструкция');
-	expect(undone.status).toBe('ok');
-	expect(back).toBeDefined();
-	expect(back?.properties).toMatchObject({ frozenRows: 1, tabColor: '#17365d' });
-	expect(JSON.stringify(back?.rows)).toContain('Реестр');
-	expect(undone.notRestored?.join('; ')).toContain('условного форматирования');
G9	expect(payload.cause).toBe('write.snapshot-max-cells');
G9	expect(payload.detail).toContain('2000');
G9	expect(payload.detail).toContain('4202');
-	await expect(deleteSheet(client, buildSheetData(single), {})).rejects.toMatchObject({
R7	expect(first.planId).toMatch(/^[0-9a-f]{6}$/);
R7	expect(second.planId).toBe(first.planId);
R7	expect(first.baseRevision).toBe('37');
R7	expect(second.baseRevision).toBe('39');
R7	expect(client.writes).toHaveLength(0);
R2	expect(other.planId).not.toBe(seven.planId);
-	expect(failure.payload.code).toBe('stale_value');
-	expect(failure.payload.cause).toBe('value_changed_after_preview');
-	expect(client.writes).toHaveLength(0);
-	expect(outcome.status).toBe('ok');
-	expect(outcome.correlationId).toBeDefined();
-	expect(journalled[0]?.correlationId).toBe(outcome.correlationId);
-	expect(journalled[0]?.planId).toBe(outcome.planId);
-	expect(client.writes).toHaveLength(1);
```

Привязаны к примерам: **A9 B20 B3 F4 G13 G15 G16 G17 G2 G5 G6 G9 K1 K2 K3 K4 K5 K6 K7 K9 L10 L14 L5 L6 R2 R6 R7 R8**. Остальные 145 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 145
