# Verify report — Google Docs (уровень 3)

Класс L, verifier — человек. Здесь то, что прогнано машиной, и **прямо названо то, что
машиной прогнать нельзя**.

## Converge 2026-10-02 — тесты через настоящий протокол (T37–T42)

- **T37–T38:** `createServer` принимает фабрику зависимостей; обвязка
  `tests/fixtures/protocol.ts` — тот же `McpServer` и `Client` SDK на транспорте в памяти,
  аргументы через круг JSON, ответ — как у клиента. Оракул на ней — LR3-5 поведением
  (doc-операция с `tab` и `text` доходит до обработчика); обратный прогон без doc-полей в
  схеме — красный `bad_request`.
- **T39, инвентаризация:** все 71 тест инструментов (`mcp-tools`, `mcp-doc-apply`,
  `mcp-doc-read`, `doc-envelope`) прогнаны через протокол во временных копиях (не в
  истории). **69 ведут себя так же, 2 — нет**, и оба — один класс: операцию, которой нет,
  отклоняет сам SDK (перечисление `op` в схеме транспорта), и клиент получает сырой текст
  `MCP error -32602: Input validation error …` — без `code`, `action`, `correlationId`,
  мимо аудита. Тесты «неизвестная операция → объект с кодом» и «у каждой ошибки границы
  есть correlationId» зелёные только в обход протокола. Тот же путь у любого неверного
  типа поля (сверено живьём: `count: "два"`).
- **Сверх тестов — молчаливый срез незнакомых ключей, и он опаснее формы ошибки.**
  Незнакомый ключ срезают и транспорт, и схемы ядра (`z.object` по умолчанию), поэтому
  опечатка в НЕОБЯЗАТЕЛЬНОМ поле исчезает без следа. Сверено живьём превью:
  `afterHeding: «Составы»` → якорь «в конец таба „Прогноз“» вместо конца раздела; у
  `doc-test` `appendText` в конверте, то есть с `dryRun: false` правка легла бы не туда
  сразу, без плана перед человеком. Тот же механизм по коду: `gc_undo` с опечаткой в
  `record` откатит последнюю запись вместо названной; `below`, `count`, `matchCase` —
  молча по умолчанию. Это прямо против принципа «вопрос вместо догадки» (rules.md).

- **T40, решение владельца «своя граница» (D-22).** Слайс (а): `parseOperation` судит поля
  НАЗВАННОЙ операции — опечатка и поле чужой операции дают `unknown_field` с подсказкой;
  правило `input.no-silent-drop` (43-е) с пробой; обратный прогон без `assertKnownFields`
  — красные 3. Слайс (б): низкоуровневый `Server` вместо `McpServer`, вход судит
  `src/mcp/boundary.ts`; у `gc_apply` — ядро. Оракулы через протокол
  (`tests/mcp-protocol.test.ts`): неизвестная операция, неверный тип (у `gc_apply` и у
  `gc_read`), неизвестный инструмент — наш объект с `correlationId`; опечатка в конверте
  с `dryRun: false` — отказ, документ и журнал не тронуты; опечатка `recrd` у `gc_undo`
  не откатывает последнюю запись; ресурс правил и чужой адрес. Тест-двойник `tools/list`
  против `McpServer` по тем же определениям: совпадение поле в поле, кроме названной
  разницы (`additionalProperties: false` у пустой схемы `gc_targets`). **Обратный прогон
  против старого `McpServer` из HEAD — красные 8 из 10**, в том числе «опечатка в
  `record` откатывает последнюю запись» и «опечатка в конверте пишет в конец таба». Живьём
  на собранном сервере: проба `--live` зелёная целиком; `удалиВсё` и `afterHeding` с
  `dryRun: false` — наш объект, `unknown_operation`/`unknown_field`, документ совпал со
  снимком «до».

