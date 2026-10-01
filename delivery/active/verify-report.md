# Verify report — Google Docs (уровень 3)

Класс L, verifier — человек. Здесь то, что прогнано машиной, и **прямо названо то, что
машиной прогнать нельзя**.

## Живая сверка шва и разбор читателя — 2026-10-01

Вход восстановлен владельцем; дальше — агентом по делегации («запускай»), **своим
процессом и на СВОИХ черновиках** (создать → проверить → в корзину), кодом продукта из
`dist`: `GoogleDocsClient`, построитель запросов, `table-math`, `tableUndoRequests`,
`snapshotRange`/`restoreRequests`, `runDoc*`, `undoDocLast`.

- **Арифметика таблиц — сошлась.** 9 пар «правка → наш откат» (строки и колонки в
  начале, середине, конце; таблица целиком; вставка таблицы) — каждый текст лёг в свою
  ячейку, таблица на месте. Живые числа: пустая 3×3 со стартом 16 — строки [17,24)
  [24,31) [31,38), таблица [16,39) (закрывающий юнит, которого не было в фейке), абзацы
  ячеек — с `cellStart + 1`. Эмодзи: ⚽ — 1 юнит, 🔥 — 2. После починок — **57/57**.
- **Находки живьём (LR3), все с оракулом, красным обратным прогоном:** LR3-1 ушедшая
  ревизия называлась `bad_request` — `withRetry` переводил ошибку раньше распознавателя;
  LR3-2 откат строки/колонки делал обычный текст жирным — новая строка копирует стиль
  образца; LR3-3 откат удаления/вставки таблицы оставлял пустой абзац — Google ставит
  `\n` перед таблицей; LR3-4 (чтением, затем живьём) обычный абзац перед заголовком
  возвращался заголовком; удаление абзаца вплотную к таблице падало «Invalid deletion
  range»; `insertPageBreak` режет абзац (2 юнита); картинка/чип/дата/разрыв — по 1 юниту
  без текста (объекты: **13/13** после починки); «в конец раздела» после завершающей
  таблицы — **4/4**; отказ Google по картинке приходил без совета.
- **Сверено живьём попутно:** ответ записи несёт ревизию «после», равную следующему
  чтению; удаление переноса пустого абзаца не трогает следующий (стиль и буллет его);
  точная маска стиля и снятие буллетов с абзаца без буллетов Google принимает;
  `revisionId` стабилен — 4 чтения за 2 минуты без правок, одна ревизия (в отличие от
  `version` Drive, урок L18).
- **Роль «читатель без прогона»** (подагент): 26 обещаний без механизма и 26 оракулов,
  проверявших соседнее. Закрыты с оракулами: повтор фразы делал правку дважды (поправка
  D-20: фраза + код плана, решение владельца), rules.md запрещал агенту правки Docs,
  объекты и смещения, `where` у объектов, предмет пустого абзаца, вид абзаца и стиль поле в
  поле при откатах, цепочка откатов и `force` (свежесть, повтор по id, слепой откат
  замены), исход записи после обрыва, `content.is-data`, предложения, бюджет стилей,
  `expectRevision`, P19/P19b, замена теряла стиль, «в конец раздела» перед таблицей,
  слабые оракулы (P7, P9, P10, P18, граница раздела, «вид цели до чтения», конверт у
  replaceText, enforced_in, probe_mcp зовёт пропуск зелёным). Конверт doc-операций 12
  вместо подписанных 8 — закрыт подписью владельца (decisions.md).

### Непокрытое после 2026-10-01 — названное вслух

1. **Чек-лист через ПРОТОКОЛ** (`gc_apply`/`gc_undo` своим процессом сервера на цели
   `doc-test`) не прогнан: цели нет в реестре, а реестр в `~/.gconnect` правит только
   владелец (текст строки отдан ему). Шов и операции видены живьём кодом продукта, но
   транспорт MCP, реестр и конверт на doc-цели — нет.
2. **Подпись человека** (L15): агентский прогон проверяет механику, не подпись.
3. `revisionId` сверен на окне 2 минуты; документированная смена «по внутренним причинам»
   на длинных интервалах не наблюдалась и не исключена.
4. Буллеты: по документации `createParagraphBullets` снимает ведущие табы, а
   `deleteParagraphBullets` добавляет отступ — фейк этого не моделирует, живьём не сверено.
5. Разрыв и картинка в разделе, кончающемся таблицей, встают в конец последнего абзаца
   перед ней — названо в правилах.
6. `human_ok_plan`, `asserts_reviewed_by`, waiver объёма — слово владельца.

## Оракулы

- `npx vitest run` — **496 тестов зелёные** (было 482 на входе слайса 7; на входе
  поставки — 404).
- `npx tsc --noEmit`, `npx eslint src tests`, `npx prettier --check` — чисто.
- `bash delivery/evals/smoke/run.sh` — **11 из 11**.
- `node scripts/probe_mcp.mjs` (протокол) — зелёный: схема собранного сервера отдаёт
  **39 операций против 39 в ядре**, из них **18 doc-операций**, `gc_read` объявляет
  `mode=text`, правила про адресацию документов на месте.
