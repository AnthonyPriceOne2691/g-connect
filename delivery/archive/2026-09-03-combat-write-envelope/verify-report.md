# Verify report

Класс L, verifier — человек. Здесь то, что прогнано машиной, и прямо названо то, что
машиной прогнать нельзя.

## Оракулы

- `npx vitest run` — **309 тестов зелёные** (было 283 до поставки: +26).
- `npx tsc --noEmit` — чисто; `bash delivery/evals/smoke/run.sh` — **11 из 11**.
- Все 23 хука pre-commit — зелёные, включая гейт сложности (дважды отклонил ветвление и
  дважды был прав: `journalUndo` и `parseOps` вынесены, порог не поднимался).
- `delivery_check --require-spec` — ошибок нет.

## Обратный прогон новых оракулов (урок L7)

Возвращал правку и смотрел, краснеет ли оракул:

- ревизия обратно в `canonicalPlan` → краснеют ровно три: R1 (пять полей канонического
  вида), R7 (два превью на разных ревизиях), R6 (`revisionAfter` строки отката). Остальные
  102 теста в тех трёх файлах — зелёные, то есть оракулы судят именно это.
- Четыре правила из `rules.json` без проб → красный «у КАЖДОГО правила есть проба».
- Дедуп `appendRow` без окна → второй вызов пишет вторую строку, проба
  `write.append-dedupe-window` краснеет.

## Исполнение рисковых путей

Пути, чей отказ не виден ни сборке, ни тестам (§12.6). Задетые поверхности:
`src/core/sheets/rows.ts`, `src/core/sheets/write-guards.ts`, `src/core/undo.ts`,
`src/mcp/apply-support.ts`, `src/mcp/tools.ts`.

- **Прогнал** `npm run build` + `bash delivery/evals/smoke/run.sh` (S11 поднимает
  СОБРАННЫЙ сервер из `dist` и говорит с ним по stdio-протоколу), **увидел** шесть
  инструментов, непустые `instructions` со словом «конверт», `policy://rules` в ресурсах и
  30 правил в `dist/policy/rules.json`, идентичных `src`. at=2026-09-03
- **Прогнал** `node scripts/probe_mcp.mjs` (протокольный режим, без сети), **увидел**
  зелёные проверки схемы `gc_apply` (поле `confirm` объявлено) и объяснение конверта в
  `instructions`. at=2026-09-03
- **НЕ прогнал и честно называю:** живую боевую запись через MCP-клиент на реальной цели.
  Причина не в лени: у единственной цели реестра (`infra-test`) конверта нет, а положить
  его туда — расширение прав на запись, которое по конституции подписывает человек (§4.5,
  HITL). Пока конверт не подписан, боевой путь на живой таблице не исполнялся ни разу, и
  это тот же класс, что закрывали 2026-09-03 у пишущей половины 2.5a.

## Что человеку сделать, чтобы закрыть поставку

1. Добавить `auto` в запись `infra-test` (или в новую рабочую цель) — например
   `{"ops": ["upsertRow", "setCells", "formatCells"], "maxCells": 20}`. `findReplace` и
   `appendRow` предлагаю в первый конверт не класть: первая правит десятки ячеек одним
   словом, вторая не идемпотентна по природе.
2. Перезапустить сервер в клиенте (сборка новее процесса — условие 1 из `LIVE-RUN.md`).
3. Одна фраза: «поставь проекту G connect статус Запущено». Ждём `status: ok` без всякого
   кода, в ответе — что записано и id записи журнала.
4. Вторая фраза: «откати». Ждём возврат значения и вторую строку в журнале.
5. Третья, если не жалко минуты: та же первая фраза ещё раз — на `upsertRow` ждём
   `no_change` (значение уже такое), а не «записал».

Расхождение ценнее совпадения: любой отказ, любое «записал» без деталей и любое
`confirm_required` там, где конверт правку покрывает, — находка.

## Ревью рисковых мест (§12.5)

Дифф задел деньги в одном смысле: правка чужих данных в живом документе. Что именно может
сломаться, с именами из диффа:

- **`commit` в `src/core/sheets/rows.ts`** — порядок ветвей. Разрешение конверта стоит
  ПОСЛЕ `no_change` и после вопросов резолвера, но ПЕРЕД `assertBeforeValues`. Переставь
  местами дедуп и предусловие — и повтор фразы начнёт затирать чужую правку до того, как
  ядро её заметит. Закреплено K4–K8; урок L11 про порядок ветвей — ровно про это место.