- **T41:** тесты инструментов переведены на протокол — `mcp-tools` (51 вызов),
  `mcp-doc-apply`, `mcp-doc-read`, `doc-envelope`: `callMcp` той же формы, что `runTool`,
  но запрос идёт через сервер, границу и круг JSON. Прямых вызовов обработчика в тестах —
  0. Все 71 зелёные; оба расхождения инвентаризации T39 закрыты D-22, а не правкой
  ожиданий.
- **T42, обратный прогон класса — и он показал другое, чем планировалось.** План ждал:
  без doc-полей в схеме тесты через протокол краснеют массово. После D-22 это неверно, и
  проверено, а не предположено: без `docFields` путь через протокол ЗЕЛЁНЫЙ (32/32) —
  вход `gc_apply` судит ядро, срезать поле некому, класс LR3-5 закрыт устройством сервера.
  Краснеет полнота ОПУБЛИКОВАННОЙ схемы (`mcp-transport`, 3 из 4): без поля в
  `tools/list` модель о нём не узнает — это обещание сторожит отдельный оракул и проба.

## Прогон через протокол — 2026-10-02

Цель `doc-test` в реестре (слово владельца), вызовы — своим процессом сервера из свежего
`dist` (`scripts/gc_call.mjs`, `probe_mcp.mjs --live`).

- **LR3-5, блокер: через протокол не проходила НИ ОДНА правка документа.** Схема
  транспорта `gc_apply` (`src/mcp/apply-schema.ts`) не объявляла ни одного поля
  doc-операций — 16 полей: `tab` (нужен всем 18 операциям), `text`, `afterHeading`, `uri`,
  `style`, `namedStyle`, `rows`, `table`, `tableWithCell`, `rowWithCell`, `rowIndex`,
  `columnTitle`, `columnIndex`, `right`, `startIndex`, `endIndex`; `columns` принимала
  только список имён, а у `insertTable` это число. SDK MCP собирает из схемы `z.object` и
  молча срезает незнакомые ключи ДО обработчика: `appendText` отвечал «text: Required» на
  запрос с текстом, `deleteParagraph` — «назови tab» при названном табе. Почему молчало
  всё: 574 теста зовут `handle` напрямую, мимо транспорта; живая сверка 2026-10-01 звала
  ядро из `dist`; проба сверяла с ядром только ИМЕНА операций (39/39), а её живой
  doc-блок до 2026-10-02 пропускался — doc-цели в реестре не было. Класс L14/L21 («поле
  объявляет одна сторона, заполняет другая»), третий раз: имена операций свели к одному
  списку, поля — нет.
  **Починка:** поля в схеме транспорта с описаниями для модели; `columns` — список или
  число; перечисление `namedStyle` берётся из ядра. **Оракулы:**
  `tests/mcp-transport.test.ts` — поля ядра ⊂ схема транспорта; образец каждой из 39
  операций заполняет ВСЕ её поля и сам проходит ядро (иначе оракул пуст); тот же образец
  проходит транспорт, воспроизведённый буквально (`z.object(applyInput)`, как
  `McpServer.validateToolInput`), и ядро получает тот же запрос; у doc-полей есть
  описания. Обратный прогон: без doc-полей — красные 3 из 4, `columns` только списком —
  красный `insertTable`. `probe_mcp.mjs`: «протокол объявляет каждое поле операций ядра»
  по схеме СОБРАННОГО сервера — на старом `dist` красная, на новом зелёная; живой
  doc-блок пробы зелёный впервые (превью вставки, отказ названием, локальная картинка,
  ревизия не сдвинулась).