- Все хуки pre-commit проходят. Правил **39**, у каждого проба (оракул «у КАЖДОГО правила
  есть проба — и наоборот»).
- Мутационный гейт: **60.49 %** (было 58.81 % до добивки оракулами) при пороге
  `break: 50` — и это по-прежнему МЕНЬШЕ, чем обещала спека («не ниже 62 %»). Расхождение названо решением в
  `decisions.md`, а не подогнано: acceptance я написал строже факта, поставка добавила
  ~2400 строк логики, и прежние 63 % относились к вдвое меньшей площади. Что сделано
  дальше — ниже, в разделе «Прицельный мутационный прогон».

## Что гейты отклонили по ходу — и почему были правы

Двадцать одно отклонение, и ни одно не про форму:

- **Копипаст (7).** Швы: авторизация, hex-перевод и retry-обёртка `sheets`/`docs`
  сведены в `google/support.ts` — две копии разъехались бы молча, класс L21 внутри шва.
  Doc-операции: хвост записи (запрос → журнал → ответ) сведён в
  `write-support.commitDocWrite`, отказы подтверждения и конверта — в
  `namedConfirmRefusal` / `permissionRefusal`, резолв body-абзаца — в
  `resolveBodyParagraph`; выбор записи отката — в `undo-shared.pickUndoRecord`, пролог
  «снимок + таб» и «таб или отказ» — в `undo-docs`. Каждый вынос ответ на «третья копия».
- **Длина файла (5).** `read-doc.ts` из `tools.ts`; doc-схемы из `ops.ts` в `docs/ops.ts`
  с общим низом `op-fields.ts`; табличный откат из `undo-docs.ts` в `undo-docs-table.ts`.
- **Сложность (8).** Перевод абзаца разобран на `collectRuns`/`buildParagraph`, стиль —
  таблицей полей; фазы планирования, разрешения и записи разведены во всех четырёх
  семействах doc-операций; формы отката разводятся таблицей `docUndoForm`; вставка
  строки/колонки — одна форма со словарём осей `AXIS`.
- **Слои (1).** `DocOperationKind` уехал вниз в `docs/types.ts`: цикл
  `journal → sheets/write-types → journal`.
- Снимок дублей пере-снят **1 → 3** двумя решениями с названной ценой (`decisions.md`):
  фасады `undoLast` ↔ `undoDocLast` и сигнатуры семейства `DocUndoForm` равны по
  построению, дальнейшее слияние дало бы ветвление по виду цели внутри одного контура —
  ровно отклонённая альтернатива плана.

## Обратный прогон новых оракулов (уроки L7, L22)

Каждый ключевой оракул проверен изломом реализации — все красные:

| Излом | Что покраснело |
|---|---|
| Срез завершающего `\n` в шве выключен | 3 оракула границ абзацев |
| Селектор возвращает первое совпадение вместо вопроса | P10 |
| Граница раздела не смотрит на уровень заголовка | раздел «Составы» |
| Ревизия убрана из подписи плана | 1 оракул кода плана |
| `lastUndoable` снова не видит doc-записи | откат вставки (класс G3) |
| Охранник «вставленное не правлено» выключен | P4 |
| Восстановление стилей при откате выключено | P9 |
| Бюджет снимка не судит | P18 |
| Сдвиг позиций вхождений не считается | P7 |
| Откат замен идёт не с конца | P7 |
| Охранник пустоты строки/колонки выключен | откат вставки строки |
| Накопленный сдвиг колонок в арифметике | согласие с моделью |
| Безусловный возврат вида абзацев выключен | P11/P12 |
| Схема транспорта собрана из рукописного среза | 2 проверки `probe_mcp` |

**Обратный прогон нашёл слепой оракул** (то, для чего он и нужен): пороги `maxCells` и
`maxChars` в тесте совпадали, и подмена меры конверта была невидима. Добавлен разводящий
оракул: `maxCells: 1` не душит вставку в 100 юнитов, судит `maxChars`.

## Прицельный мутационный прогон по новым модулям

Гонял отдельно по `src/core/docs/*` + `undo-docs*`, чтобы увидеть выживших там, где
ошибка дороже всего, а не поднимать общий счёт ради числа.

| Модуль | Было | Стало | Что закрыто |
|---|---|---|---|
| `table-math.ts` | **94.4 %** | 94.4 % | самое опасное место поставки покрыто плотно с самого начала |
| `selectors.ts` | 53.6 % | **67.4 %** | ветки вопросов: номер строки/колонки вне диапазона, пустой селектор, повторяющийся заголовок, «якорь дважды в ОДНОЙ строке — это одна строка» |
| `table-op.ts` | 54.5 % | **60.6 %** | таблица по якорю ячейки, вставка колонки левее, отказ без размеров, требование кода плана без конверта |
| `style-op.ts` | 61.1 % | 66.7 % | отказы на пустом `style` и отсутствующем `namedStyle` |
| `write-support.ts` | 59.8 % | 67.0 % | тексты вопросов пустого и двойного селектора |
| `undo-docs-table.ts` | 60.0 % | см. итог | край сетки: последняя колонка возвращается на своё место, пустые ячейки — пустыми, «таблица записи не найдена», «таб исчез» |
| **Итого по новым модулям** | 60.7 % | **65.3 %+** | непокрытых мутантов 269 → 175 |