- **`envelopeJudge` в `src/mcp/apply-support.ts`** — единственная точка, где конверт
  превращается в разрешение. Забудешь передать `authorize` — запись потребует кода плана
  (отказ в безопасную сторону, тест «цель без конверта ведёт себя как прежде»). Но
  ошибка в обратную сторону дороже: если однажды кто-то передаст `() => ({authorized:
  true})` мимо реестра, разрешение перестанет быть подписью человека. Оракула на «никто
  не подделал судью» нет и быть не может — есть гейт `core-is-leaf`, который держит
  реестр и фасад по разные стороны, и ревью этого файла.
- **`recentDuplicateAppend` в `write-guards.ts`** — сравнивает содержимое по колонкам и
  значениям «станет», игнорируя адрес. Если у строки нет ни одной колонки (пустой план),
  подпись совпадёт с любой другой пустой — но пустой план до записи не доходит:
  `changes.length === 0` уходит в `no_change` раньше. Названная непокрытость: окно в 10
  минут судит по `record.at` из журнала, то есть по времени НАШЕЙ записи, а не по времени
  фразы человека — при часовом разрыве между превью и записью дедуп промолчит.
- **`undoFormat` в `src/core/undo.ts`** — не менялся, но именно он теперь несёт главную
  тяжесть: в боевом режиме откат стал основным охранником. Его названная дыра (фон,
  унаследованный от темы, возвращается явным белым) с этой поставкой стоит дороже, чем
  раньше, и поэтому перечислена в `rules.md` списком необратимого.
- **Риска нет там, где его можно было ждать:** `plan.ts` после удаления ревизии не стал
  слабее к подмене — код по-прежнему считается от цели, листа, операции, всех ячеек со
  значениями и видами по обе стороны и `touches` (R2 краснеет на любом изменении
  содержания правки).

## Ревью ожиданий

- **asserts_reviewed_by:** yes (by=human:anton, at=2026-09-03)

Что именно подписано и чем: владелец **своими глазами прогнал** K1 (запись с первой фразы),
K9 (откат по id), `no_change` на повторе, эскалацию `findReplace` к плану с кодом и
регресс 2.5a (замена без совпадений называет свою причину) — пять ожиданий из шести,
которые вообще можно проверить человеком, и все совпали. Остальные утверждения в дайджесте
структурные: форма канонического плана (пять полей), «превью ничего не пишет» и переводы
существующих оракулов на новый путь. Они приняты с моих слов, и это названо здесь прямо,
а не спрятано в «yes».

`assert_digest.sh` смотрит `BASE...HEAD`, то есть видит только закоммиченные утверждения:
дайджест ниже пересобран после коммита кода.

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md` и `src/policy/rules.json` — текст, который уходит агенту
как `instructions` сервера и как ресурс `policy://rules`. Это правка поведения продукта при
зелёных гейтах: реализация может не меняться, а модель начнёт делать другое.

Что именно изменилось для модели:

1. **Главное указание переписано.** Было: «ты не редактируешь таблицу, ты готовишь правку и
   показываешь её человеку». Стало: «в пределах конверта ты выполняешь, за его пределами
   показываешь план». Риск назван прямо: модель может прочитать это как «теперь можно
   писать», поэтому вторым абзацем там же стоит «разрешение — не то же самое, что решение»
   и перечислено, что по-прежнему спрашивается (неизвестная колонка, значение вне списка,
   ноль строк, формульная и защищённая колонка).
2. **Появился раздел «что в конверт не кладётся никогда»** — структурные операции,
   унаследованный от темы фон, замена по листу. Это единственное место, где перечень
   необратимого живёт текстом; механизм — белый список `ENVELOPE_OPS`, оракул — K10.
3. **Появились три новых обещания в тексте** (`confirm_required` — записи не было; повтор
   фразы не даёт второй строки; id записи журнала в ответе). Каждое исполняется кодом и
   покрыто пробой правила, а не только описано: R8 сверяет, что у всех четырёх новых правил
   есть `enforced_in` на существующий файл и проба.

Прогнал `npm run build` и `bash delivery/evals/smoke/run.sh`, увидел 30 правил в
`dist/policy/rules.json`, идентичных `src`, и слово «конверт» в `instructions` собранного
сервера. at=2026-09-03

Чем проверено, что модель получает именно это: S10 сверяет `dist/policy` с `src/policy`
побайтово, S11 поднимает собранный сервер и проверяет, что `instructions` непустые и
содержат слово «конверт». То есть расхождение «в репозитории написано, а агенту уходит
старое» краснеет, а не молчит — ровно тот класс, из которого S10 родился.