- **LR3-6: подсказка отката документа велела агенту сказать «вернулось — ничего».**
  Пара 1–2 через протокол прошла (вставка в конверт с первой фразы, откат — вид документа
  совпал со снимком «до» поле в поле), но ответ `gc_undo` спорил сам с собой: `docUndone`
  — «вставленное удалено из таба „Прогноз“: „Судья: Раморенко“ (17 юнитов)», а `hint` —
  «Вернулось — ничего: список возвращённого пуст. Скажи человеку именно это». Подсказка
  считала только ячейки таблиц и `structureUndone`; поле `docUndone` добавили в ядро, а
  текст для модели — нет. Так говорил ЛЮБОЙ откат документа (у всех `restored: []`).
  Сквозной тест проверял `docUndone`, но не `hint`. **Починка:** описание doc-отката
  входит в «что вернулось». **Оракул:** тот же сквозной тест судит `hint` — содержит
  вставленное и не содержит «ничего»; обратный прогон красный на тексте дефекта.
- **LR3-7: план стилевой правки называл абзац голым номером.** Превью пары 3 —
  «абзац № 3: HEADING_2 → NORMAL_TEXT»: человек подтверждает план, не видя, какой абзац
  станет обычным текстом, хотя вставка тот же абзац называет текстом («№ 18: Тренер…»).
  **Починка:** якорь стилевых операций — `paragraphLabel`, общий с вставкой. Код плана
  считается из индексов, а не из подписи якоря, — живьём сверено: до и после правки
  `76135c`. **Оракул:** тест P11 требует текст абзаца в якоре; до правки красный.
- **LR3-8: план вставки строки/колонки таблицы называл якорь голым номером** — «ниже
  строки № 2» на просьбу «после строки с Иванов». Класс LR3-7, найден превью пары 12.
  **Починка:** к номеру добавляется содержимое строки-якоря или заголовок колонки
  («ниже строки № 2: Иванов | вратарь | Fluminense», «правее колонки № 2: Позиция»);
  якорь входит в подпись плана — поменялась строка, поменялся код. **Оракул:** тест P13
  требует содержимое якоря в плане; до правки красный.
- **Наблюдение для владельца (D-20, не чинилось): фраза у документов строже, чем у
  таблиц.** Сверка — «фраза человека СОДЕРЖИТ предмет» после нормализации регистра,
  кавычек и пробелов. У таблиц предмет — значение ключа («G connect»), у документов —
  фраза целиком с глаголом и первыми словами абзаца С ПУНКТУАЦИЕЙ: пройдёт только
  «удаляю абзац Устаревший прогноз: Flamengo выиграет» (двоеточие обязательно) и
  «удаляю строку Иванов вратарь Fluminense». Фразы чек-листа («да, удаляю абзац
  Устаревший прогноз», «да, удаляю строку Иванов») ядро отклонило бы `not_named` —
  дефект чек-листа, исправлен в `live-run.md`. Дыры нет: превью само называет точную
  фразу. Шероховатость есть: пунктуацию из текста абзаца человек повторяет буквально.
  Вариант — не считать пунктуацию, как кавычки; решение владельца.
- **Два всплеска задержки без причины:** первый живой вызов пробы — таймаут 30 с;
  превью `insertTableColumn` — 20,7 с при обычных 0,6 с. Оба не воспроизвелись (повторы
  по 0,6–2 с). Повторы `withRetry` сервер не печатает, поэтому отличить медленный ответ
  Google от повтора нечем — названо, а не списано.
- **Пары через протокол, прошедшие без владельца:** 1–2 (вставка в конверт с первой
  фразы, `ok` с id записи; откат — вид совпал со снимком «до» поле в поле: стили
  фрагментов, вид абзацев, индексы, id заголовков); 16 (локальная картинка — отказ за
  3 мс, до сети, с советом про поставку загрузки); 17 (`appendRow` по документу — отказ
  со списком 18 doc-операций). Остальные — вне конверта: код или фразу называет человек.
- **Попутно:** `gc_call.mjs` держал процесс до конца минуты висящим таймером — каждый
  вызов выглядел 60-секундным, настоящая задержка была не видна; таймер снимается
  ответом, время вызова печатается. Первый запуск пробы получил таймаут 30 с на первом
  живом вызове (`gc_read map` таблицы); не воспроизвёлся — три повтора по ~2 с, токен
  был действителен. Причина не установлена — названо, а не списано.

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