**Полный счёт по ядру: 58.81 % → 60.49 %.** Обещания спеки (62 %) он НЕ достиг, и я это
не подгоняю: остаток разрыва живёт не в новых модулях, а в старых, которые поставка
только задела (`create-op.ts` 35 %, `undo-structure.ts` 46 %, `ops.ts` 30 % — там мутанты
в основном на литералах схем и текстах, а не на логике). Гнать их вверх в ЭТОЙ поставке
значило бы переписывать оракулы уровня 2 под число; честнее назвать: acceptance-строка
не выполнена, разрыв 1.5 пункта, и он в чужой площади. Решение — в `decisions.md`.

Тесты добавлены двумя файлами — `doc-refusals.test.ts` (21 оракул) и
`doc-table-undo.test.ts` (6 оракулов): **517 тестов** вместо 496. Ни один из них не
«ловит мутанта» — каждый судит названное поведение: как ядро спрашивает и как отказывает.

**Два из них покраснели на моих неверных ожиданиях, и это тоже находка** (класс L7):
я ждал `ambiguous`, когда якорь встречается дважды в ОДНОЙ строке таблицы, — ядро право,
строка одна; и искал текст отказа в другом падеже. Оракул исправлен по поведению, а
поведение оставлено как было.

## Исполнение рисковых путей

Задетые поверхности: `src/core/google/docs.ts`, `src/core/google/doc-requests.ts`,
`src/core/docs/*`, `src/core/undo-docs*.ts`, `src/mcp/*`.

- **Прогнал** `npm run build` + smoke S11 (собранный сервер по протоколу) + `probe_mcp`
  в протокольном режиме, **увидел** 39 операций в схеме против 39 в ядре, 18
  doc-операций, `mode=text`, 39 правил в `dist/policy/rules.json`, идентичных `src`.
  at=2026-09-09
- **НЕ ПРОГНАЛ И ЧЕСТНО НАЗЫВАЮ: ни одной операции над живым документом.** Доступ к
  Google в состоянии `needs_reauth` (`hasToken: false`) — вход восстанавливает владелец.
  Это значит: **весь шов `documents.*` живьём не виделся ни разу за поставку.** Чек-лист —
  `live-run.md`, и он начинается с блока «Сверка арифметики ДО первой правки».
- **Самое непроверенное место — арифметика внутренностей таблиц** (`docs/table-math.ts`):
  вход в таблицу 1 юнит, в строку 1, в ячейку 1, пустой абзац ячейки 1. Это наше
  ПРОЧТЕНИЕ документации, согласованное с фикстурой оракулом на числах (вписанные по
  вычисленным точкам тексты попадают в свои ячейки), но не наблюдение. Промах здесь
  уничтожит содержимое соседних ячеек при откате удаления строки — поэтому в чек-листе
  сверка стоит ДО первой правки таблиц, с явным «расходится — стоп».
- **Второе непроверенное — семантика вставки объектов** (разрыв, картинка): в домене они
  один юнит без текста; живьём не виделись. Картинку Google скачивает сам, и его отказ по
  недоступному URL мы передаём человеку — тоже не наблюдали.
- **Распознавание `doc_changed` по тексту 400-ответа.** У отказа `writeControl` нет
  машинного кода причины, и мы ищем `revision` в сообщении. Если Google формулирует иначе
  — отказ приедет как общая ошибка записи (не порча, но текст будет хуже). Отдельный пункт
  чек-листа.

## Ревью рисковых мест (§12.5)

Дифф задел безопасность в одном смысле: правки, которые уничтожают текст.

- **`budgetedSnapshot` в `delete-op.ts`** — единственное, что стоит между «удалить пол-
  документа» и «удалить без возможности вернуть». Порядок важен: он ДО подтверждения и до
  записи; переставь после — человек подпишет удаление, которое нечем откатить.
- **`restoreRequests` в `undo-docs.ts`** — заливка снимка. Базовые флаги стиля шлются
  ЯВНО (включая `false`), потому что вставленный текст наследует стиль точки вставки:
  без явного сброса обычный кусок вернулся бы жирным. Названная цена: «явный false» и
  «поле не задано» — разные состояния модели Google при одинаковом виде.
- **`replacementsAfter` в `replace-op.ts`** — арифметика, чья ошибка выглядит как успех:
  позиции вхождений ПОСЛЕ правки считаются как `at + i×Δ` по табам. Ошибка сдвинула бы
  откат на соседний текст. Покрыта оракулом (излом «сдвиг не считается» — красный).
- **`fillCells` + `table-math` в `undo-docs-table.ts`** — то же самое для таблиц, и это
  самое опасное место поставки, потому что арифметика живьём не виделась (см. выше).
- **`assertImageSource` в `insert-op.ts`** — не даёт уйти в Google с локальным путём.
  Порядок: судится ДО построения запроса и до сети.