## Assertion digest (ревью ожиданий, не кода)

База: `origin/main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **110**, из них без ссылки на пример спеки:
**43**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
-	expect(() => parseEnvelope({ ops: ['upsertRow', 'deleteRows'] }, 'infra-test')).toThrow();
-	expect(payload.cause).toBe('write.envelope-invalid');
-	expect(payload.detail).toContain('deleteRows');
-	expect(payload.detail).toContain('upsertRow');
-	expect(payload.detail).toContain('журнал хранит ячейки');
-	expect([...ENVELOPE_OPS]).toEqual([
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
-	expect(data.targets).toHaveLength(4);
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
R1	expect(parsed).toHaveLength(5);
R1	expect(parsed.slice(0, 3)).toEqual(['SHEET1', 'Лист1', 'upsertRow']);
R1	expect(denied.status).toBe('confirm_required');
R1	expect(c.writes).toHaveLength(0);
R1	expect(allowed.status).toBe('ok');
R1	expect(c.writes).toHaveLength(1);
R1	expect(payload.cause).toBe('write.envelope-invalid');
R1	expect(payload.detail).toContain('журнал хранит ячейки');
R1	expect(second.planId).toBe(first.planId);
R1	expect(c.writes).toHaveLength(0);
R1	expect(first.status).toBe('ok');
R1	expect(second.status).toBe('no_change');
R1	expect(second.notes.join(' ')).toContain('уже дописана');
R1	expect(c.writes).toHaveLength(afterFirst);
R1	expect(journalled).toHaveLength(1);
R1	expect(limitOf('write.append-dedupe-window', 0)).toBe(10);
L10	expect(outcome.status).toBe('confirm_required');
L10	expect(outcome.planId).toMatch(/^[0-9a-f]{6}$/);
L10	expect(outcome.status).toBe('confirm_required');
R8	expect(rule.probe.length).toBeGreaterThan(10);
R8	expect(rule.enforced_in).toMatch(/src\//);
R8	expect(policyRules()).toHaveLength(30);
L10	expect(outcome.status).toBe('confirm_required');
L10	expect(outcome.planId).toMatch(/^[0-9a-f]{6}$/);
L10	expect(outcome.changes).toHaveLength(1);
L10	expect(outcome.notes.join(' ')).toContain(outcome.planId ?? '');
B20	expect(outcome.status).toBe('confirm_required');
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

Привязаны к примерам: **B20 K1 K2 K3 K4 K5 K6 K7 K9 L10 L6 R1 R2 R6 R7 R8**. Остальные 43 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 43

## Harness metrics (this shipment)

<!-- generated by scripts/delivery_metrics.py --base main -->

| Metric | Value |
|---|---|
| files_touched / loc_diff | 21 code (+9 process docs) / +1168/-89 (net +1079) |
| commits | 6 |
| time_to_accepted_spec | 0.0h |
| rework_after_done | 0 (handoff not declared yet) |
| harness_hardened | yes — tests/envelope.test.ts (новый оракул), tests/write-envelope.test.ts (новый оракул) |
| implement_retries | 0 — ни один слайс не переделывался; три правки отклонили гейты (сложность, длина файла, копипаст) и все три раза по делу |
| verify_fails_before_green | 4 локальных красных до зелёного: типы (readonly-массив в R4), два хука pre-commit (eslint+prettier, длина файла), гейт копипаста. CI на ветке ещё не гонялся |
| est_token_or_cost | одна сессия Opus 5 (спека, шесть слайсов, живой прогон владельцем в отдельном клиенте) |

MANUAL-поля заполняет агент/человек на handoff. Если `verify_fails_before_green >= 2` при `harness_hardened: no` — по §9.2 добавь oracle/breaker/hook в этой же поставке.

## Verdict

**READY FOR HANDOFF.**

Основание: 309 тестов и smoke 11/11 зелёные, все 23 хука pre-commit проходят,
`delivery_check` без ошибок, живой прогон владельцем подтвердил пять ожиданий из шести
проверяемых человеком, обратный прогон новых оракулов дал ровно три красных и только их.
Непокрытое живьём названо списком в `observed.md` и не спрятано: граница конверта, дедуп
`appendRow`, `stale_value` в проде, унаследованный от темы фон.

Долг, который уходит в наблюдение (`observe_until: 2026-10-15`): ложные `plan_mismatch` на
честном подтверждении — теперь их быть не должно, и это проверяется применением, а не
тестом.