- **Класс «деньги»:** прямых денег в диффе нет. Цена ошибки здесь — контентные документы
  владельца (прогнозы, разборы, будущие SEO-ТЗ): текст, который писали руками. Всё
  уничтожаемое проходит через бюджет снимка, подтверждение названием и снимок в журнале.
- **Класс «транзакция БД»:** у Docs она есть, и это лучше, чем в Sheets — `batchUpdate`
  применяет пакет атомарно, «частично применилось» невозможно по построению. Поэтому
  откаты собираются ОДНИМ пакетом (структура + содержимое вместе).
- **Класс «интеграция»** (поднят `google/docs.ts`, `google/doc-requests.ts`): это и есть
  сетевой шов поставки. Переводы закреплены оракулами на числах из документации
  (`insertText.location.index`, полуинтервал `deleteContentRange`, `tableStartLocation`,
  `fields` ровно по заданным полям — иначе Google обнулит остальные). Живая таблица
  doc-запросов не видела — закрывается прогоном.
- **Класс «цепочка гейтов»** (`scripts/lint/jscpd_baseline.txt` 1 → 3): каждое
  пере-снятие названо решением с причиной в `decisions.md`; ратчет продолжает судить рост.
- **Риска нет там, где его можно было ждать:** `replaceAllText` не трогает вхождения в
  ячейках таблиц (считает и называет числом), удаление последнего абзаца сегмента уводит
  диапазон на перенос предыдущего (финальный `\n` неудаляем), откат вставки отказывает,
  если вставленное правили, откат таблиц отказывает, если структура уже не пуста.

## Непокрытое, названное вслух

1. ~~Живого прогона не было ни одного~~ — закрыто 2026-10-01 (раздел выше); осталось — чек-лист через протокол.
2. ~~Арифметика внутренностей таблиц и семантика объектов — прочтение документации~~ — сверено живьём 2026-10-01.
3. `doc_changed` распознаётся по тексту ответа Google — текст снят живьём 2026-10-01 и прибит оракулом шва.
4. Вне объёма по D-21: колонтитулы, сноски, разметка страницы, режим предложений,
   объединение ячеек, замена внутри ячеек таблиц, загрузка локальных картинок.
5. `human_ok_plan` стоит `deferred` (боевой контур владельца) — закрывается его словом
   вместе с прогоном, как в уровне 2.
## Assertion digest (ревью ожиданий, не кода)

База: `origin/main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **318**, из них без ссылки на пример спеки:
**299**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
-	expect(preview.status).toBe('preview');
-	expect(preview.changes[0]!.before).toContain('Устаревший прогноз на прошлый тур');
-	expect(preview.notes.join(' ')).toContain('удаляю абзац Устаревший');
-	expect(bareYes.status).toBe('confirm_required');
-	expect(bareYes.notes.join(' ')).toContain('предметом правки не называет');
-	expect(named.status).toBe('ok');
-	expect(after.tabs[1]!.paragraphs.map((x) => x.text).join(' ')).not.toContain('Устаревший');
-	expect(journalled[0]!.doc?.snapshot?.runs.map((r) => r.text).join('')).toContain(
-	expect(outcome.status).toBe('confirm_required');
-	expect(outcome.notes.join(' ')).toContain('а у этого плана код');
-	await expect(
-	expect(journalled).toHaveLength(0);
-	expect(gone.tabs[0]!.paragraphs.map((x) => x.text)).toEqual(['последний']);
-	expect(outcome.status).toBe('ok');
-	expect(outcome.docUndone).toContain('со стилями');
-	expect(texts).toEqual(['Шапка', 'Обычный жирный хвост', 'пункт списка', 'последний']);
-	expect(restored.tabs[0]!.paragraphs[0]!.namedStyle).toBe('HEADING_2');
-	expect(restored.tabs[0]!.paragraphs[2]!.bulleted).toBe(true);
-	expect(
-	await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
-	expect(gone.tabs[0]!.paragraphs.map((x) => x.text)).toEqual([
-	expect(outcome.status).toBe('ok');
-	expect((await client.getDocument()).tabs[0]!.paragraphs.map((x) => x.text)).toEqual([
-	expect(snapshot.runs.map((r) => r.text).join('')).toBe(
-	expect(snapshot.paragraphs).toEqual([
-	expect(snapshotRange(forecast, table.startIndex - 2, table.startIndex + 4)).toBeNull();
-	expect(outcome.status).toBe('ok');
-	expect(journalled).toHaveLength(1);
-	expect((await docs.getDocument()).tabs[1]!.paragraphs.map((p) => p.text)).toContain(
-	expect(outcome.status).toBe('confirm_required');
-	expect(outcome.notes.join(' ')).toContain('maxChars');
-	expect(journalled).toHaveLength(0);
-	expect(outcome.status).toBe('ok');
-	expect(journalled).toHaveLength(1);
-	expect(outcome.status).toBe('confirm_required');
-	expect(outcome.notes.join(' ')).toContain('appendText');
-	expect(payload.detail).toContain('названием');
-	expect(payload.detail).toContain(op);
-	expect(parseEnvelope({ ops: ['appendText'] }, 'f')?.maxChars).toBe(1000);
-	expect((error as { payload: { detail: string } }).payload.detail).toContain(
P1	expect(preview.status).toBe('preview');
-	expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
-	expect(preview.changes[0]!.anchor).toContain('в конец раздела «Составы»');
-	expect(written.status).toBe('ok');
-	expect(written.revisionAfter).toBe('rev-forecast-1+1');
-	expect(texts).toContain('Судья: Раморенко');
-	expect(texts.indexOf('Судья: Раморенко')).toBeLessThan(texts.indexOf('Прогноз'));
-	expect(journalled).toHaveLength(1);
-	expect(record.op).toBe('appendText');
-	expect(record.doc?.inserted).toBe('\nСудья: Раморенко');
-	expect(record.revisionBefore).toBe('rev-forecast-1');
-	expect(record.revisionAfter).toBe('rev-forecast-1+1');
-	expect(bare.status).toBe('confirm_required');
-	expect(bare.planId).toMatch(/^[0-9a-f]{6}$/);
-	expect(written.status).toBe('ok');
-	await expect(
-	expect(second.status).toBe('confirm_required');
-	expect(second.planId).not.toBe(preview.planId);
P10	expect(written.status).toBe('ok');
P10	expect(texts[texts.indexOf('Ставим на победу Fluminense со счётом 2:1.') + 1]).toBe(
P10	expect(vague.status).toBe('needs_clarification');
P10	expect(vague.questions[0]!.candidates.length).toBeGreaterThan(1);
-	expect(inTable.status).toBe('needs_clarification');
-	expect(inTable.questions[0]!.detail).toContain('таблиц');
-	expect(twoKeys.status).toBe('needs_clarification');
-	expect(twoKeys.questions[0]!.detail).toContain('оставь одно');
P3	expect(outcome.status).toBe('ok');
P3	expect(outcome.docUndone).toContain('Судья: Раморенко');
P3	expect(texts).not.toContain('Судья: Раморенко');
P3	expect(texts).toContain('Основа выйдет без ротации, Fluminense FC подтвердил заявку.');
P3	expect(after.tabs[0]!.paragraphs[1]!.runs.some((r) => r.style?.bold === true)).toBe(true);
P4	await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
P4	expect(after.tabs[0]!.paragraphs.map((p) => p.text).join(' ')).toContain('(уточнить!)');
-	expect(again.status).toBe('nothing_to_undo');
-	expect(again.reason).toBe('all_undone');
-	expect(textInRange(tab, first.endIndex - 1, second.startIndex + 8)).toBe('\nЧерновик');
-	expect(textInRange(withTable, table.startIndex - 1, table.startIndex + 3)).toBeNull();
-	expect(map.tabs.map((t) => t.title)).toEqual(['Прогноз', 'Черновики']);
-	expect(map.revisionId).toBe('rev-forecast-1');
-	expect(first.paragraphs).toBe(18);
-	expect(first.chars).toBeGreaterThan(100);
-	expect(map.tabs[0]!.headings).toEqual([
-	expect(map.tabs[1]!.headings).toEqual([]);
-	expect(map.tabs[0]!.tables).toEqual([
-	expect(map.warnings).toEqual([]);
-	expect(withSuggestions.warnings.join(' ')).toContain('предложения');
-	expect(text).toContain('колонтитулы верхние: 1');
-	expect(text).toContain('сноски: 2');
-	expect(empty.warnings.join(' ')).toContain('пуст');
-	expect(long.tabs[0]!.preview[0]).toBe('одно два три четыре пять шесть семь восемь…');
-	expect(map.tabs[1]!.preview[0]).toContain('Устаревший прогноз');
P19	await expect(
P19	expect(journalled).toHaveLength(0);
-	expect(preview.status).toBe('preview');
-	expect(preview.changes[0]!.after).toContain(uri);
-	expect(written.status).toBe('ok');
-	expect(journalled[0]!.doc?.inserted).toHaveLength(1); // объект — один юнит
-	expect(undone.status).toBe('ok');
-	expect(toDocRequest({ kind: 'insertPageBreak', tabId: 't1', at: 42 })).toEqual({
-	expect(
-	expect(written.status).toBe('ok');
-	expect(written.changes[0]!.after).toBe('разрыв страницы');
-	expect(undone.status).toBe('ok');
-	expect(docPlanId(base)).toMatch(/^[0-9a-f]{6}$/);
-	expect(docPlanId({ ...base })).toBe(docPlanId(base));
-	expect(docPlanId(moved)).not.toBe(docPlanId(base));
L14	expect(docPlanId(styled)).not.toBe(docPlanId(base));
-	expect(docPlanId({ ...base, revisionId: 'rev-8' })).not.toBe(docPlanId(base));
-	expect(docPlanId(a)).toBe(docPlanId(b));
-	expect(canonicalDocPlan(a)).toBe(canonicalDocPlan(b));
-	expect(preview.status).toBe('confirm_required');
-	expect(preview.notes.join(' ')).toContain('Прогноз: 4');
-	expect(preview.notes.join(' ')).toContain('Черновики: 1');
-	expect(journalled).toHaveLength(0);
-	expect(bare.status).toBe('confirm_required');
-	expect(bare.notes.join(' ')).toContain('заменяю Fluminense');
-	expect(wrongCode.notes.join(' ')).toContain('а у этого плана код');
-	expect(written.status).toBe('ok');
-	expect(allText).toContain('Fluminense FC FC подтвердил заявку');
-	expect(allText).toContain('матч Fluminense FC — Palmeiras');
-	expect(journalled[0]!.doc?.replacements).toHaveLength(5);
-	expect(undone.status).toBe('ok');
-	expect(undone.docUndone).toContain('5 вхождений');
-	expect(restoredText).toContain('матч Fluminense — Palmeiras');
-	expect(restoredText).toContain('Fluminense FC подтвердил заявку');
-	expect(restoredText).not.toContain('FC FC');
-	expect(
-	await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
-	expect(outcome.status).toBe('ok');
-	expect(texts).toContain('Ставим на победу Fluminense со счётом 3:1.');
-	expect(texts.join(' ')).toContain('матч Fluminense — Palmeiras');
-	expect(outcome.status).toBe('no_change');
-	expect(outcome.notes.join(' ')).toContain('в ячейках таблиц: 1');
-	expect(journalled).toHaveLength(0);
-	expect(result.status).toBe('question');
-	expect(result.question.reason).toBe('ambiguous');
-	expect(result.question.detail).toContain('уточни');
-	expect(result.question.candidates.length).toBeGreaterThan(1);
-	expect(result.question.candidates[0]).toMatch(/^№ \d+: /);
-	expect(result.status).toBe('ok');
-	expect(result.value.text).toContain('2:1');
-	expect(result.status).toBe('question');
-	expect(result.question.reason).toBe('no_match');
-	expect(result.question.candidates.join(' ')).toContain('Составы');
-	expect(result.status).toBe('ok');
-	expect(result.status).toBe('question');
-	expect(result.question.detail).toContain('их 2');
-	expect(first.status).toBe('ok');
-	expect(last.status).toBe('ok');
-	expect(first.value.namedStyle).toBe('HEADING_1');
-	expect(last.value.text).toContain('Ставим на победу');
-	expect(last.value.inTable).toBeUndefined();
-	expect(result.status).toBe('ok');
-	expect(result.value.heading.text).toBe('Составы');
-	expect(texts[0]).toContain('Основа выйдет');
-	expect(texts).toContain('Иванов'); // содержимое таблицы — в разделе
H2	expect(texts).not.toContain('Прогноз'); // следующий H2 — уже не раздел
H2	expect(result.value.endIndex).toBeGreaterThanOrEqual(lastOfSection.endIndex);
-	expect(result.status).toBe('ok');
-	expect(texts).toEqual(['текст раздела', 'Подраздел', 'текст подраздела']);
-	expect(result.status).toBe('question');
-	expect(result.question.available).toContain('Составы');
-	expect(result.status).toBe('ok');
-	expect(result.value.rows).toBe(4);
-	expect(result.status).toBe('question');
-	expect(result.question.detail).toContain('их 1');
-	expect(result.question.candidates[0]).toContain('Игрок');
-	expect(result.status).toBe('question');
-	expect(result.question.reason).toBe('ambiguous');
-	expect(result.question.candidates).toHaveLength(2);
-	expect(paragraphLabel(doc.tabs[0]!.paragraphs[0]!)).toBe(
-	expect(preview.status).toBe('preview');
-	expect(preview.changes[0]!.before).toContain('HEADING_2');
-	expect(preview.changes[0]!.after).toBe('NORMAL_TEXT');
-	expect(written.status).toBe('ok');
-	expect(styled.namedStyle).toBe('NORMAL_TEXT');
-	expect(undone.status).toBe('ok');
-	expect(undone.docUndone).toContain('текст не тронут');
-	expect(restored.namedStyle).toBe('HEADING_2');
-	expect(bolded.runs.every((r) => r.style?.bold === true)).toBe(true);
-	expect(restored.runs.some((r) => r.style?.bold === true)).toBe(false);
-	expect(restored.text).toBe('Ставим на победу Fluminense со счётом 2:1.');
-	expect(written.status).toBe('ok');
-	expect(written.changes).toHaveLength(3);
-	expect(after.filter((x) => x.bulleted === true).map((x) => x.text)).toEqual([
-	expect(undone.status).toBe('ok');
-	expect(restored.every((x) => x.bulleted !== true)).toBe(true);
-	expect(restored.map((x) => x.text)).toEqual(['Прогноз', 'первый', 'второй', 'третий', 'хвост']);
-	await expect(undoDocLast(client, 'doc-fixture', source(), {})).rejects.toMatchObject({
-	expect(after.tables[0]!.cells).toEqual([
-	expect((await client.getDocument()).tabs[0]!.tables[0]!.cells).toEqual([
-	expect((await client.getDocument()).tabs[0]!.tables[0]!.cells).toEqual([
-	expect(after.tables[0]!.cells).toEqual([
-	expect(emptyRowWidth(2)).toBe(5);
-	expect(outcome.status).toBe('ok');
-	expect(grid).toHaveLength(5);
-	expect(grid[2]).toEqual(['', '', '']); // ниже строки с Ивановым (№2)
-	expect(undone.status).toBe('ok');
-	expect(undone.docUndone).toContain('строка удалена');
-	expect(await cells(client)).toHaveLength(4);
-	await expect(
-	expect(outcome.status).toBe('needs_clarification');
-	expect(outcome.questions[0]!.candidates).toHaveLength(2);
-	expect(preview.status).toBe('preview');
-	expect(preview.changes[0]!.before).toContain('Иванов');
-	expect(preview.notes.join(' ')).toContain('удаляю строку Иванов');
-	expect(bare.status).toBe('confirm_required');
-	expect(written.status).toBe('ok');
-	expect(await cells(client)).toEqual([
-	expect(undone.status).toBe('ok');
-	expect(undone.docUndone).toContain('вернулась на место № 2');
-	expect(await cells(client)).toEqual([
-	expect(await cells(client)).toEqual([['а', 'б']]);
-	expect(await cells(client)).toEqual([
-	expect((await cells(client))[0]).toEqual(['Игрок', 'Статус']);
-	expect(undone.status).toBe('ok');
-	expect(await cells(client)).toEqual([
-	expect(written.status).toBe('ok');
-	expect((await client.getDocument()).tabs[0]!.tables).toHaveLength(0);
-	expect(undone.docUndone).toContain('восстановлена');
-	expect(await cells(client)).toEqual([
-	expect(texts).toEqual(['до', 'после']);
-	expect(preview.status).toBe('preview');
-	expect(written.status).toBe('ok');
-	expect(await cells(client)).toEqual([
-	await expect(
P9	expect(journalled[0]!.doc?.table?.grid?.[0]?.[0]?.[0]?.text).toBe('a');
-	expect(
-	expect(toDocRequest({ kind: 'deleteRange', tabId: 't2', startIndex: 5, endIndex: 12 })).toEqual(
-	await expect(
-	expect(after.tabs[0]!.paragraphs[0]!.text).toBe('Первый абзац');
-	expect(after.revisionId).toBe('rev-1');
-	expect(revisionId).toBe('rev-2');
-	expect(after.tabs[0]!.paragraphs[0]!.text).toBe('Ново: Первый абзац');
-	expect(after.revisionId).toBe('rev-2');
-	expect(after.tabs[0]!.paragraphs[2]!.startIndex).toBe(third.startIndex + 3);
-	expect(after.tabs[0]!.paragraphs[0]!.text).toBe('😀!Первый абзац');
-	expect(paragraph.text).toBe('Жирный очень хвост');
-	expect(
-	expect(texts).toEqual(['Заголовок', 'Новый абзац', 'хвост']);
-	expect(after.tabs[0]!.paragraphs[1]!.namedStyle).toBe('HEADING_2');
-	expect(after.tabs[0]!.paragraphs.map((x) => x.text)).toEqual([
-	expect(after.tabs[0]!.paragraphs.map((x) => x.text)).toEqual(['Первый хвост', 'Третий абзац']);
-	expect(after.tabs[0]!.paragraphs[0]!.runs.some((r) => r.style?.bold === true)).toBe(false);
-	await expect(
-	await expect(
-	expect(after.tabs[0]!.paragraphs[0]!.text).toBe('ABCDПервый абзац');
-	expect(paragraph.text).toBe('Гол! 😀');
-	expect(paragraph.text.length).toBe(7);
-	expect(paragraph.startIndex).toBe(1);
-	expect(paragraph.endIndex).toBe(9); // 1 + 7 + завершающий \n
-	expect(paragraph.text).toBe('Изучаем форму команд');
-	expect(paragraph.runs).toEqual([
-	expect(paragraph.namedStyle).toBe('HEADING_2');
-	expect(tab.tables).toHaveLength(1);
-	expect(tab.tables[0]).toMatchObject({ rows: 1, columns: 2, startIndex: 9, endIndex: 30 });
-	expect(tab.tables[0]!.cells).toEqual([['Игрок', 'Статус']]);
-	expect(inTable).toHaveLength(2);
-	expect(inTable[1]!.inTable).toEqual({ table: 1, row: 1, column: 2 });
-	expect(toDocSnapshot('d1', doc).hasSuggestions).toBe(true);
-	expect(toDocSnapshot('d1', clean).hasSuggestions).toBe(false);
-	expect(snapshot.tabs.map((t) => t.title)).toEqual(['Прогноз', 'Черновики']);
-	expect(snapshot.headerCount).toBe(1);
-	expect(snapshot.footnoteCount).toBe(2);
-	expect(tab.paragraphs[0]!.namedStyle).toBe('NORMAL_TEXT');
-	expect(tab.paragraphs).toHaveLength(1);
-	expect(tab.endIndex).toBe(9); // sectionBreak не абзац, но границу тела двигает
-	expect(preview.ok).toBe(true);
-	expect(plan.status).toBe('preview');
-	expect(written.ok).toBe(true);
-	expect((written.data as { status: string }).status).toBe('ok');
-	expect((await docs.getDocument()).tabs[0]!.paragraphs.map((p) => p.text)).toContain(
-	expect(undone.ok).toBe(true);
-	expect((undone.data as { status: string; docUndone: string }).docUndone).toContain('Погода');
-	expect((await docs.getDocument()).tabs[0]!.paragraphs.map((p) => p.text)).not.toContain(
-	expect(result.ok).toBe(false);
-	expect(result.error!.code).toBe('bad_request');
-	expect(result.error!.detail).toContain('таблица');
-	expect(result.ok).toBe(false);
-	expect(result.error!.detail).toContain('appendText');
P21	expect(result.ok).toBe(false);
-	expect(result.ok).toBe(true);
-	expect(map.revisionId).toBe('rev-forecast-1');
-	expect(map.tabs.map((t) => t.title)).toEqual(['Прогноз', 'Черновики']);
-	expect(map.tabs[0]!.headings).toHaveLength(3);
-	expect(map.tabs[0]!.tables).toHaveLength(1);
-	expect(payload.code).toBe('bad_request');
-	expect(payload.detail).toContain('Черновики');
-	expect(result.ok).toBe(true);
-	expect(data.tab).toBe('Черновики');
-	expect(data.paragraphs[0]!.text).toContain('Устаревший прогноз');
-	expect(missing.detail).toContain('Прогноз, Черновики');
-	expect(result.ok).toBe(true);
-	expect(data.paragraphs).toEqual([{ n: 2, text: 'второй', style: 'NORMAL_TEXT' }]);
-	expect(data.truncated).toBe(true);
-	expect(result.ok).toBe(true);
-	expect((result.data as { warnings?: string[] }).warnings?.join(' ')).toContain('предложения');
-	expect(payload.code).toBe('bad_request');
-	expect(payload.detail).toContain('mode=text');
-	expect(payload.code).toBe('bad_request');
-	expect(payload.detail).toContain('mode=values');
-	expect(outcome.status).toBe('needs_clarification');
-	expect(outcome.questions[0]?.candidates.length).toBeGreaterThan(1);
-	expect(client.applied).toHaveLength(0);
-	await expect(
-	expect(after.tabs[0]?.paragraphs[0]?.text).toBe(before.tabs[0]?.paragraphs[0]?.text);
-	expect(client.applied).toHaveLength(0);
-	expect(undone.status).toBe('ok');
-	expect(restored[0]?.namedStyle).toBe('HEADING_2');
-	expect(restored[1]?.runs.some((r) => r.style?.bold === true)).toBe(true);
-	expect(payload.cause).toBe('image.local-source');
-	expect(payload.detail).toContain('https');
-	expect(client.applied).toHaveLength(0);
-	expect(payload.code).toBe('policy_denied');
-	expect(payload.cause).toBe('write.snapshot-max-chars');
-	expect(payload.detail).toContain('20000');
-	expect(limitOf('write.snapshot-max-chars', 0)).toBe(20000);
-	expect(policyRules()).toHaveLength(39);
```

Привязаны к примерам: **H2 L14 P1 P10 P19 P21 P3 P4 P9**. Остальные 299 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 299

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md` и `rules.json` — текст, который уходит агенту как
`instructions` и как ресурс `policy://rules`.

1. **Появился раздел «Про документы»,** которого не было вовсе: как адресовать (карта →
   номера абзацев → селекторы), что откатывается и как, бюджет снимка, границы. Без него
   агент узнавал бы об адресации по факту отказа — ровно класс L6 (обещание в ответе
   исполняет механизм, а не память модели), только с обратным знаком: механизм есть, а
   модель о нём не знает.
2. **Конверт дополнен своей мерой для документов** (`maxChars`, юниты вместо ячеек) и
   списком того, что в него не кладётся: удаления абзаца/диапазона/таблицы/строки/колонки
   и **массовая замена всегда**. Прежний текст говорил только про таблицы, и агент считал
   бы doc-операции неизвестными.
3. **Четыре новых правила** (`docs.selector-not-guess`, `docs.write-needs-revision`,
   `docs.undo-restores-styles`, `docs.image-source-remote`) — у каждого `enforced_in` и
   проба; оракул «у КАЖДОГО правила есть проба — и наоборот» судит связь.
4. **Ничего не стало ложью:** прежние утверждения про таблицы не менялись, а фраза «всё,
   что касается Docs, — отдельный продукт» жила в DESIGN.md §6.2 и обновлена там же
   (D-21), тем же коммитом, что код.

Прогнал `npm run build`, smoke S10/S11 и `probe_mcp`, увидел 39 правил в
`dist/policy/rules.json`, идентичных `src`, и проверку «policy://rules объясняет
адресацию документов» зелёной. at=2026-09-09

## Ревью ожиданий

- **asserts_reviewed_by:** deferred reason=подпись под ожиданиями — слово владельца, и
  она закрывается вместе с живым прогоном (тот же блокер: доступ needs_reauth, вход
  восстанавливает только он; см. escalation.md). Ожидания выведены из примеров
  P1–P22 подписанной спеки и из документации Google (границы UTF-16, форма запросов,
  семантика `writeControl`). Непривязанные в дайджесте — структурные: форма плана, «превью
  не пишет», тексты отказов. Подпись строкой `asserts_reviewed_by: human:… at=…` закрывается
  словом владельца вместе с живым прогоном, как в уровне 2.
