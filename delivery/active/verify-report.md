# Verify report — длинные листы (D-26)

Статус: **verify, мерж в main одним squash через `merge_guard`** — слово владельца 2026-11-11 «надо как бы
слить все… чтобы оно было все в мейне, запущено на гитхабе», объём — ответ «Одним мержем: 17000/110».
Цепочка PR #9–#23: длинные листы, вид и заметки ячеек, лист по gid, колонки без подписи, загрузка на
Диск (D-27), шапка (хотфикс 11.11). Живой прогон — частично (`eval-smoke.md`, `live-run.md`).

## Тест-воспроизведение (kind: bugfix)

`tests/long-sheets.test.ts` — настоящий `GoogleSheetsClient` через внедрённый API, заглушка
отвечает как Google (сетка только в запрошенном диапазоне, размер листа — в `gridProperties`,
хвост пустых строк не отдаётся). На коде до починки красный: `appendRow` на листе в 600 строк
писал в `Агентства!A501` — занятую строку; с пропуском в середине — отказ предусловия вместо
дозаписи; `upsertRow` по ключу в 550-й строке не находил его. На починке — зелёный.

Q8–Q10 (весть portfolio-site-38: «Реестр инфраструктуры» встал на 26 строках из 55) —
`tests/inferred-constraints.test.ts` и блок Q10 в `tests/long-sheets.test.ts`. На коде до
починки (`acd59d0`) красные 6 тестов из 8 и 2 из 2; зелёные два — то, что обязано работать и
до, и после: настоящий статус остаётся списком, проверка данных таблицы — списком.

Q11–Q15 (весть portfolio-site-38: строки, дописанные G connect, легли шрифтом листа по умолчанию,
первые даты пустых колонок — ISO) — три ветки от контракта `ee2efb4`: `tests/cell-fonts.test.ts`
(A, Q11–Q12), `tests/format-rows.test.ts` (B, Q13–Q14), `tests/date-style.test.ts` (Q15; агент C
упал на ошибке API, не записав ни строки, — сделал ведущий). Красные на коде до правки — ниже.

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
| Q8 | свободный текст с повтором — не список; статус на 10+ строках с повтором втрое — список; даты, числа, ссылки, длинные значения — никогда; проверка данных таблицы — список и на двух строках | `tests/inferred-constraints.test.ts`; живьём — запись в «Реестр инфраструктуры» (portfolio-site-38) |
| Q9 | одно «0» — не число; два числа — число; одна дата — ещё не дата; тип держится на 80% колонки | `tests/inferred-constraints.test.ts`; шов дат — `tests/google-mapping.test.ts` |
| Q10 | строка — один запрос `batchUpdate`; отказ запроса — ни одной ячейки строки | `tests/long-sheets.test.ts` (заглушка Google: `batches`, `failBatch`); живьём |
| Q11 | шов читает гарнитуру, кегль и формат числа; незнакомый тип и пустые — нет; карта; `withFormat` — вид строка в строку с `rows`, без него ключа нет | `tests/cell-fonts.test.ts` (шов — внедрённый API, `gc_read` — протокол); живьём — строки 589–601 |
| Q12 | граница: кегль 6–96 целым, `null` снаружи — отказ, тип формата числа — из восьми; `repeatCell` — маска и тело ровно заданных полей, сброс `null` — в маске без значения; `no_change` на том же виде; откат — сброс того, чего не было; старая запись журнала откатывается; чужая правка записанного ключа — отказ | `tests/cell-fonts.test.ts`; живьём — выравнивание и откат 591–599, `numberFormat` 550-й |
| Q13 | `allRows` — все строки данных с пустыми внутри; `rows` — включительно; вне данных — отказ с границами; ни одного, два способа, пустое `where` — отказ на границе и в ядре; конверт: 60 ячеек — `confirm_required`, 50 — с первой фразы | `tests/format-rows.test.ts`; проба `write.format-rows-explicit`; живьём — `rows: {591, 599}` |
| Q14 | `copyPaste` `PASTE_FORMAT` из строки над новой по ширине таблицы — ДО значений; шапка — без копии; превью называет; отказ копии — значений нет; занятая строка — ни копии, ни значений; откат — значения, вид остаётся | `tests/format-rows.test.ts` (шов — внедрённый API); проба `write.append-inherits-format`; живьём — 602-я |
| Q15 | пустая колонка — вид дат листа, иначе локали (`ru_RU` → `dotted`, `en_US` — как прислано); колонка с одной датой держит свой; слова, версии, «31.02.2026» — как прислано; шов `properties.locale` | `tests/date-style.test.ts`; живьём — «Дата старта» 550-й в книге `ru_RU` |
| Q49 | `addSheet` с `columns` и `rows`: шапка и строки в заметках превью, код плана от содержимого; запись — шапка с A1, строки с A2, текстом; 51 ячейка — `confirm_required`; строка длиннее шапки — отказ | `tests/add-sheet-content.test.ts` (через протокол, под разрешением проекта) |
| Q50 | только `rows` — данные с A1 вниз без шапки; `null` ячейку пропускает и в счёт не идёт | `tests/add-sheet-content.test.ts` |
| Q51 | `setHeader` на пустом листе — A1:F1 с первой фразы, затем `appendRow` по именам — строка 2; `startColumn: "A"` на листе «A1 пуста, B1–F1 подписаны» | `tests/set-header.test.ts`; живьём — T35 (2026-11-11) |
| Q52 | занятая ячейка и повтор подписи — отказ без записи; откат `setHeader` — пусто; откат `addSheet` — лист удалён, после правки — `revision_conflict` | `tests/set-header.test.ts`, `tests/add-sheet-content.test.ts`; пробы `write.header-empty-cells-only`, `write.add-sheet-content-undo` |

Q16–Q48 судятся тестами, названными по id примера (§3.1d: гейт находит ссылку на каждый из 52
примеров); их строки — в спеке, а «где» — в комментариях тестов. Таблица выше — по Q1–Q15 и хотфиксу.

## Обратные прогоны (каждый — красный на своём тесте, 2026-10-19)

- Запись снова по `A1:ZZ500` → 3 красных (Q4, Q5, шов «лист целиком»).
- `appendRow` по числу непустых строк → Q4 с пропуском красный.
- `truncated` по длине ответа → Q2 красный (2 теста).
- Карта молчит о части листа → Q7 красный.
- Без предела записи → Q6 красный.
- `map.ts` до Q8/Q9 (`acd59d0`) → 6 красных: Q8 — 3, Q9 — 3.
- `commit.ts` до Q10 (по запросу на ячейку) → 2 красных: запросов `[]` вместо `[3]`, и после
  отказа запроса в листе остались ячейки строки.
- Весь `src/` на контракте `ee2efb4`, тесты A → 20 красных из 22 (19 новых и V11); два зелёных
  стерегут сохранённое — у каждого проверены зубы точечным сломом (сверка отката, `formats`
  без просьбы).
- `ops.ts`, `apply-schema.ts`, `run-operation.ts`, `format-op.ts` на базе → 12 красных Q13 и 2
  сверки транспорта; `rows.ts` на базе → 7 из 9 Q14 (два зелёных проверяют ОТСУТСТВИЕ копии —
  их зубы проверены мутантами); `undo.ts` на базе → откат дозаписи красный; фейк на базе → 2.
- Q15: карта без вида листа и локали → 4 красных; запись без вида колонки → 5; шов без локали → 1;
  без сверки дня → 1.
- Пробы новых правил: ядро без проверки пустого условия → `write.format-rows-explicit` красная
  (первая версия пробы судила только границу и сломом не краснела — усилена прямым вызовом ядра);
  значения до вида → `write.append-inherits-format` красная.

## Мутации — доли считают, порог судит сумма (cqg@2.69)

Локально 2026-10-19 на `37ab9bb`, `MIN_KILLED=60`, база `main`: сумма 4 долей — убито 728 из
1074 (67%), порог 60% — OK. По долям: `commit.ts` 141/200, `map.ts` 403/609, `rows.ts` 184/265,
доля 4 — «0 0». Шов Google (`src/core/google/sheets.ts`, `sheet-ranges.ts`) и слой MCP
(`read-values.ts`, `tools.ts`) — вне маски Stryker, их судят тесты через настоящий клиент и
протокол.

На CI доля с `map.ts` дважды не уложилась в 600 с (`acd59d0` — доля 1, `37ab9bb` — доля 2):
609 мутантов, из них 33 статических (29 — три регулярки типов) гоняют весь набор тестов; локально
306 с, раннер медленнее в 3,3 раза (`rows.ts`: 55 с против 180 с) — ~17 минут. Бюджет доли поднят
до 1500 с (решение в `decisions.md`). CI на `c8b6979` (прогон 39267161013): доля с `map.ts` —
12 минут, «mutation (сумма долей)» — убито 728 из 1074 (67%), OK.

PR #22 (D-27) локально 2026-11-09 на `2eba144`, база `21a71b0` (PR #21), `MIN_KILLED=60`, `BUDGET_SEC=1500`,
четыре доли как в CI: сумма — убито 1610 из 2063 (78%), порог 60% — OK; доли 395/433, 396/651, 313/407,
506/572. Самые слабые файлы — `undo-structure.ts` 52% (старый файл целиком, задет тремя строками развилки) и новые
`upload-checks.ts` 64%, `upload-undo.ts` 62%. По выжившим добавлены тесты (три случая сверки без sha256, корзина
не удалась, откат без sha256, файл Google другого вида и папка по ID): перемер — `upload-checks.ts` 94%,
`upload-undo.ts` 64% (покрыто 82%: без тестов остались пути отказа — файл удалён руками, запись журнала без полей,
откат без Drive, `force` на новом файле). Шов Drive (`drive.ts`, `drive-upload.ts`) — вне маски Stryker: судится
формой запросов Google (41 тест, ручные мутанты агента U1 — 18 из 18); `local-file.ts` и `mime.ts` — 212 из 212.

PR #23 (хотфикс шапки) локально 2026-11-11, только изменённые строки, агенты H1 и H2: `setHeader` — убито 126
из 126 (100%), `addSheet` с содержимым — 205 из 205 (100%); на первом проходе у H1 выжили 20 (эквивалентные убраны
вместе с лишними ветками, остальные закрыты тестами), у H2 — 1 (`unlabeled.find(() => true)`: добавлена подпись
пустой колонки G). Прогоны по файлам целиком (672 и 1222 мутанта) остановлены ради скорости — прежний код этих
файлов заново не мутировался. Сумма долей CI — на PR #23 (база — PR #22).

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
6. **Карта, Q8/Q9**: `enumValues` с `enumSource: inferred` и ограничивающий `type` появляются
   реже — только по сильным признакам; абзац `rules.md` «Списки и типы… — подсказка, а не забор»:
   `not_in_enum` на выведенном списке — уточнить у человека, проверка данных таблицы — как раньше.
7. **`gc_read`, Q11**: вход `withFormat`; ответ `formats` — `asData`, как `rows` (имя шрифта и
   шаблон пишет в таблицу кто угодно — правило `content.is-data`); вид в карте — с шрифтом,
   кеглем и форматом числа.
8. **`gc_apply` formatCells, Q12–Q13** (`src/core/format-fields.ts`, `src/core/ops.ts`,
   `src/mcp/apply-schema.ts`): поля `fontFamily`, `fontSize`, `numberFormat`; `null` снаружи —
   отказ с объяснением; выбор строк `where` / `allRows` / `rows: {from, to}`; отказы `bad_request`
   с причинами `row_selection`, `empty_condition`, `rows_outside_data`.
9. **Заметки ответов, Q14–Q15**: «оформление строки N — как у строки N−1»; ««2026-09-10» записано
   как 10.09.2026 — вид дат таблицы/колонки».
10. **Правила**: `write.format-rows-explicit`, `write.append-inherits-format` с пробами (правил 54);
    `rules.md` — поля вида, `withFormat`, выбор строк, вид дописанной строки, первая дата пустой
    колонки, откат вида по записанным полям и сброс шрифта к виду листа.

По файлам: `src/mcp/tools.ts` — `withFormat` в схеме и описании `gc_read`; `src/mcp/read-values.ts`
— `formats`; `src/mcp/apply-schema.ts` — поля вида и выбора строк в `tools/list`; `src/core/ops.ts`
и `format-fields.ts` — разбор. Прогнал `vitest` по протоколу (`tests/cell-fonts.test.ts`,
`tests/format-rows.test.ts`, `tests/mcp-tools.test.ts`, `tests/mcp-transport.test.ts`): зелёные.
at=2026-10-19

По файлам: `src/mcp/tools.ts` — вход `fromRow`, описание `gc_read`, лёгкая карта (`MAP_ROWS`),
ветка `values` переехала в `read-values.ts`, остальные инструменты не изменены. Прогнал
`vitest` по протоколу (`tests/long-sheets.test.ts`, `tests/mcp-tools.test.ts`): зелёные.
at=2026-10-19

PR #22 (D-27): `gc_apply` — операция `uploadFile` (`localPath`, `name`, `replace` флагом или строкой
«true»/«false»), заголовок «Записать: таблица, документ, файл на Диске», описание называет загрузку;
ответ `file` (id, name, link, size, modifiedTime, sha256, revision, previous); отказы с причинами
`upload_outside_project`, `upload_hidden_path`, `upload_secret_like`, `upload_not_found`, `upload_not_file`,
`upload_unreadable`, `upload_no_project`, `upload_not_a_file`, `upload_checksum_mismatch`; код ошибки
`storage_full`; правила 58–62 и раздел `rules.md` «Файлы с компьютера на Диск»; фраза о загрузке у
картинок документа. Схемы `tools/list` на zod 4 сверены с выдачей zod 3 поле в поле (агент Z): добавились
`maximum` у целых и `propertyNames` у записей. Прогнал по протоколу `tests/upload-file.test.ts`,
`tests/mcp-protocol.test.ts`, `tests/mcp-transport.test.ts`, `tests/policy.test.ts`: зелёные.
at=2026-11-09

PR #23 (хотфикс шапки): `gc_apply` — операция `setHeader` (`columns`, `startColumn`), поля `columns`, `rows`,
`asText` у `addSheet`; описание `gc_apply` называет `setHeader` и `addSheet` со шапкой (весть сессии профиля work:
модель, читающая описание, путь «подпиши шапку» не находила); подсказка колонки без подписи — «подпиши шапку
(setHeader)»; отказы `header_cell_occupied`, `header_label_duplicate`, `header_label_empty`, у отката — причина
`sheet_changed`; правила 63–64 и раздел `rules.md` «Шапка и данные без шапки». Прогнал по протоколу
`tests/set-header.test.ts`, `tests/add-sheet-content.test.ts`, `tests/mcp-tools.test.ts`,
`tests/mcp-transport.test.ts`, `tests/policy.test.ts`: зелёные; `tools/list` стабильной сборки — 41 операция.
at=2026-11-11

`src/mcp/target-arg.ts` — общее поле `sheet` чтения и записи (Q27: без него — вкладка из ссылки, лист реестра
или первый), остальные поля не изменены; `src/mcp/run-upload.ts` — новый обработчик `uploadFile`: каталог проекта
сессии из клиента, без него — отказ правилом `upload.project-files-only`, ответ `file`. Прогнал
`tests/upload-file.test.ts`, `tests/mcp-transport.test.ts`: зелёные. at=2026-11-11

## Ревью рисковых мест (§12.5)

- **Загрузка с компьютера (PR #22, D-27)** — новая поверхность записи и выноса: файл уходит с компьютера на
  общий диск. Механизм — проверка до чтения содержимого: каталог проекта сессии (корень и `~` — не проект),
  настоящий путь после ссылок, скрытые сегменты и имена секретов, предел 100 МиБ; путь наружу — один ответ,
  есть там файл или нет. Право — до чтения файла и до Диска. Запись: прежняя ревизия закреплена до замены,
  загруженное сверено по sha256, расхождение — откат и ошибка; создание и замена вслепую не повторяются.
  Непокрыто: содержимое на секреты не сканируется (названо в спеке и правилах).

- **Интеграция** — `src/core/google/` (шов Google и Drive): окно строк, размер листа из метаданных, маски полей
  вида, копия формата строки, загрузка resumable, а в PR #23 — режим ввода `RAW` у `batchUpdateValues` и запись
  матрицы нового листа в `'<лист>'!A1`. Чем опасно: ответ Google, который заглушка не моделирует (сетка A–Z у
  нового листа, имя листа с апострофом, 308 и `Range` у загрузки), — виден только живьём; что прогнано живьём —
  блок «Исполнение рисковых путей», остальное названо там же.
- **Шапка (PR #23)** — новая запись в строку шапки: только пустые ячейки, сверка «всё ещё пусто» перед записью,
  в конверте; колонка по неизвестному имени по-прежнему не создаётся. На непустом листе строку шапки выбирает
  карта — на раскладке ежедневного отчёта она может взять строку данных (план называет строку, `headerRow` её
  исправляет) — кандидат на правило.

- **Безопасность** — главная цель поставки: запись больше не считается по части листа.
  Механизм — поведение по умолчанию (`rangesFor`: названный лист без `maxRows` — целиком);
  частичное чтение — только явным `maxRows` (карта) или окном (`readRows`). Путь, который
  забудет сказать, сколько читать, получит лист целиком, а не обрезку.
- **Предел записи** — 50 000 строк сетки: больше — отказ до чтения сетки. Названо, что сетка
  считает и пустые строки: лист с огромной пустой сеткой откажет, хотя данных мало, — человеку
  сказано, почему.
- **Выведенные ограничения (Q8/Q9)** — ослабление подсказки, а не защиты: проверка данных
  таблицы, защищённые и формульные колонки, предусловие и превью — как раньше. Выведенный список
  был догадкой ядра, а работал жёстким запретом; цена — настоящий короткий список на 9 строках
  больше не подсказывается (его держит только проверка данных).
- **Запись строки (Q10)** — `commit.ts`: ячейки правки, кроме формата, — одним
  `values.batchUpdate`; отказ запроса (429) — ни одной ячейки, а не половина строки. Откат снимка
  по-прежнему пишет по ячейке (LR-3) — названо.
- **Вид ячеек (Q11–Q12)** — новых записывающих путей нет: правка вида идёт тем же превью, кодом
  плана сверх конверта, предусловием и журналом. Новое — сброс `null` (поле в маске `repeatCell`
  без значения): по семантике маски полей Google сбрасывает поле к виду листа; проверяется только
  живьём (рисковый путь — шов целиком). Сверка отката сужена до записанных полей — чужая правка
  другого поля откат больше не блокирует и им не затирается (названо в `rules.md`).
- **Выбор строк (Q13)** — «все строки» только явным `allRows`; конверт считает ячейки плана, как
  раньше (ячейки, где вид уже нужный, в план не входят) — обхода нет, это тест.
- **Вид дописанной строки (Q14)** — +1 запрос `spreadsheets.batchUpdate` на дозапись; копия —
  после предусловия и до значений. `PASTE_FORMAT` по документации переносит и проверку данных
  строки выше (выпадающий список) — для таблицы это ожидаемо; размножает ли он правила условного
  форматирования, видно только живьём.
- **Деньги** — риска нет, потому что поставка ничего не тратит: «бюджет» — строки чтения.
- **Транзакция БД** — базы нет; запись по-прежнему через превью, предусловие (теперь по
  целому листу) и журнал с откатом.
- **Производительность** — запись на длинном листе читает его целиком (~60 тыс. ячеек на 1630
  строк) плюс запрос размера; чтение `values` — одним запросом окна до 5000 строк.

## Исполнение рисковых путей (§12.6)

- прогнал `setHeader` и 18 строк `upsertRow` у сессии профиля work на стабильной `36965e1` (шов
  `batchUpdateValues` с `RAW`), увидел подписи A1:F1 и уверенную шапку карты, 18 строк, `stale_value` не было
  at=2026-11-11
- прогнал `scripts/install_stable.sh f00c44f` (сборка из коммита и проба собранного сервера дважды), увидел
  «всё зелёное»: 41 операция, 52 поля схемы, `policy://rules` отдаётся at=2026-11-11
- прогнал `tools/list` стабильного сервера профиля work, увидел `setHeader` в `op.enum` и поля `addSheet`
  at=2026-11-11
- весть сессии parsing-and-outri-83: `setCells` по номерам строк и ключ `(A)` на рабочем листе отчёта (Q39, Q40,
  `3d9672e`) at=2026-10-20; весть сессии реестра — вид дописанной строки на семи вкладках (Q11–Q13)
- не прогнано живьём: загрузка на Диск (resumable, 308 и `Range`, ревизии), шапка шире Z на новом листе, уборка
  листа после сбоя записи, чтение листа с апострофом в имени — судятся заглушками Google и Drive

## Найдено по дороге

- **Переполненный Диск считался лимитом запросов** (находка U1, PR #22): 403 `storageQuotaExceeded` содержит
  «quota», и разбор делал его `quota_exceeded` с тремя повторами. Теперь `storage_full` без повтора.
- **`escape` в запросе Drive не экранировал «\»** (находка U1): в `search` это была скрытая ошибка — имя с
  обратной косой ломало `q`. Тест добавлен.
- **Двойник `vetLocalFile` в тестах операции отвечал не как настоящий** (`policy_denied` вместо
  `bad_request`/`upload_outside_project`) — подогнан при сведении.
- **tsserver редактора падал 5 раз за 5 минут** (2026-11-09): файлы, которые агенты правили в своих worktree,
  открывались в редакторе отдельными проектами с типами `googleapis`; памяти по умолчанию (3 ГБ) не хватало.
  Настройки редактора проекта — вне репозитория.

- **Агенты-сироты из тестов** (2026-10-22, весть владельца: убито 814 зависших `ssh-agent`). Обычный
  прогон `grant.test.ts` агент гасил, сирота рождался только у воркера, убитого до `afterAll`. Опыт:
  агент без сторожа после `kill -9` владельца остался с ppid 1; под сторожем — погас. Тест
  `test-agent.test.ts` повторяет это на каждом прогоне и не даёт запускать агент мимо сторожа.
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
- **Догадка ядра работала запретом** (Q8/Q9): список из четырёх значений с одним повтором и тип
  от одного значения отказывали записи так же, как проверка данных таблицы, — а подтвердить
  догадку человеку было нечем. Класс: выведенное должно быть слабее объявленного.
- **Бюджет доли мутаций был по среднему файлу**: `map.ts` впервые попал в долю (до этой поставки в
  PR не менялся) и не уложился в 600 с ни разу; доля «не просудила» — гейт честно красный, но
  вердикта не было. Замер до PR — дешевле двух красных прогонов CI.
- **Откат записи в пустую ячейку её не очищал** (нашёл агент B, класс LR-2): ячеечный откат писал
  `[[null]]`, а values-API Google `null` ПРОПУСКАЕТ — откат дозаписи отвечал `ok` и оставлял
  строку в листе. Путь снимка (`undo-structure.ts`) был починен раньше, этот — нет. Теперь «было
  пусто» уходит пустой строкой; тест красный до правки.
- **`formatCells` с пустым `where: {}` молча брал все строки** (пустой `every` истинен) — теперь
  отказ `empty_condition`. `setCells` с `where: {}` по-прежнему берёт все строки (пример K3) —
  названо, не тронуто.
- **Фейк вставлял «только вид» вместе со значениями** и стирал вид при записи значения — тесты на
  нём согласились бы с копией вида, которой Google не сделал бы (L23 — в пятый раз). Починен.
- **Агент C упал на ошибке API**, не записав ни строки: worktree пуст, Q15 сделал ведущий. Три
  ветки от общего контракта типов свелись с одним конфликтом — импорт в `ops.ts`.

## Риски и непокрытое

- Откат загрузки: пути отказа без тестов — файл удалён руками до отката, запись журнала без полей, откат без
  Drive, `force` на новом файле после чужой правки (мутации `upload-undo.ts` — 64%, покрыто 82%).
- Загрузка (PR #22): копия секрета под обычным именем проходит — содержимое не сканируется; регистр имени в
  поиске Drive не мерен — совпадение с другим регистром идёт заменой с фразой, а не молча; `incompleteSearch` на
  аккаунте с множеством общих дисков — отказ; у Drive до 200 закреплённых ревизий на файл; resumable-протокол
  судится формой запросов, живьём не гонялся.
- deps-audit (2026-11-09): high нет; 19 средних в снимке (решение владельца) — 6 в рабочей сборке
  (googleapis → gaxios → rimraf → glob → minimatch, путь не вызывается), 13 в инструментах разработки;
  python-половина по-прежнему не проверена — pip-audit не установлен.

- Запись на длинном листе читает его целиком: 1630 × 37 ≈ 60 тыс. ячеек на запрос — секунды.
- Чтение без названного листа (по первому листу книги) по-прежнему тянет книгу целиком.
- Ревизия для журнала (`server.ts`, `revision`) читает книгу целиком — дорого, но верно.
- Откат дозаписи возвращает значения, а скопированный вид остаётся на опустевшей строке; ответ
  `gc_undo` этого вслух не говорит (копия не в журнале).
- Незнакомое имя шрифта («Carlitto»): отвергнет ли Google запрос или покажет запасной шрифт —
  только живьём.
- `withFormat` на 1630 строк × 37 колонок — порядка 3 млн знаков; читать окнами.
- Выравнивание вкладки в 55 строк × 19 колонок — пачками `rows` под конверт в 50 ячеек (например,
  по 2 строки), сверх конверта — код плана на каждую пачку; `write.max-changes` — 200 ячеек.
- Вид дат локали — 12 языков «день.месяц.год»; у остальных первая дата пустой колонки — как
  прислано.
- Колонки дальше ZZ не читаются ни картой, ни окном.
- deps-audit (2026-10-21): python-зависимости не проверены — pip-audit не установлен; js — 2 moderate в
  `qs` под `typed-rest-client` (dev), в пределах снимка; high в launch-editor закрыта `npm audit fix`.

## Assertion digest (ревью ожиданий, не кода)

База: `main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **1387**, из них без ссылки на пример спеки:
**453**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
L26	expect(result.error).toBeUndefined();
L26	expect(result.ok).toBe(false);
-	expect(preview.status).toBe('preview');
-	expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
-	expect(preview.notes).toEqual([
-	expect(preview.structural).toEqual({
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(h.client.writes).toEqual([]);
-	expect(h.journalled).toEqual([]);
-	expect(new Set(codes).size).toBe(4);
Q19	expect(asJson.planId).toBe(base.planId);
-	expect(table.structural?.['content']).toBe(sheet.structural?.['content']);
-	expect(table.notes).toEqual(sheet.notes);
-	expect(schema.properties[field]?.description, field).toContain('addSheet');
-	expect(written.status).toBe('ok');
-	expect(written.notes).toContain('Шапка: Дата | Сумма | Комментарий');
-	expect(await titles(h)).toEqual(['Лист1', TITLE]);
-	expect(await grid(h)).toEqual([
-	expect(h.client.writes).toEqual([
A1	expect(h.journalled).toHaveLength(1);
A1	expect(h.journalled[0]).toMatchObject({
A1	expect(written).toMatchObject({ status: 'ok', structural: { count: 3 } });
A1	expect(written.notes).toEqual(['Строк: 2, текстом (RAW):', '  a.com | 3', '   | 5']);
A1	expect(await grid(h, 'Данные')).toEqual(rows);
A1	expect(h.client.writes.map(({ range }) => range)).toEqual([`'Данные'!A1`]);
-	expect(written).toMatchObject({ status: 'ok', notes: ['Шапка: Имя | Почта'] });
-	expect(await grid(h)).toEqual([['Имя', 'Почта']]);
-	expect(written.status).toBe('ok');
-	expect(written.notes).toContain('Строк: 2:');
-	expect(h.client.writes.map(({ input }) => input)).toEqual(['user']);
-	expect(written.status).toBe('ok');
A1	expect(h.client.writes.map(({ range }) => range)).toEqual(["'План ''Б'' на ноябрь'!A1"]);
A1	expect(await grid(h, title)).toEqual([['Шаг'], ['первый']]);
-	expect((await apply(h, { ...tall(49), dryRun: false })).status).toBe('ok');
-	expect(await grid(h)).toHaveLength(50);
-	expect(asked.status).toBe('confirm_required');
-	expect(asked.notes.at(-1)).toContain('51 ячеек, конверт цели разрешает 50');
-	expect(asked.notes).toContain('  …и ещё 40');
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(h.client.writes).toEqual([]);
-	expect(written.status).toBe('ok');
-	expect(await grid(h)).toHaveLength(51);
-	expect((await apply(h, { ...tall(199), dryRun: false })).status).toBe('confirm_required');
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
-	expect(error?.detail).toContain(
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(error).toMatchObject({ code: 'bad_request', detail: 'Имя листа не может быть пустым.' });
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(error).toMatchObject({ code: 'stale_value', cause: 'anchor_moved' });
-	expect(book.sheets.map((sheet) => sheet.title)).toEqual(['Лист1', TITLE]);
-	expect(h.client.writes).toEqual([]);
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'row_wider_than_header' });
-	expect(error?.detail).toContain('Строка 1 длиннее шапки (2 колонок)');
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(h.client.writes).toEqual([]);
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'change_budget' });
-	expect(error?.detail).toBe(
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(table.error?.detail).toContain('создай таблицу с шапкой');
-	expect(error).toMatchObject({ code: 'internal', cause: 'квота' });
-	expect(await titles(h)).toEqual(['Лист1']);
-	expect(h.journalled).toEqual([]);
-	expect(error).toMatchObject({
-	expect(error?.detail).toBe(
-	expect(await titles(h)).toEqual(['Лист1', TITLE]);
-	expect(h.journalled).toEqual([]);
-	expect(created.error).toMatchObject({
-	expect(undone.data).toMatchObject({
-	expect(await titles(h)).toEqual(['Лист1']);
A2	expect(conflict.error).toMatchObject({ code: 'revision_conflict', cause: 'sheet_changed' });
A2	expect(conflict.error?.detail).toBe(
A2	expect(await titles(h)).toEqual(['Лист1', TITLE]);
A2	expect((forced.data as UndoData).status).toBe('ok');
A2	expect(await titles(h)).toEqual(['Лист1']);
-	expect(preview).toMatchObject({ status: 'preview', notes: [] });
-	expect(preview.structural).toEqual(structural);
-	expect(preview.planId).toBe(
-	expect(empty).toMatchObject({ notes: [], structural: plainPlan.structural });
-	expect(empty.planId).toBe(plainPlan.planId);
-	expect((await apply(h, { ...plain, rows: [], dryRun: false })).status).toBe('ok');
-	expect(h.client.writes).toEqual([]);
-	expect((await apply(h, { ...plain, dryRun: false })).status).toBe('ok');
-	expect(h.client.writes).toEqual([]);
-	expect(h.journalled[0]?.structure).toEqual({
-	expect((undone.data as UndoData).structureUndone).toBe('Лист «Октябрь» удалён — он был пуст.');
-	expect(await titles(h)).toEqual(['Лист1']);
A1	expect(conflict.error).toMatchObject({
A1	expect(await titles(h)).toEqual(['Лист1', 'Октябрь']);
A1	expect(((await undo(h, { force: true })).data as UndoData).status).toBe('ok');
A1	expect(await titles(h)).toEqual(['Лист1']);
Q16	expect(formats[1]).toEqual([
Q16	expect(formats[1]?.[0]).toEqual({ bold: true });
Q18	expect(formats[1]).toEqual([
Q16	expect(maskOf(request)).toEqual(BACKGROUND_MASK);
Q16	expect(request.cell).toStrictEqual({
Q16	expect(maskOf(request)).toEqual(BACKGROUND_MASK);
Q16	expect(request.cell).toStrictEqual({ userEnteredFormat: {} });
Q18	expect(maskOf(request)).toEqual([
Q18	expect(request.cell).toStrictEqual({
Q18	expect(maskOf(request)).toEqual([
Q18	expect(request.cell).toStrictEqual({ userEnteredFormat: {} });
Q16	expect(parsedFormat({ background: 'none' })).toStrictEqual({ background: null });
Q16	expect(parsedFormat({ background: '#17365D', bold: true })).toStrictEqual({
Q18	expect(parsedFormat({ textColor: '#FFFFFF', bold: true })).toStrictEqual({
Q18	expect(parsedFormat({ textColor: 'none', background: 'none' })).toStrictEqual({
Q16	expect(payload.code).toBe('bad_request');
Q16	expect(payload.cause).toBe('schema_violation');
Q16	expect(payload.detail).toContain('format.background: фон — #RRGGBB или "none" (без заливки)');
Q18	expect(payload.code).toBe('bad_request');
Q18	expect(payload.detail).toContain(
Q18	expect(payload.detail).toContain(
Q18	expect(byName['Сервис']?.headerFormat).toEqual({ ...carlito, background: '#17365d' });
B2	expect(byName[name]?.headerFormat, name).toEqual(carlito);
B2	expect(byName['Сервис']?.format).toEqual({ background: '#c1e4f5' });
Q18	expect(workspace?.['Логин']).toEqual({ background: '#c1e4f5' });
Q18	expect(github?.['Логин']).toEqual({ background: '#ffffff' });
Q18	expect(openai?.['Статус']).toEqual({ background: '#f4cccc', textColor: '#cc0000' });
Q18	expect(anthropic).toEqual({});
A3	expect(planned.map((c) => c.a1)).toEqual([`${TITLE}!A3`, `${TITLE}!B3`]);
A3	expect(planned[0]?.beforeFormat).toEqual({ background: '#c1e4f5' });
A3	expect(planned[0]?.afterFormat).toStrictEqual({ background: null });
A3	expect(g.requests).toHaveLength(0);
A3	expect(written.data).toMatchObject({ status: 'ok' });
A3	expect(g.requests).toHaveLength(2);
A3	expect(request.repeatCell?.fields).toBe(
A3	expect(request.repeatCell?.cell).toStrictEqual({ userEnteredFormat: {} });
A3	expect(journalled[0]?.changes[0]?.afterFormat).toStrictEqual({ background: null });
Q16	expect(result.data).toMatchObject({ status: 'no_change' });
Q16	expect(g.requests).toHaveLength(0);
Q16	expect(result.ok).toBe(false);
Q16	expect(JSON.stringify(result.error)).toContain('#RRGGBB или \\"none\\" (без заливки)');
Q16	expect(g.requests).toHaveLength(0);
Q18	expect(written.data).toMatchObject({ status: 'ok' });
B2	expect(header?.beforeFormat).toEqual({
B2	expect(header?.afterFormat).toMatchObject({ background: '#17365D', textColor: '#FFFFFF' });
B2	expect((request?.fields ?? '').split(',')).toEqual(
B2	expect(request?.cell?.userEnteredFormat?.textFormat?.foregroundColorStyle).toEqual({
Q16	expect(formatKey({ background: null })).toBe(formatKey(undefined));
Q16	expect(formatKey({ background: null, textColor: null, bold: true })).toBe(
Q16	expect(formatKey({ background: '#ffffff' })).not.toBe(formatKey(undefined));
Q16	expect(formatKey({ background: '#ffffff' })).not.toBe(formatKey({ background: null }));
Q18	expect(formatKey({ textColor: '#FFFFFF' })).toBe(formatKey({ textColor: '#ffffff' }));
Q18	expect(formatKey({ background: '#17365D' })).toBe(formatKey({ background: '#17365d' }));
Q18	expect(formatKey({ textColor: '#ffffff' })).not.toBe(formatKey({ textColor: '#fffffe' }));
Q18	expect(formatKey({ textColor: '#ffffff' })).not.toBe(formatKey({ background: '#ffffff' }));
Q16	expect(outcome.status).toBe('ok');
Q16	expect(client.formatWrites).toStrictEqual([formatWrite({ background: null })]);
Q16	expect((await client.getSpreadsheet()).sheets[0]?.rows[1]?.[0]?.format).toBeUndefined();
Q16	expect(outcome.status).toBe('ok');
Q16	expect(client.formatWrites).toStrictEqual([formatWrite({ background: '#c1e4f5' })]);
Q18	expect(outcome.status).toBe('ok');
Q18	expect(client.formatWrites).toStrictEqual([formatWrite({ textColor: null })]);
Q18	expect((await client.getSpreadsheet()).sheets[0]?.rows[1]?.[0]?.format).toEqual({ bold: true });
Q18	await expect(undo(client, { afterFormat: { textColor: '#FFFFFF' } })).rejects.toMatchObject({
Q18	expect(client.formatWrites).toHaveLength(0);
Q16	expect(page).toContain('>фон #c1e4f5<');
Q16	expect(page).toContain('>без заливки<');
Q18	expect(page).toContain('жирный, цвет текста #FFFFFF');
Q18	expect(page).toContain('жирный, фон #17365D, цвет текста листа');
Q11	expect(rows[0]?.[0]?.format).toEqual({ bold: true, fontFamily: 'Carlito', fontSize: 11 });
Q11	expect(rows[1]?.[1]?.format).toEqual({ ...CARLITO_10, numberFormat: DATE_DOTTED });
Q11	expect(rows[3]?.[0]?.format).toEqual({ fontFamily: 'Arial', fontSize: 10 });
Q11	expect(rows[3]?.[1]?.format).toBeUndefined();
X1	expect(cells[0]?.format).toEqual({ fontSize: 10 });
X1	expect(cells[1]?.format).toEqual({ numberFormat: { type: 'NUMBER' } });
X1	expect(cells[2]?.format).toBeUndefined();
X1	expect(cells[3]?.format).toEqual({ bold: true });
Q11	expect(byName['Проект']?.headerFormat).toEqual({
Q11	expect(byName['Проект']?.format).toEqual(CARLITO_10);
Q11	expect(byName['Запуск']?.format).toEqual({ ...CARLITO_10, numberFormat: DATE_DOTTED });
Q38	expect(data.rows.value).toHaveLength(5);
Q38	expect(data.rows.value[4]).toEqual({ Проект: null, Запуск: null, Владелец: null });
Q38	expect(data.formats.value).toHaveLength(data.rows.value.length);
Q38	expect(data.formats.value[4]).toEqual({ Проект: CARLITO_10, Запуск: CARLITO_10 });
Q38	expect(data.formats.kind).toBe('data');
Q38	expect(data.formats.value[0]).toEqual({
Q38	expect(data.rows.value[2]).toMatchObject({ Проект: 'portfolio' });
Q38	expect(data.formats.value[2]).toEqual({ Проект: { fontFamily: 'Arial', fontSize: 10 } });
Q38	expect(data.formats.value[3]).toEqual({});
Q11	expect(result.ok).toBe(true);
Q11	expect(result.data).not.toHaveProperty('formats');
Q11	expect((result.data as { rows: { value: unknown[] } }).rows.value).toHaveLength(4);
Q12	expect(op.op === 'formatCells' ? op.format : null).toEqual({
Q12	expect(payload.code).toBe('bad_request');
Q12	expect(payload.cause).toBe('schema_violation');
Q12	expect(payload.detail).toContain('format.fontSize: кегль — целое число пунктов от 6 до 96');
Q12	expect(payload.code, field).toBe('bad_request');
Q12	expect(payload.detail, field).toContain(`format.${field}`);
Q12	expect(payload.detail, field).toContain('пишет только откат');
Q12	expect(type.detail).toContain(
Q12	expect(typo.code).toBe('bad_request');
Q12	expect(typo.detail).toContain('patern');
Q12	expect(typo.detail).toContain(
Q12	expect(maskOf(request)).toEqual([
Q12	expect(request.cell).toStrictEqual({
Q12	expect(request.range).toEqual({
Q12	expect(typed.fields).toBe('userEnteredFormat.numberFormat');
Q12	expect(typed.cell).toStrictEqual({ userEnteredFormat: { numberFormat: { type: 'NUMBER' } } });
Q12	expect(bold.fields).toBe('userEnteredFormat.textFormat.bold');
Q12	expect(bold.cell).toStrictEqual({ userEnteredFormat: { textFormat: { bold: true } } });
Q12	expect(maskOf(reset)).toEqual([
Q12	expect(reset.cell).toStrictEqual({ userEnteredFormat: {} });
Q12	expect(maskOf(mixed)).toEqual([
Q12	expect(mixed.cell).toStrictEqual({ userEnteredFormat: { textFormat: { bold: true } } });
Q12	expect(formatKey({ fontFamily: null, fontSize: null, numberFormat: null })).toBe(
Q12	expect(formatKey({ bold: true, fontFamily: null })).toBe(formatKey({ bold: true }));
Q12	expect(formatKey({ numberFormat: { pattern: 'dd.mm.yyyy', type: 'DATE' } })).toBe(
Q12	expect(formatKey({ numberFormat: { type: 'DATE' } })).not.toBe(dotted);
Q12	expect(formatKey({ numberFormat: { type: 'DATE_TIME', pattern: 'dd.mm.yyyy' } })).not.toBe(
Q12	expect(formatKey({ fontFamily: 'Carlito' })).not.toBe(formatKey({ fontFamily: 'Arial' }));
Q12	expect(formatKey({ fontFamily: 'Carlito' })).not.toBe(formatKey(undefined));
Q12	expect(formatKey({ fontSize: 10 })).not.toBe(formatKey({ fontSize: 11 }));
Q12	expect(result.data).toMatchObject({ status: 'no_change' });
Q12	expect(g.requests).toHaveLength(0);
Q12	expect(preview.data).toMatchObject({ status: 'preview' });
B4	expect(planned?.a1).toBe(`${TITLE}!B4`);
B4	expect(planned?.beforeFormat).toBeUndefined();
B4	expect(planned?.afterFormat).toEqual({ ...CARLITO_10, numberFormat: DATE_DOTTED });
B4	expect(g.requests).toHaveLength(0);
B4	expect(written.data).toMatchObject({ status: 'ok' });
B4	expect(g.requests).toHaveLength(1);
B4	expect((g.requests[0]?.repeatCell?.fields ?? '').split(',').sort()).toEqual(mask);
B4	expect(journalled[0]?.changes[0]?.afterFormat).toEqual({
Q12	expect(outcome.status).toBe('ok');
Q12	expect(client.formatWrites).toStrictEqual([
Q12	expect(outcome.status).toBe('ok');
Q12	expect(client.formatWrites).toStrictEqual([
Q12	await expect(
Q12	expect(client.formatWrites).toHaveLength(0);
B5	expect(html).toContain('шрифт Arial, кегль 11');
B5	expect(html).toContain('шрифт Carlito, кегль 10, формат DATE dd.mm.yyyy');
B5	expect(html).toContain('>формат NUMBER<');
B5	expect(html).toContain('шрифт листа, кегль листа, формат числа листа');
A2	expect(result.ok).toBe(true);
Q23	expect(header[1]).toEqual({ value: 'Оценка', note: RULES['Оценка'] });
Q23	for (const index of [0, 2, 3]) expect(header[index], `${index}`).not.toHaveProperty('note');
Q23	expect(window.rows[0]?.[1]).toEqual({ value: '16', note: 'по факту 2 дня' });
Q24	expect(columnOf(map, name)?.headerNote, name).toEqual({
Q24	expect(columnOf(map, name), name).not.toHaveProperty('headerNote');
Q24	expect(map).not.toHaveProperty('notesAboveHeader');
Q24	expect(map.warnings[0]).toBe(
Q24	expect(map.notesAboveHeader).toEqual({
A1	expect(map.columns.filter((column) => column.headerNote !== undefined)).toEqual([]);
A1	expect(map.warnings[0]).toBe(
C2	expect(columnOf(map, 'Проект')?.headerNote).toEqual({
A2	expect(map.notesAboveHeader).toMatchObject({
A1	expect(map.warnings[0]).toBe(
Q25	expect(result.error).toBeUndefined();
Q25	expect((data['rows'] as { value: unknown[] }).value).toHaveLength(notes.length);
Q25	expect(data['notes']).toEqual({ kind: 'data', origin: origin('Задачи'), value: notes });
Q25	expect(data['warnings']).toEqual([]);
Q25	expect(await read({})).not.toHaveProperty('notes');
Q25	expect((both['formats'] as { value: unknown }).value).toEqual([
Q25	expect((both['notes'] as { value: unknown }).value).toEqual(notes);
Q26	expect(result.data).toMatchObject({ status: 'preview' });
Q26	expect((result.data as ApplyOutcome).notes).toEqual([hint('Оценка')]);
Q26	expect(result.data).toMatchObject({ status: 'preview' });
Q26	expect(hintsOf(result)).toEqual(columns.map(hint));
Q26	expect(statuses).toEqual(['preview', 'no_change', 'preview']);
Q26	expect(outcomes.map(hintsOf)).toEqual([[], [], [hint('Оценка')]]);
Q26	expect(result.data).toMatchObject({ status: 'ok' });
K3	expect(client.writes.map((write) => write.range)).toEqual([`${TRACKER}!K3`]);
K3	expect((result.data as ApplyOutcome).notes).toEqual([hint('Оценка')]);
Q21	expect(detail).toContain('ссылкой на неё (https://drive.google.com/drive/folders/<id папки>)');
Q21	expect(detail).toContain('папкой реестра с правом записи');
Q21	expect(detail).toContain('"root" — «Мой диск» под разрешением проекта');
Q20	expect(result.error).toBeUndefined();
Q20	expect((result.data as Outcome).status).toBe('ok');
L11	expect(google.calls.map((call) => call.method)).toEqual(['get', 'create']);
L11	expect(google.calls[0]?.params).toEqual({
L11	expect(google.calls[1]?.params).toMatchObject({
Q20	expect(preview.status).toBe('preview');
Q20	expect(preview.structural?.anchor).toBe('папку «ТЗ» в папке «Проекты 2026»');
Q20	expect(preview.assumptions).toEqual([
Q20	expect(preview.notes).toEqual([]);
Q20	expect(written).toMatchObject({
Q20	expect(google.calls.filter((call) => call.method === 'create')).toHaveLength(1);
Q20	expect(created.status).toBe('ok');
Q20	expect(drive.created).toEqual([
Q20	expect(journalled).toHaveLength(1);
Q20	expect(journalled[0]).toMatchObject({
Q20	expect(revisions()).toBe(0);
Q20	expect(undone.data).toMatchObject({ status: 'ok', undoneCorrelationId: created.correlationId });
Q20	expect(drive.trashed).toEqual(['FILE1']);
Q20	expect(byFolder.data).toMatchObject({ status: 'nothing_to_undo', reason: 'journal_empty' });
Q20	expect(byRoot.data).toMatchObject({ status: 'ok', undoneCorrelationId: 'gc-before-fix' });
Q20	expect(drive.trashed).toEqual(['OLD1']);
Q21	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
Q21	expect(result.error?.detail).toContain(
Q21	expect(result.error?.detail).toContain('ничего не создано');
Q21	expect(google.calls.map((call) => call.method)).toEqual(['get']);
Q21	expect(result.error).toMatchObject({
Q21	expect(result.error?.detail).toContain(`Drive этого профиля не видит ${id}`);
Q21	expect(result.error?.detail).toContain('Ничего не создано, и в корне «Мой диск» тоже.');
Q21	expect(google.calls.map((call) => call.method)).toEqual(['get']);
Q21	expect(result.error).toMatchObject({
Q21	expect(result.error?.detail).toBeUndefined();
Q21	expect(drive.created).toEqual([]);
Q21	await expect(
Q21	expect(result.ok).toBe(false);
Q21	expect(result.error?.cause).toBe('create_needs_folder');
Q21	expect(google.calls.map((call) => call.method)).toEqual(['get']);
Q21	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
Q21	expect(grants()).toBe(0);
Q21	expect(drive.asked).toEqual([]);
Q21	expect(result.error?.code).toBe('needs_grant');
Q21	expect(drive.asked).toEqual([]);
Q21	expect(drive.created).toEqual([]);
Q22	expect(result.data).toMatchObject({
Q22	expect(google.calls.map((call) => call.method)).toEqual(['create']);
Q22	expect(google.calls[0]?.params).toMatchObject({ requestBody: { parents: ['root'] } });
Q22	expect(journalled[0]?.targetId).toBe('root');
Q22	expect(preview.structural?.anchor).toBe(`папку «ТЗ» в ${where}`);
Q22	expect((await callMcp(gcApply, confirmed, deps)).data).toMatchObject({ status: 'ok' });
Q22	expect(drive.asked).toEqual([]);
Q22	expect(drive.created).toEqual([{ id: 'FILE1', name: 'ТЗ', kind: 'folder', parentId: id }]);
Q22	expect(journalled[0]?.targetId).toBe(id);
Q22	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
Q22	expect(result.error?.detail).toContain(`Цель ${OTHER_ID} — ${kind}, а не папка (по ссылке)`);
Q22	expect(drive.asked).toEqual([]);
Q22	expect(drive.created).toEqual([]);
Q22	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
Q22	expect(result.error?.detail).toContain(
Q22	expect(drive.asked).toEqual([]);
Q22	expect(drive.created).toEqual([]);
Q22	await expect(createParentOf(sheet, drive)).rejects.toMatchObject({
Q22	expect(drives).toBe(0);
Q39	expect(preview.data).toMatchObject({ status: 'preview' });
Q39	expect(planOf(preview.data)).toEqual([
C3	expect((preview.data as ApplyOutcome).changes.map((change) => change.kind)).toEqual([
C3	expect(journalled).toHaveLength(0);
C3	expect(written.data).toMatchObject({ status: 'ok' });
C3	expect(await valuesOf(client, 3)).toEqual([
C3	expect(await valuesOf(client, 4)).toEqual([null, null, null, null, null, null]);
C3	expect(await valuesOf(client, 5)).toEqual([null, '19.10', '2:15', null, null, null]);
C3	expect(journalled.map((record) => record.changes.map((change) => change.a1))).toEqual([
B3	expect(undone.data).toMatchObject({ status: 'ok' });
B3	expect(await valuesOf(client, 3)).toEqual([null, null, null, null, null, null]);
B3	expect(journalled.map((record) => record.op)).toEqual(['setCells', 'undo']);
Q39	expect(planOf(asText.data)).toEqual(planOf(asObject.data));
Q39	expect(planOf(asText.data).map((change) => change.a1)).toEqual([
C4	expect(wrong.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
C4	expect(wrong.error?.detail).toContain('rows у setCells — {from, to}: номера строк листа');
Q39	expect(data.status).toBe('confirm_required');
Q39	expect(data.changes).toHaveLength(4);
Q39	expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
Q39	expect(await valuesOf(client, 3)).toEqual([null, null, null, null, null, null]);
Q39	expect(journalled).toHaveLength(0);
Q39	expect(result.data).toMatchObject({ status: 'no_change', changes: [] });
Q39	expect(await valuesOf(client, 3)).toEqual([null, null, null, null, null, null]);
Q39	expect(journalled).toHaveLength(0);
Q39	expect(format.error?.detail).toBe(
Q39	expect(values.data).toMatchObject({ status: 'preview' });
Q39	expect([...new Set(rows)]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
Q39	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
Q39	expect(result.error?.detail).toContain('(where, rows)');
Q39	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
Q39	expect(result.error?.detail).toBe(
Q39	expect(result.error, JSON.stringify(selection)).toMatchObject({
Q39	expect(result.error?.detail).toContain('setCells: не выбраны строки');
Q39	expect(result.error?.detail).not.toContain('allRows: true —');
Q39	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'rows_reversed' });
Q39	expect(result.error?.detail).toBe(
Q39	expect(result.error, JSON.stringify(rows)).toMatchObject({
Q39	expect(result.error?.detail).toContain('данные — строки 2–9');
Q39	expect(result.error?.detail).toContain(
Q39	expect(result.error?.detail).not.toContain('headerOnly');
Q39	expect(result.error?.detail).not.toContain('appendRow');
Q39	expect(whole.error?.detail).toBe(
Q39	expect(await valuesOf(client, 1)).toEqual([null, ...COLUMNS]);
Q39	expect(result.error, JSON.stringify(rows)).toMatchObject({
Q39	expect(result.error?.detail).toContain('данные — строки 2–9');
Q39	expect(result.error?.detail).toContain(
Q39	expect(result.error?.detail).not.toContain('Шапка');
Q39	expect(single.error?.detail).toContain('rows: строка 12 — за пределами');
Q39	expect(planOf(last.data).map((change) => change.a1)).toEqual([
C9	expect(await valuesOf(client, 10)).toEqual([null, null, null, null, null, null]);
Q39	expect(below.error?.detail).toBe(
Q39	expect(header.error?.detail).toBe(
C9	expect(planOf(found.data)).toEqual([{ a1: 'Отчёт!C9', before: '2:00', after: '2:10' }]);
C9	expect(none.data).toMatchObject({ status: 'needs_clarification' });
C9	expect(JSON.stringify(none.data)).toContain(
C9	expect(JSON.stringify(unformatted.data)).toContain(
Q39	expect(result.data).toMatchObject({
Q39	expect(preview.status).toBe('preview');
Q39	await expect(
Q39	expect(client.writes).toHaveLength(0);
Q39	await expect(setRows(client, data, selection, TASK)).rejects.toMatchObject({
Q39	await expect(setRows(client, data, nothing, TASK)).rejects.toMatchObject({
Q39	await expect(
Q39	await expect(setRows(client, data, { rows: { from: 1, to: 1 } }, TASK)).rejects.toMatchObject({
Q39	await expect(
Q39	expect(client.writes).toHaveLength(0);
Q39	expect(client.formatWrites).toHaveLength(0);
Q39	expect(schema.properties['rows']?.description).toContain(
Q39	expect(schema.properties['format']?.description).toContain(
Q41	expect(parsedFormat({ numberFormat: 'none' })).toStrictEqual({ numberFormat: null });
Q41	expect(parsedFormat({ numberFormat: 'none', bold: true })).toStrictEqual({
Q41	expect(parsedFormat({ numberFormat: { type: 'TIME', pattern: 'h:mm' } })).toStrictEqual({
Q41	expect(payload.code).toBe('bad_request');
Q41	expect(payload.cause).toBe('schema_violation');
Q41	expect(payload.detail).toContain(
Q41	expect(refusal({ numberFormat: { type: 'AUTO' } }).detail).toContain(
Q41	expect(refusal({ numberFormat: { type: 'TIME', pattern: '' } }).detail).toContain(
Q41	expect(typo.detail).toContain('format.numberFormat: Unrecognized key: "patern"');
Q41	expect(typo.detail).toContain('Допустимые поля вида: bold, italic');
Q41	expect(
C3	expect(g.requests).toHaveLength(0);
C3	expect(written.data).toMatchObject({ status: 'ok' });
C3	expect(g.requests).toHaveLength(2);
C3	expect(request.repeatCell?.fields).toBe('userEnteredFormat.numberFormat');
C3	expect(request.repeatCell?.cell).toStrictEqual({ userEnteredFormat: {} });
C3	expect(journalled[0]?.changes.map((change) => change.afterFormat)).toStrictEqual([
Q41	expect(await formatsOfRow3()).toEqual({ 'Суть задачи': DAY, Время: SPENT });
Q41	expect(written.data).toMatchObject({ status: 'ok' });
Q41	expect(await formatsOfRow3()).toEqual({});
Q41	expect(undone.data).toMatchObject({ status: 'ok' });
Q41	expect(await formatsOfRow3()).toEqual({ 'Суть задачи': DAY, Время: SPENT });
Q41	expect(journalled.map((record) => record.op)).toEqual(['formatCells', 'undo']);
Q41	expect(sheet.rows[2]?.map((cell) => cell.format)).toEqual([
Q41	expect(result.data).toMatchObject({ status: 'no_change' });
Q41	expect(g.requests).toHaveLength(0);
Q15	expect(column(book(DOTTED_SHEET), 'Дата старта').dateFormat).toBe('dotted');
Q15	expect(write(book(DOTTED_SHEET), 'Дата старта', '2026-09-10')).toEqual({
Q15	expect(column(iso, 'Дата старта').dateFormat).toBe('iso');
Q15	expect(write(iso, 'Дата старта', '10.09.2026')).toMatchObject({ value: '2026-09-10' });
Q15	expect(write(book(plain, 'ru_RU'), 'Дата старта', '2026-09-10')).toMatchObject({
Q15	expect(write(book(plain, 'en_US'), 'Дата старта', '2026-09-10')).toEqual({
Q15	expect(column(book(plain), 'Дата старта').dateFormat).toBeNull();
Q15	expect(write(book(plain), 'Дата старта', '2026-09-10')).toMatchObject({ value: '2026-09-10' });
Q15	expect(column(tie, 'Дата старта').dateFormat).toBeNull();
Q15	expect(localeDateStyle('ru_RU')).toBe('dotted');
Q15	expect(localeDateStyle('de-DE')).toBe('dotted');
Q15	expect(localeDateStyle('uk')).toBe('dotted');
Q15	expect(localeDateStyle('en_US')).toBeNull();
Q15	expect(localeDateStyle('en_GB')).toBeNull();
Q15	expect(localeDateStyle(undefined)).toBeNull();
Q15	expect(column(one('2026-09-01'), 'Дата запуска').type).toBe('string');
Q15	expect(write(one('2026-09-01'), 'Дата запуска', '10.09.2026')).toEqual({
Q15	expect(write(one('01.09.2026'), 'Дата запуска', '2026-09-10')).toMatchObject({
Q15	expect(column(book(DOTTED_SHEET), 'Сдано').type).toBe('date');
Q15	expect(write(book(DOTTED_SHEET), 'Сдано', '2026-09-10')).toMatchObject({
Q15	expect(write(ru, 'Дата старта', text)).toEqual({ status: 'ok', value: text, note: null });
Q15	expect(result.status).toBe('ok');
Q15	expect(client.writes).toContainEqual(
Q15	expect(ru.locale).toBe('ru_RU');
Q15	expect(none).not.toHaveProperty('locale');
-	expect(drive.calls).toEqual([
-	expect(drive.media[0]?.bytes?.equals(bytes)).toBe(true);
-	expect(info).toStrictEqual({
-	await expect(client(drive).upload(FOLDER, 'ролик.mp4', body)).rejects.toMatchObject({
-	expect(drive.calls).toHaveLength(1);
-	expect(open.method).toBe('POST');
-	expect(`${url.origin}${url.pathname}`).toBe('https://www.googleapis.com/upload/drive/v3/files');
-	expect(Object.fromEntries(url.searchParams)).toEqual({
-	expect(open.headers).toEqual({
-	expect(JSON.parse(String(open.body))).toEqual({
-	expect(drive.calls).toEqual([]);
-	expect(info).toMatchObject({ id: 'NEW1', size: 600_000, sha256: sha256(bytes) });
-	expect(putsOf(session.requests)).toEqual([
-	expect(session.received().equals(bytes)).toBe(true);
-	expect(putsOf(session.requests)).toEqual([
-	expect(session.received().equals(bytes)).toBe(true);
-	expect(putsOf(session.requests)).toEqual([
-	expect(session.received().equals(bytes)).toBe(true);
-	expect(putsOf(session.requests)).toEqual([
-	expect(session.received().equals(bytes)).toBe(true);
-	expect(putsOf(session.requests).slice(0, 3)).toEqual([
-	expect(session.received().equals(bytes)).toBe(true);
-	expect(putsOf(session.requests).slice(2)).toEqual([
-	expect(info).toMatchObject({ id: 'NEW1', size: 600_000, sha256: sha256(bytes) });
-	expect(putsOf(session.requests).slice(2)).toEqual([
-	expect(info).toMatchObject({ id: 'NEW1', size: 600_000, sha256: sha256(bytes) });
-	await expect(error).rejects.toMatchObject({
-	expect(putsOf(session.requests)).toHaveLength(2);
-	await expect(
-	expect(putsOf(session.requests)).toEqual([['bytes 0-262143/600000', 262_144]]);
-	await expect(
-	expect(putsOf(session.requests)).toEqual([
-	await expect(
-	expect(putsOf(session.requests)).toEqual([['bytes 0-262143/600000', 262_144]]);
-	await expect(
-	expect(requests).toHaveLength(1);
-	await expect(
-	expect(drive.calls.map((call) => call.method)).toEqual(['files.create']);
-	expect(session.requests).toEqual([]);
-	expect(putsOf(session.requests)).toEqual([
-	expect(() => client(fakeDrive(), undefined, { chunkBytes })).toThrow(
-	expect(drive.calls).toEqual([
-	expect(drive.media[0]?.bytes?.equals(bytes)).toBe(true);
-	expect(info).toMatchObject({
-	expect(open.method).toBe('PATCH');
-	expect(url.pathname).toBe(`/upload/drive/v3/files/${FILE}`);
-	expect(url.searchParams.get('supportsAllDrives')).toBe('true');
-	expect(url.searchParams.get('fields')).toBe(FIELDS);
-	expect(JSON.parse(String(open.body))).toEqual({ mimeType: 'video/mp4' });
-	expect(putsOf(session.requests)).toHaveLength(3);
-	expect(drive.calls).toEqual([]);
-	expect(info).toMatchObject({ id: FILE, size: 600_000, sha256: sha256(bytes) });
-	await expect(client(drive).replace(FILE, body)).rejects.toMatchObject({
-	expect(drive.calls).toHaveLength(1);
-	expect(drive.calls).toEqual([
-	await expect(client(drive).keepRevision(FILE, 'REV1')).rejects.toMatchObject({
-	expect(drive.calls.slice(0, 2)).toEqual([
-	expect(drive.calls[2]).toMatchObject({
-	expect(drive.media[0]?.path.startsWith(scratch)).toBe(true);
-	expect(drive.media[0]?.bytes?.equals(old)).toBe(true);
-	expect(info).toMatchObject({
-	expect(await readdir(scratch)).toEqual([]);
-	expect(session.requests[0]).toMatchObject({
-	expect(session.received().equals(old)).toBe(true);
-	expect(info).toMatchObject({ id: FILE, sha256: sha256(old) });
-	expect(await readdir(scratch)).toEqual([]);
-	await expect(client(drive).restoreRevision(FILE, 'REV1')).rejects.toMatchObject({
-	expect(drive.media[0]?.path.startsWith(scratch)).toBe(true);
-	expect(existsSync(drive.media[0]!.path)).toBe(false);
-	expect(await readdir(scratch)).toEqual([]);
-	await expect(client(drive).restoreRevision(FILE, 'REV1')).rejects.toMatchObject({
-	expect(drive.calls.map((call) => call.method)).toEqual(['revisions.get', 'revisions.get']);
-	expect(await readdir(scratch)).toEqual([]);
-	expect(drive.calls).toEqual([
-	expect(info).toStrictEqual({
-	expect(info).toStrictEqual(sheet);
-	await expect(client(fakeDrive()).fileInfo('NOPE')).rejects.toMatchObject({
F1	expect(drive.calls).toEqual([
F1	expect(found).toStrictEqual([
-	expect(drive.calls[0]?.params).toMatchObject({
-	expect(listParams({ nameContains: "a\\b'c" }, 10)['q']).toContain("name contains 'a\\\\b\\'c'");
-	expect(await client(fakeDrive({ list })).findByName(FOLDER, 'ролик.mp4')).toEqual([]);
-	await expect(client(drive).findByName(FOLDER, 'ролик.mp4')).rejects.toMatchObject({
-	expect(response).toEqual({ status: 308, headers: { range: 'bytes=0-262143' }, body: '' });
-	expect(request?.url).toBe(SESSION);
-	expect(request?.init?.method).toBe('PUT');
-	expect(headers.get('authorization')).toBe('Bearer fake-access');
-	expect(headers.get('content-range')).toBe('bytes 0-262143/600000');
-	expect(request?.init?.body).toBe(chunk);
-	expect(response.status).toBe(200);
-	expect(response.body).toBe(file);
-	expect(seen[0]?.init?.body).toBeUndefined();
-	expect(putsOf(session.requests)[0]).toEqual(['bytes */600000', null]);
-	expect(session.received().equals(bytes)).toBe(true);
U1	expect(full.payload).toMatchObject({ code: 'storage_full', retryable: false });
U1	expect(full.payload.title).toBe('На Диске Google нет места');
U1	expect(reason.payload.code).toBe('storage_full');
U1	expect(rate.payload).toMatchObject({ code: 'quota_exceeded', retryable: true });
-	expect(align).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
-	expect(align.detail).toContain(
-	expect(paste.detail).toContain('paste: значения «всё» нет; допустимы: all, values, format');
-	expect(literal.detail).toContain('where.firstParagraph: ');
-	expect(literal.detail).not.toContain('нет; допустимы');
-	expect(notString.detail).toContain('format.align: ');
-	expect(notString.detail).not.toContain('нет; допустимы');
Q20	import { expect } from 'vitest';
Q20	await expect(setHeader(client, data, request, { dryRun: false })).rejects.toMatchObject({
Q20	expect(client.writes).toHaveLength(0);
B1	expect(plan.changes.map((change) => change.a1)).toEqual(['Лист!B1']);
B1	expect(client.formatWrites).toContainEqual(
B1	await expect(undoStructure(edited, 'SHEET', added, {}, async () => {})).rejects.toMatchObject({
B1	expect(edited.formatWrites).toHaveLength(0);
B1	import { expect } from 'vitest';
L22	expect(answer.rows.value).toHaveLength(cap);
L22	expect(answer.truncated).toBe(true);
L22	expect(answer.nextFromRow).toBe(cap + 2);
L11	await expect(client.getSpreadsheet('SHEET', { sheet: 'Лист' })).rejects.toMatchObject({
L11	expect(calls).toEqual(['размер']);
L11	expect(WRITE_MAX_SHEET_ROWS).toBe(limitOf('write.max-sheet-rows', -1));
L11	expect(WRITE_MAX_SHEET_ROWS).toBeGreaterThan(0);
Q17	expect(thrownBy(() => parseOperation({ ...base, ...fields }))).toMatchObject({
Q17	await expect(
A2	expect(preview.changes.map((change) => change.a1)).toEqual(['Лист!A2', 'Лист!A3', 'Лист!A4']);
A1	expect(header.changes.map((change) => change.a1)).toEqual(['Лист!A1']);
Q39	expect(thrownBy(() => parseOperation({ ...cells, ...fields }))).toMatchObject({
A2	expect(byNumber.changes.map((change) => change.a1)).toEqual(['Лист!A2']);
Q14	expect(preview.notes).toContain('оформление строки 3 — как у строки 2, с проверкой данных');
Q14	expect(client.order).toEqual(['copyPaste:format', 'copyPaste:validation', 'values']);
Q40	expect(asked).toMatchObject({ status: 'needs_clarification', questions: [{ field: key }] });
Q40	expect(client.writes).toHaveLength(0);
B3	expect(preview.changes.map((change) => change.a1)).toContain('Лист!B3');
Q42	expect(thrownBy(() => parseOperation({ ...base, ...fields }))).toMatchObject({
Q42	await expect(
A3	expect(preview.changes.map((change) => change.a1)).toEqual(['Лист!A3']);
Q43	await expect(
Q43	expect(client.order).toEqual(['insertDimension', 'copyPaste:format', 'copyPaste:validation']);
Q14	import { expect } from 'vitest';
Q14	await expect(vetLocalFile(project, path), path).rejects.toMatchObject({
Q14	await expect(vetLocalFile(project, 'guide.md')).resolves.toMatchObject({ name: 'guide.md' });
Q14	expect(orphan.error).toMatchObject({
Q14	expect(drive.calls).toEqual([]);
Q14	expect(fresh.data).toMatchObject({ status: 'ok', file: { id, name: 'sales.mp4' } });
Q14	expect(drive.revisionsOf(id)).toHaveLength(2);
Q14	expect(twins.data).toMatchObject({ status: 'needs_clarification' });
Q14	expect(drive.revisionsOf(id)).toHaveLength(2);
Q14	expect(result.data).toMatchObject({
Q14	expect(drive.revisionsOf(id)).toHaveLength(1);
Q14	expect(result.error).toMatchObject({
Q14	expect(await drive.findByName(FOLDER, 'guide.md')).toEqual([]);
Q14	await expect(vetLocalFile(project, 'big.bin')).rejects.toMatchObject({
Q14	await expect(locateLocalFile(project, 'exact.bin')).resolves.toMatchObject({ size: max });
Q17	expect(result.data).toMatchObject({ status: 'ok' });
A2	expect(addresses(result.data)).toEqual(B2_D2);
A2	expect((result.data as { changes: unknown[] }).changes[0]).toMatchObject({
A2	expect(client.formatWrites).toEqual(
A2	expect(client.writes).toHaveLength(0);
A2	expect(journalled.map((record) => record.changes.length)).toEqual([3]);
A2	expect(sheet.rows[1]!.map((cell) => cell.format?.background)).toEqual([NAVY, NAVY, NAVY, NAVY]);
A2	expect(line.map((cell) => cell.format)).toEqual([undefined, undefined, undefined, undefined]);
Q17	expect(result.error, named).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
Q17	expect(result.error?.detail, named).toContain(named);
Q17	expect(rowSelectionOf({ headerOnly: true }, 'formatCells')).toEqual({ headerOnly: true });
Q17	expect(rowSelectionOf({ headerOnly: false, allRows: true }, 'formatCells')).toEqual({
Q17	expect(result.error, JSON.stringify(call)).toMatchObject({
Q17	expect(result.error?.detail).toContain('headerOnly: true');
Q17	expect(both.data).toMatchObject({ status: 'preview' });
Q17	expect(addresses(both.data)).toEqual(B2_D2);
Q17	expect(planIdOf(both.data)).toBe(planIdOf(alone.data));
B2	expect(outcome.changes.map((change) => change.a1)).toEqual(['Аккаунты!B2']);
Q17	expect(data.status).toBe('confirm_required');
Q17	expect(data.changes).toHaveLength(3);
Q17	expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
Q17	expect(JSON.stringify(over.data)).toContain('конверт цели разрешает 2');
Q17	expect(tight.client.formatWrites).toHaveLength(0);
Q17	expect(tight.journalled).toHaveLength(0);
Q17	expect(within.data).toMatchObject({ status: 'ok' });
Q17	expect(tight.client.formatWrites).toHaveLength(2);
Q17	expect(result.data).toMatchObject({ status: 'preview' });
Q17	expect(addresses(result.data)).toEqual(B2_D2);
Q17	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
Q17	expect(result.error?.detail).toContain('headerOnly: true');
Q17	expect(result.error?.detail).toContain('includeHeader');
Q17	expect(client.formatWrites).toHaveLength(0);
Q17	expect(schema.properties['headerOnly']).toMatchObject({ type: 'boolean' });
Q17	expect(schema.properties['headerOnly']?.description).toContain('formatCells');
Q17	expect(schema.properties['allRows']?.description).toContain('headerOnly');
Q17	expect(schema.properties['includeHeader']?.description).toContain('headerOnly');
Q19	expect(asText.data).toMatchObject({ status: 'preview' });
D3	expect(addresses(asText.data)).toEqual(['Аккаунты!D3', 'Аккаунты!D4']);
D3	expect(planIdOf(asText.data)).toBe(planIdOf(asObject.data));
D3	expect(ok.data).toMatchObject({ status: 'ok' });
D3	expect(written.client.formatWrites).toMatchObject([
X7	expect(asText.data).toMatchObject({
X7	expect(planIdOf(asText.data)).toBe(planIdOf(asArray.data));
X7	expect(drive.created).toHaveLength(0);
Q19	expect(text.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
Q19	expect(text.error?.detail).toBe(
Q19	expect(result.error, rows).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
Q19	expect(result.error?.detail, rows).toContain(problem);
Q19	expect(result.error?.detail, rows).toContain(form);
Q19	expect(aboutFormat.error?.detail).toContain('Допустимые поля вида');
Q19	expect(aboutFormat.error?.detail).not.toContain('rows у');
Q19	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
Q19	expect(result.error?.detail).toContain('rows: Invalid input: expected array, received object');
Q19	expect(result.error?.detail).toContain('rows у createSheet — массив строк');
Q19	expect(reversed.error).toMatchObject({ code: 'bad_request', cause: 'rows_reversed' });
Q19	expect(outside.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
Q19	expect(outside.error?.detail).toContain('данные — строки 3–7');
Q19	expect(carried.success, carried.error?.message).toBe(true);
Q19	expect(operationOf(carried.data!)).toEqual(
Q19	expect(created.success, created.error?.message).toBe(true);
Q19	expect(schema.properties['rows']?.anyOf?.map((form) => form.type)).toEqual([
Q19	expect(columns.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
Q19	expect(columns.error?.detail).toContain(
Q19	expect(table.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
Q19	expect(table.error?.detail).toContain('rows: Invalid input: expected number, received string');
Q13	expect(result.data).toMatchObject({ status: 'preview' });
Q13	expect(addresses(result.data)).toEqual([
B8	expect(client.formatWrites).toHaveLength(0);
Q13	expect(result.data).toMatchObject({ status: 'preview' });
B4	expect(addresses(result.data)).toEqual(['Реестр!B4', 'Реестр!B5', 'Реестр!B6']);
Q13	expect(above.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
Q13	expect(above.error?.detail).toContain('данные — строки 3–64');
Q13	expect(above.error?.detail).toContain('includeHeader');
Q13	expect(below.error).toMatchObject({ code: 'bad_request', cause: 'rows_outside_data' });
Q13	expect(below.error?.detail).toContain('данные — строки 3–64');
Q13	expect(client.formatWrites).toHaveLength(0);
Q13	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'rows_reversed' });
Q13	expect(result.error?.detail).toContain('{from: 5, to: 10}');
Q13	expect(result.error, JSON.stringify(selection)).toMatchObject({
Q13	expect(result.error?.detail).toContain(way);
Q13	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_selection' });
Q13	expect(result.error?.detail).toContain('(where, allRows)');
Q13	expect(boundary.error).toMatchObject({ code: 'bad_request', cause: 'empty_condition' });
Q13	expect(boundary.error?.detail).toContain('allRows: true');
Q13	await expect(
Q13	expect(data.status).toBe('confirm_required');
Q13	expect(data.changes).toHaveLength(60);
Q13	expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
Q13	expect(JSON.stringify(result.data)).toContain(
Q13	expect(client.formatWrites).toHaveLength(0);
Q13	expect(journalled).toHaveLength(0);
Q13	expect(result.data).toMatchObject({ status: 'ok' });
Q13	expect(client.formatWrites).toHaveLength(50);
Q13	expect(client.writes).toHaveLength(0);
Q13	expect(journalled.map((record) => record.changes.length)).toEqual([50]);
Q13	expect(addresses(all.data)).toEqual([
B2	expect(addresses(span.data)).toEqual(['Реестр!B2', 'Реестр!B4', 'Реестр!B5']);
B2	expect(addresses(where.data)).toEqual(['Реестр!B2', 'Реестр!B3']);
Q13	expect(result.data, JSON.stringify(selection)).toMatchObject({
Q13	expect(JSON.stringify(result.data)).toContain('нет строк данных');
Q13	expect(schema.properties['allRows']).toMatchObject({ type: 'boolean' });
Q13	expect(schema.properties['allRows']?.description).toContain('formatCells');
Q13	expect(Object.keys(span?.properties ?? {})).toEqual(['from', 'to']);
Q13	expect(rows?.description).toContain('formatCells: {from, to}');
Q14	expect(result.data).toMatchObject({ status: 'ok' });
Q14	expect(g.calls).toEqual(['batchUpdate', 'values.batchUpdate']);
Q14	expect(g.requests).toEqual([COPY_ABOVE, LIST_ABOVE]);
Q10	expect(g.written).toHaveLength(3);
Q10	for (const range of g.written) expect(range).toMatch(/22$/);
Q14	expect(result.data).toMatchObject({ status: 'ok' });
Q14	expect(g.calls).toEqual(['batchUpdate', 'values.batchUpdate']);
Q14	expect(g.requests).toEqual([COPY_ABOVE, LIST_ABOVE]);
Q14	expect(result.data).toMatchObject({ status: 'ok' });
Q14	expect(g.calls).toEqual(['values.batchUpdate']);
Q14	expect(JSON.stringify(result.data)).not.toContain('оформление строки');
Q14	expect(result.data).toMatchObject({ status: 'preview' });
Q14	expect((result.data as { notes: string[] }).notes).toContain(
Q14	expect(g.calls).toEqual([]);
Q14	expect(result.ok).toBe(false);
Q14	expect(g.calls).toEqual(['batchUpdate']);
Q14	expect(g.written).toHaveLength(0);
Q14	expect(journalled).toHaveLength(0);
Q14	expect(outcome.status).toBe('ok');
Q14	expect(added?.map((cell) => cell.format)).toEqual([TEMPLATE, CENTERED, TEMPLATE]);
Q14	expect(added?.map((cell) => cell.value)).toEqual(['новый сервис', 'готово', null]);
Q14	expect(outcome.status).toBe('ok');
Q14	expect(client.formatWrites).toEqual([
Q14	await expect(
Q14	expect(client.formatWrites).toHaveLength(0);
Q14	expect(client.writes).toHaveLength(0);
Q14	expect(undone.status).toBe('ok');
Q14	expect(sheet?.rows[3]?.map((cell) => cell.value)).toEqual([null, null, null]);
Q14	expect(sheet?.rows[3]?.map((cell) => cell.format)).toEqual([TEMPLATE, CENTERED, TEMPLATE]);
A4	expect(again.changes.map((change) => change.a1)).toEqual(['Реестр!A4']);
Q8	expect(access?.enumValues).toBeNull();
Q8	expect(access?.enumSource).toBeNull();
Q8	expect(status?.enumSource).toBe('inferred');
Q8	expect([...(status?.enumValues ?? [])].sort()).toEqual(['в работе', 'готово', 'новая']);
Q8	expect(profile('Статус', ['да', 'нет', 'да', 'нет', 'да', 'нет'])?.enumValues).toBeNull();
Q8	expect(profile('Код', many)?.enumValues).toBeNull();
Q8	expect(profile('Дата', dates)?.enumValues).toBeNull();
Q8	expect(profile('Стоимость', numbers)?.enumValues).toBeNull();
Q8	expect(profile('Ссылка на вход', links)?.enumValues).toBeNull();
Q8	expect(profile('Связанные проекты', long)?.enumValues).toBeNull();
-	expect(status?.enumSource).toBe('validation');
-	expect(status?.enumValues).toEqual(['новая', 'готово', 'пауза']);
Q9	expect(profile('Стоимость/мес.', ['0'])?.type).toBe('string');
Q9	expect(profile('Стоимость/мес.', ['0', 'по запросу', 'бесплатно'])?.type).toBe('string');
Q9	expect(profile('Часы', ['2', '5'])?.type).toBe('number');
Q9	expect(profile('Дата', ['2026-09-01'])?.type).toBe('string');
Q9	expect(profile('Дата', ['2026-09-01', '2026-09-02'])?.type).toBe('date');
Q9	expect(profile('Часы', ['1', '2', '3', '4', 'около часа'])?.type).toBe('number');
Q9	expect(profile('Часы', ['1', '2', '3', 'x', 'y'])?.type).toBe('string');
Q43	expect(outcome.status).toBe('ok');
Q43	expect(fake.formatWrites).toEqual([
Q43	expect(sheet?.rows[1]?.[4]?.format).toEqual(TASK);
Q43	expect(sheet?.rows[2]?.[0]?.format).toEqual(TASK);
Q43	expect(await listAt(fake, 2)).toEqual(STATUSES);
Q43	expect(await listAt(fake, 3)).toEqual(STATUSES);
Q43	expect(fake.formatWrites.slice(1)).toEqual([
Q43	expect(await listAt(fake, 5)).toEqual(STATUSES);
Q43	expect(preview.status).toBe('preview');
Q43	expect(preview.notes).toContain('оформление и проверка данных строки 2 — как у строки 3');
Q43	expect(fake.formatWrites).toEqual([]);
Q43	expect(outcome.notes).not.toContain('оформление и проверка данных строки 2 — как у строки 3');
Q43	expect(fake.formatWrites).toEqual([
Q43	expect(await listAt(fake, 2)).toBeNull();
Q43	await expect(
Q43	await expect(
Q43	expect(fake.formatWrites).toEqual([]);
Q43	expect(() => parseOperation({ ...base, likeRow })).toThrow();
Q43	expect(parseOperation({ ...base, likeRow: 3 })).toMatchObject({ op: 'insertRows', likeRow: 3 });
Q43	expect(request).toEqual({
Q44	expect(outcome.status).toBe('ok');
Q44	expect(outcome.notes).toContain('оформление строки 5 — как у строки 4, с проверкой данных');
Q44	expect(fake.formatWrites.map((r) => (r.kind === 'copyPaste' ? r.paste : r.kind))).toEqual([
Q44	expect(await listAt(fake, 5)).toEqual(STATUSES);
Q42	expect(preview.data).toMatchObject({ status: 'preview', notes: [] });
Q42	expect(lookPlanOf(preview.data)).toEqual([
F4	expect(written.data).toMatchObject({ status: 'ok' });
F4	expect(await looksOf(client, 4)).toEqual(await looksOf(client, 7));
F4	expect(await valuesOf(client, 4)).toEqual([null, null, null, null, null, null]);
F4	expect(journalled.map((record) => [record.op, record.changes.length])).toEqual([
F4	expect(undone.data).toMatchObject({ status: 'ok' });
F4	expect(await looksOf(client, 4)).toEqual(DAY_LOOK.map((look) => formatKey(look)));
Q42	expect(addressesOf(span.data)).toEqual([
A4	expect(addressesOf(named.data)).toEqual(['Отчёт!A4', 'Отчёт!C4']);
A4	expect((named.data as ApplyOutcome).assumptions).toEqual([
A4	expect(unknown.data).toMatchObject({
Q42	expect(lookPlanOf(preview.data)).toEqual([
C4	expect((preview.data as ApplyOutcome).notes).toEqual([
A4	expect(plain.data).toMatchObject({ status: 'preview', notes: [] });
Q42	expect(result.error).toMatchObject({
Q42	await expect(
Q42	expect(client.formatWrites).toHaveLength(0);
Q42	expect(result.error).toMatchObject({
Q42	expect(journalled).toHaveLength(0);
Q42	expect(lookPlanOf(result.data), `строка ${likeRow}`).toEqual([
C6	expect(result.error).toMatchObject({ code: 'write_blocked', cause: 'formula_column' });
Q42	expect(written.data).toMatchObject({ status: 'ok' });
Q42	expect(g.batches).toEqual([6]);
Q42	expect(b4?.range).toEqual({
Q42	expect(b4?.fields?.split(',').sort()).toEqual([
Q42	expect(b4?.cell).toStrictEqual({
Q42	expect(about).toContain('formatCells: вид как у строки N вместо format');
Q42	expect(about).toContain(
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
Q10	expect(result.data).toMatchObject({ status: 'ok' });
Q10	expect(g.batches).toEqual([3]);
Q10	expect(g.writes).toHaveLength(3);
Q10	expect(result.ok).toBe(false);
Q10	expect(g.batches).toEqual([3]);
Q10	expect(g.writes).toHaveLength(0);
Q10	expect(tool.inputSchema.additionalProperties, tool.name).toBeUndefined();
Q10	expect(gcApply.description).toMatch(/op=setHeader/);
Q10	expect(gcApply.description).toMatch(/op=addSheet с columns и rows/);
L10	expect(text).toContain('strikethrough');
Q13	expect(covered, op).toEqual(Object.keys(shapeOf(op)).sort());
Q13	expect(Object.values(sample).includes(undefined), `${op}: поле без образца`).toBe(false);
Q13	expect(core.success, `${op}: ${core.success ? '' : core.error.message}`).toBe(true);
Q13	expect(() => parseOperation(sample), op).not.toThrow();
Q13	expect(carried.success, `${op}: транспорт отклонил — ${carried.error?.message ?? ''}`).toBe(
Q13	expect(operationOf(carried.data!), op).toEqual(parseOperation(sample));
Q13	expect(policyRules()).toHaveLength(64);
A1	expect(result.error).toBeUndefined();
A1	expect(result.ok).toBe(false);
A1	expect(preview.status).toBe('preview');
A1	expect(preview.changes).toEqual(planned());
A1	expect(preview.planId).toMatch(/^[0-9a-f]{6}$/);
A1	expect(preview.assumptions).toEqual([
A1	expect(preview.notes).toEqual([]);
A1	expect(await grid(client)).toEqual([]);
A1	expect(journalled).toEqual([]);
-	expect(written.status).toBe('ok');
-	expect(written.changes).toEqual(planned());
-	expect(await grid(client)).toEqual([HEADER]);
-	expect(journalled).toHaveLength(1);
-	expect(journalled[0]).toMatchObject({
-	expect(before.status).toBe('needs_clarification');
-	expect(before.questions[0]?.detail).toBe(
-	expect((await outcome(deps, header({ dryRun: false }))).status).toBe('ok');
-	expect(appended.status).toBe('ok');
-	expect(appended.changes.map((change) => change.a1)).toEqual(
-	expect(await grid(client)).toEqual([
-	expect(map).toMatchObject({ headerRow: 1, headerRowConfident: true, dataRowCount: 1 });
-	expect(map.columns.map((column) => `${column.letter} ${column.name}`)).toEqual(
-	expect(map.unlabeled).toBeUndefined();
-	expect(preview.changes).toEqual(planned(2));
-	expect(preview.assumptions).toEqual(['Строка шапки — 2 (строка заголовков задана вызывающим)']);
-	expect(trimmed.changes.map((change) => [change.a1, change.after])).toEqual([
C1	expect(preview.changes.map((change) => change.a1)).toEqual([`${SHEET}!${a1}`]);
A1	expect(before.headerRow).toBe(1);
A1	expect(before.unlabeled?.map((column) => column.key)).toEqual(['(A)']);
G1	expect(plain.changes.map((change) => change.a1)).toEqual([`${SHEET}!G1`]);
G1	expect(plain.notes).toEqual([]);
G1	expect(written.status).toBe('ok');
G1	expect(written.changes).toEqual([
A1	expect(written.assumptions).toEqual(['Строка шапки — 1 (строка 1: 5 подписей, ниже данные)']);
A1	expect(written.notes).toEqual([
A1	expect(map.columns[0]).toMatchObject({ name: 'Дата', letter: 'A', type: 'date' });
A1	expect(map.unlabeled).toBeUndefined();
A1	expect(byName.status).toBe('ok');
A1	expect(byName.changes).toEqual([
A3	expect(byKey.status).toBe('needs_clarification');
A3	expect(byKey.questions[0]).toMatchObject({
A3	expect((await grid(client))[2]?.[0]).toBe('21.10.2026');
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'header_cell_occupied' });
-	expect(error.detail).toBe(
B1	expect(await grid(client)).toEqual(before);
B1	expect(journalled).toEqual([]);
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'header_label_duplicate' });
-	expect(error.detail).toBe(
-	expect(await grid(client)).toEqual([]);
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'header_label_duplicate' });
-	expect(error.detail).toBe(
C1	expect(await grid(client)).toEqual(before);
-	expect(error).toMatchObject({ code: 'bad_request', cause: 'header_label_empty' });
-	expect(error.detail).toBe(
-	expect(await grid(client)).toEqual([]);
A1	expect(error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
A1	expect(client.reads).toBe(0);
A1	expect(error.detail).toBe(
-	expect(error).toMatchObject({ code: 'revision_conflict' });
-	expect(await grid(client)).toEqual([]);
-	expect(asked.status).toBe('confirm_required');
-	expect(asked.changes).toHaveLength(51);
-	expect(asked.changes.at(-1)?.a1).toBe(`${SHEET}!AY1`);
-	expect(asked.notes).toEqual([
-	expect(await grid(client)).toEqual([]);
-	expect(written.status).toBe('ok');
-	expect(await grid(client)).toEqual([labels]);
-	expect(undone.data).toMatchObject({
-	expect(await grid(client)).toEqual([]);
-	expect(journalled.at(-1)).toMatchObject({ op: 'undo', undoOf: journalled[0]?.correlationId });
C1	expect(error).toMatchObject({ code: 'bad_request', cause: 'header_cell_occupied' });
C1	expect(error.detail).toContain(
C1	expect(await grid(client)).toEqual([[null, null, 'Тема']]);
C1	expect(journalled).toEqual([]);
C1	expect(error).toMatchObject({ code: 'stale_value', cause: 'value_changed_after_preview' });
C1	expect(error.detail).toBe(
C1	expect(client.reads).toBe(2);
C1	expect(await grid(client)).toEqual([[null, null, 'Тема']]);
C1	expect(journalled).toEqual([]);
-	expect((await outcome(deps, { op: 'setHeader', columns: labels, dryRun: false })).status).toBe(
-	expect((await outcome(deps, { op: 'appendRow', values, dryRun: false })).status).toBe('ok');
-	expect(stub.bodies).toEqual([
A1	expect(result.error).toBeUndefined();
Q30	expect(map.columns.map((column) => column.name)).toEqual(['Пункт', 'Описание']);
Q30	expect(map.unlabeled).toEqual([{ letter: 'C', index: 2, key: '(C)', filled: 3, rows: '9–11' }]);
Q30	expect(map.warnings).toEqual([unlabeledWarning(SHEET5_FOUND, mapTail('под ключом «(C)»'))]);
Q30	expect(rows.map((record) => record['(C)'])).toEqual(
Q30	expect(rows[7]).toEqual({ Пункт: 'п. 8', Описание: 'описание 8', '(C)': 'а) доступы' });
Q30	expect(data.columns).toEqual(['Пункт', 'Описание']);
Q30	expect(data.warnings).toEqual([unlabeledWarning(SHEET5_FOUND, 'в rows они под ключом «(C)»')]);
Q30	expect(brief).toEqual(unlabeled);
Q30	expect(map.warnings).toContain(unlabeledWarning(found, mapTail(keys)));
Q30	expect(data.rows.value).toEqual([
Q30	expect(await read(sheet, { mode: 'map' })).not.toHaveProperty('unlabeled');
Q30	expect(data.rows.value[49]).toEqual({
Q30	expect(data.warnings).toEqual([
Q30	expect(outcome.status).toBe('ok');
Q30	expect(client.writes.map((write) => write.range)).toEqual(ranges);
Q30	expect(outcome.status).toBe('needs_clarification');
Q30	expect(outcome.questions[0]).toMatchObject({ field, reason: 'no_match' });
Q30	expect(client.writes).toEqual([]);
Q30	expect(client.batches).toEqual([]);
Q7	expect(map).toMatchObject({
Q30	expect(map).not.toHaveProperty('unlabeled');
Q30	expect(map.warnings).toEqual([]);
Q30	expect(data.rows.value.map((record) => Object.keys(record).join())).toEqual(
Q30	expect(data.warnings).toEqual([]);
Q31	expect(buildSheetMap(book({ title: 'Лист', sheetId: 1, rows })).usedRange).toBe(usedRange);
Q31	expect(buildSheetMap(book(sheet5(), checkLog())).otherSheets).toEqual([
Q32	expect(map).not.toHaveProperty('unlabeled');
Q32	expect(map.warnings.filter((w) => w.includes('без подписи'))).toEqual([]);
Q32	for (const record of data.rows.value) expect(Object.keys(record)).toEqual(data.columns);
Q32	expect(data.warnings).toEqual(map.warnings);
Q37	expect(outcome.status).toBe('preview');
Q37	expect(outcome.changes).toEqual([
C9	expect(client.formatWrites).toEqual([]);
Q27	expect(parseTargetUrl(url(BOOK, tail))).toStrictEqual({ id: BOOK, type: 'sheet', gid });
Q27	expect(parseTargetUrl(url(BOOK, tail))).toStrictEqual({ id: BOOK, type: 'sheet' });
Q27	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'sheet_gid_conflict' });
Q27	expect(result.error?.detail).toContain(`gid 1 и ${LOG}`);
Q27	expect(result.error?.detail).toContain('спроси человека');
Q27	expect({ meta, grid }).toEqual({ meta: [], grid: [] });
Q27	expect(resolveTarget(tab(BOOK, LOG), registry)).toMatchObject({ alias: 'checks', gid: LOG });
Q27	expect(resolveTarget('checks', registry)).not.toHaveProperty('gid');
Q27	expect(resolveTarget(BOOK, registry)).not.toHaveProperty('gid');
Q27	expect(result.data).toMatchObject({ sheet, headerRow });
Q27	expect(result.data).toMatchObject({ sheet: 'Лог проверок' });
Q27	expect((result.data as { rows: { value: unknown[] } }).rows.value).toEqual([
Q27	expect(result.data).toMatchObject({ status: 'ok', target: { sheet: 'Лог проверок' } });
Q27	expect(writes).toEqual(ranges);
Q28	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'sheet_gid_mismatch' });
Q28	expect(result.error?.detail).toContain(
Q28	expect(result.error?.detail).toContain('спроси человека');
Q28	expect({ meta, grid, writes }).toEqual({
Q28	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'sheet_gid_unknown' });
Q28	expect(result.error?.detail).toContain(
Q28	expect(result.error?.detail).toContain('спроси человека');
Q28	expect({ grid, writes }).toEqual({ grid: [], writes: [] });
Q29	expect(result.data).toMatchObject(expected);
Q29	expect(meta).toEqual([]);
D2	expect(outcome.status).toBe('ok');
Q33	expect(values(await sheetRows(client))).toEqual([
Q33	expect(values(await sheetRows(client))).toEqual(values([header!, second!, first!, third!]));
A2	expect(journalled[0]?.snapshots?.[0]?.a1Range).toBe(`Лист!A2:${sheet.last}4`);
A2	expect(values(after)).toEqual(values(rows));
Q33	expect(formats(after)).toMatchObject(formats(rows));
A2	expect(journalled[0]?.snapshots?.[0]?.a1Range).toBe(`Лист!A2:${sheet.last}2`);
A2	expect(undone.status).toBe('ok');
A2	expect(values(after)).toEqual(values(rows));
A2	expect(formats(after)).toEqual(formats(rows));
Q35	expect(journalled[0]?.snapshots).toEqual([{ a1Range: range, rows }]);
Q35	expect(client.formatWrites).toEqual([{ kind: 'sortRange', sheetId: 0, range, column: 1 }]);
Q35	expect(g.requests).toEqual([
Q37	expect(outcome.changes).toEqual([
Q37	expect(outcome.changes).toEqual(changes);
C2	expect(journalled[0]?.changes).toContainEqual(change);
C2	expect(values(await sheetRows(client))).toEqual(values([rows[0]!, rows[2]!, rows[3]!]));
C2	expect(undone.status).toBe('ok');
C2	expect(values(after)).toEqual(values(rows));
C2	expect(formats(after)).toEqual(formats(rows));
C2	expect(reverted[0]?.changes).toContainEqual({ ...change, before: null, after: 'а) доступы' });
Q37	expect(outcome.notes).toHaveLength(2);
Q37	expect(outcome.notes[1]).toBe(whole(keys));
Q37	expect(outcome.notes.slice(1)).toEqual(extra);
Q37	expect(outcome.changes).toEqual(plan.changes);
Q37	expect(outcome.notes).toEqual(plan.notes);
Q37	expect(outcome.planId).toBe(plan.planId);
Q37	expect(deleted.changes.map((change) => `${change.a1} ${change.column}`)).toEqual([
D3	expect([sorted.notes.length, moved.notes.length]).toEqual([1, 1]);
-	expect(agentAlive(agent.socket)).toBe(true);
-	"require('node:child_process').spawn('/bin/sh', ['-c', process.env.WATCHDOG, 'sh', " +
-	expect(agentAlive(socket)).toBe(true);
-	expect(direct).toEqual([]);
A1	expect(result.error).toBeUndefined();
A1	expect(preview.status).toBe('preview');
A1	expect(outcome.status).toBe('ok');
Q40	expect(preview.assumptions).toEqual([ASSUMED]);
Q40	expect(preview.changes).toEqual([
A4	expect((await cellAt(client, 4, 0)).value).toBe('Сбор отзывов');
A4	expect(journalled[0]?.changes).toEqual([
A4	expect(undone.data).toMatchObject({
A4	expect(await grid(client)).toEqual(before);
Q40	expect(preview.assumptions).toEqual([ASSUMED]);
Q40	expect(preview.changes).toEqual([
F2	expect((await cellAt(client, 2, 5)).value).toBe('итог');
F2	expect((await callMcp(gcUndo, { target: 'report' }, deps)).data).toMatchObject({
F2	expect(await grid(client)).toEqual(before);
Q40	expect(preview.assumptions).toEqual([ASSUMED]);
Q40	expect(preview.changes.map(({ a1, column, after }) => [a1, column, after])).toEqual([
F7	expect((await grid(client))[6]).toEqual(['21.10.2026', null, null, null, null, 'новый']);
F7	expect(await grid(client)).toEqual(before);
Q40	expect(preview.assumptions).toEqual([ASSUMED]);
Q40	expect(preview.changes.map(({ kind, a1, after }) => [kind, a1, after])).toEqual([
B7	expect((await grid(client))[6]).toEqual(['Новая задача', 'описать шаги']);
B7	expect(await grid(client)).toEqual(before);
Q40	expect(preview.assumptions).toEqual([ASSUMED]);
Q40	expect(preview.changes).toEqual([
A2	expect((await cellAt(client, 2, 0)).format).toEqual({ bold: true });
A2	expect((await callMcp(gcUndo, { target: 'report' }, deps)).data).toMatchObject({
A2	expect((await cellAt(client, 2, 0)).format?.bold ?? false).toBe(false);
Q40	expect(byCondition.assumptions).toEqual([ASSUMED]);
B5	expect(byCondition.changes.map((change) => change.a1)).toEqual(['Отчёт!B5']);
B5	expect(header.changes.map(({ a1, before, after }) => [a1, before, after])).toEqual([
Q40	expect(preview.assumptions).toEqual([ASSUMED]);
Q40	expect(preview.notes).toEqual([]);
Q40	expect(preview.structural).toMatchObject({ kind: 'deleteRows', at: 5, count: 1 });
Q40	expect((await grid(client))[4]).toEqual(['Созвон', 'обсудить план', 'готово', 1]);
Q40	expect(await grid(client)).toEqual(before);
Q40	expect(inserted).toMatchObject({ assumptions: [ASSUMED], notes: [] });
Q40	expect(inserted.structural).toMatchObject({ kind: 'insertRows', at: 5, count: 1 });
Q40	expect(added).toMatchObject({ status: 'preview', assumptions: [], notes: [] });
Q40	expect(moved.assumptions).toEqual([ASSUMED]);
Q40	expect(moved.structural).toMatchObject({ kind: 'moveRows', at: 6, count: 1 });
Q40	expect((await callMcp(gcRead, { target: 'report' }, deps)).data).not.toHaveProperty(
Q40	expect((await cellAt(client, 550, 2)).value).toBe('дубль 18');
Q40	expect(outcome.assumptions).toEqual(['«Суть задач» → колонка «Суть задачи»']);
F6	expect(outcome.changes.map((change) => change.a1)).toEqual(['Отчёт!F6']);
Q40	expect(outcome.status).toBe('needs_clarification');
Q40	expect(outcome.questions[0]).toMatchObject({ field: requested, reason: 'no_match' });
Q40	expect(outcome.questions[0]?.available).toContain('(A)');
Q40	expect(await grid(client)).toEqual(before);
Q40	expect(outcome.questions).toEqual([
Q40	expect(outcome.status).toBe('needs_clarification');
Q40	expect(outcome.questions[0]).toMatchObject({ field: requested, reason: 'no_match' });
Q40	expect(outcome.questions).toMatchObject([
Q40	expect(outcome.questions[0]?.detail).toContain('нет — есть «(C)», «(F)». Ключ');
Q40	expect(outcome.questions).toEqual([
Q40	expect(outcome.status).toBe('needs_clarification');
Q40	expect(outcome.questions[0]).toMatchObject({ field: '(B)', candidates: ['Описание'] });
Q40	expect(outcome.questions[0]?.detail).toContain(
Q40	expect(outcome.questions[0]?.available).toEqual(['Задача', 'Часы']);
Q40	expect(outcome.assumptions).toEqual([
Q40	expect(outcome.changes.map(({ a1, column }) => [a1, column])).toEqual([
Q40	expect(labeled.questions[0]).toMatchObject({ field: 'Метка', reason });
Q40	expect(unlabeled.status).toBe('preview');
A14	expect(unlabeled.changes).toMatchObject([{ a1: 'Отчёт!A14', after: 'почти готово' }]);
Q14	expect(unlabeled.notes).toEqual([
Q40	await expect(
Q40	await expect(
B1	expect(data.unlabeled).toEqual([
B1	expect(data.rows[0]).toEqual({ Задача: 'а', '(A)': 'План' });
B1	expect(buildSheetData(book(dailySheet()), { headerRow: 1 }).unlabeled[0]).toMatchObject({
Q30	expect(map.columns.map((column) => column.name)).toEqual(['Задача']);
Q30	expect(map.sampleRows[0]).toEqual({ Задача: 'а' });
A4	await expect(
A4	expect((await cellAt(client, 4, 0)).value).toBe('Сбор данных и отчёт');
A4	expect(undone.error).toMatchObject({
Q40	expect((await append('21.10.2026')).status).toBe('ok');
Q40	expect(again.status).toBe('no_change');
Q40	expect(again.notes.at(-1)).toContain('Такая строка уже дописана');
Q40	expect((await append('22.10.2026')).status).toBe('ok');
Q40	expect((await grid(client)).slice(6)).toEqual([
Q40	expect(await copied({ '(A)': 'Задача', Статус: 'новая' })).toMatchObject({
Q40	expect(await copied({ Статус: 'новая' })).toMatchObject({
A7	expect(outcome).toMatchObject({ status: 'ok', restored: [{ a1: 'Отчёт!A7', value: null }] });
A7	expect((await cellAt(client, 7, 0)).value).toBeNull();
L26	expect(result.error).toBeUndefined();
-	expect(data.status).toBe('preview');
-	expect(data.planId).toMatch(/^[0-9a-f]{6}$/);
-	expect(data.structural?.anchor).toBe(
-	expect(data.assumptions).toEqual([
-	expect(data.file).toBeUndefined();
-	expect(data.notes).toEqual([]);
-	expect(h.drive.calls).toEqual(['findByName']);
-	expect(h.journalled).toEqual([]);
-	expect(data.status).toBe('ok');
-	expect(data.file).toEqual({
-	expect(h.drive.calls).toEqual(['findByName', 'findByName', 'upload']);
-	expect(data.notes).toEqual([
-	expect(data.hint).toContain(`gc_undo по этой цели (запись ${data.correlationId ?? ''})`);
-	expect(h.revisions()).toBe(0);
-	expect(h.journalled).toHaveLength(1);
-	expect(h.journalled[0]).toMatchObject({
-	expect(data.file?.name).toBe('Инструкция.md');
-	expect(await h.drive.findByName(FOLDER_ID, 'Инструкция.md')).toHaveLength(1);
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
-	expect(result.error?.detail).toContain(`Цель ${SHEET_ID} — ${kind}, а не папка (по ссылке)`);
-	expect(h.vetted).toEqual([]);
-	expect(h.drive.asked).toEqual([]);
-	expect(h.drive.calls).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'create_needs_folder' });
-	expect(result.error?.detail).toContain(`Цель ${SHEET_ID} — таблица «Бюджет», а не папка`);
-	expect(h.drive.calls).toEqual([]);
-	expect(h.journalled).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_name_taken' });
-	expect(result.error?.detail).toContain('появился файл «guide.md»');
-	expect(h.drive.calls).not.toContain('upload');
-	expect(h.journalled).toEqual([]);
-	expect(asked.status).toBe('confirm_required');
-	expect(h.drive.calls).not.toContain('upload');
-	expect(confirmed.status).toBe('ok');
-	expect(auto.status).toBe('ok');
-	expect(h.journalled.map((r) => r.targetId)).toEqual([
-	expect(data.status).toBe('preview');
-	expect(data.structural?.anchor).toBe(
-	expect(data.structural?.confirmPhrase).toBeUndefined();
-	expect(data.hint).toContain('Это план');
-	expect(h.drive.calls).toEqual(['findByName', 'fileInfo']);
-	expect(data.status).toBe('ok');
-	expect(data.file).toEqual({
-	expect(h.drive.calls).toEqual([
-	expect(h.drive.revisionsOf(id).map((r) => [r.id, r.keepForever])).toEqual([
-	expect(await h.drive.findByName(FOLDER_ID, 'sales.mp4')).toHaveLength(1);
-	expect(data.notes[0]).toBe(
-	expect(h.journalled[0]).toMatchObject({
-	expect(data.status).toBe('ok');
-	expect(data.file).toMatchObject({ id, revision: 'r2', previous: { revision: 'r1' } });
-	expect(h.drive.calls).not.toContain('upload');
-	expect(data.status).toBe('needs_clarification');
-	expect(data.planId).toBeNull();
-	expect(question).toMatchObject({ field: 'target', reason: 'ambiguous' });
-	expect(question?.candidates).toEqual([
-	expect(question?.detail).toContain('replace: true и его ID в target');
-	expect(data.hint).toContain('Спроси человека');
-	expect(h.drive.calls).toEqual(['findByName']);
-	expect(h.journalled).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
-	expect(result.error?.detail).toContain(`В папке уже есть «sales.mp4» — ${kind}`);
-	expect(result.error?.detail).toContain('Назови файл иначе (name)');
-	expect(h.drive.calls).toEqual(['findByName', 'fileInfo']);
-	expect(data.status).toBe('no_change');
-	expect(data.planId).toBeNull();
-	expect(data.notes).toEqual([
-	expect(h.drive.calls).toEqual(['findByName', 'fileInfo']);
-	expect(h.journalled).toEqual([]);
-	expect(result.error).toMatchObject({
-	expect(result.error?.detail).toContain('ревизия r1 → r2');
-	expect(h.drive.calls).not.toContain('keepRevision');
-	expect(h.drive.calls).not.toContain('replace');
-	expect(h.drive.revisionsOf(id)).toHaveLength(2);
-	expect(h.journalled).toEqual([]);
-	expect(data.status).toBe('ok');
-	expect(data.file).toMatchObject({ id, revision: 'r2', previous: { revision: 'r1' } });
-	expect(h.drive.calls).toEqual(['fileInfo', 'fileInfo', 'keepRevision', 'replace']);
-	expect(h.journalled[0]).toMatchObject({ targetId: id, structure: { fileId: id } });
-	expect(preview.structural).toMatchObject({
-	expect(preview.hint).toContain('НАЗВАНИЕМ');
-	expect(silent.status).toBe('confirm_required');
-	expect(bare.status).toBe('confirm_required');
-	expect(h.drive.calls).not.toContain('replace');
-	expect(named.status).toBe('ok');
-	expect(named.file).toMatchObject({ id, name: 'sales.mp4', sha256: sha(DRAFT) });
-	expect(h.journalled).toHaveLength(1);
-	expect(data.status).toBe('ok');
-	expect(data.structural?.confirmPhrase).toBeUndefined();
-	expect(data.file).toMatchObject({ id, name: 'sales.mp4', sha256: sha(DRAFT) });
-	expect(named.status).toBe('plan_mismatch');
-	expect(named.planId).not.toBe(preview.planId);
-	expect(h.drive.calls).not.toContain('replace');
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
-	expect(result.error?.detail).toContain(`— ${kind}: ${why}`);
-	expect(h.vetted).toEqual([]);
-	expect(h.drive.calls).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
-	expect(result.error?.detail).toContain(
-	expect(h.drive.calls).toEqual(['fileInfo']);
-	expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_checksum_mismatch' });
-	expect(result.error?.detail).toContain(`у локального «guide.md» — ${short(GUIDE)}`);
-	expect(result.error?.detail).toContain('Загруженное отправлено в корзину — на Диске его нет');
-	expect(h.drive.trashed).toHaveLength(1);
-	expect(await h.drive.findByName(FOLDER_ID, 'guide.md')).toEqual([]);
-	expect(h.journalled).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_checksum_mismatch' });
-	expect(result.error?.detail).toContain(
-	expect(h.drive.calls.slice(-3)).toEqual(['keepRevision', 'replace', 'restoreRevision']);
-	expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
-	expect(h.journalled).toEqual([]);
-	expect(undone.error).toBeUndefined();
-	expect(data.status).toBe('ok');
-	expect(data.structureUndone).toBe(
-	expect(data.notRestored).toBeUndefined();
-	expect(h.drive.trashed).toEqual([written.file?.id]);
-	expect(h.journalled.at(-1)).toMatchObject({ op: 'undo', undoOf: written.correlationId });
-	expect(data.status).toBe('ok');
-	expect(data.structureUndone).toBe(
-	expect(h.drive.revisionsOf(id).map((r) => r.sha256)).toEqual([
-	expect(h.drive.trashed).toEqual([]);
-	expect(second.file).toMatchObject({ id, revision: 'r2', sha256: sha(DRAFT) });
-	expect((back.data as UndoData).status).toBe('ok');
-	expect(gone.error).toBeUndefined();
-	expect((gone.data as UndoData).structureUndone).toContain('«sales.mp4» отправлен в корзину');
-	expect(h.drive.trashed).toEqual([id]);
-	expect((undone.data as UndoData).status).toBe('ok');
-	expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
-	expect(undone.error).toMatchObject({
-	expect(undone.error?.detail).toContain(`Файл «${name}» после нашей записи меняли`);
-	expect(undone.error?.detail).toContain(lose);
-	expect(undone.error?.detail).toContain('Осознанно — откат с force');
-	expect(h.drive.revisionsOf(id)).toHaveLength(before);
-	expect(h.drive.trashed).toEqual([]);
-	expect(data.status).toBe('ok');
-	expect(data.notRestored).toEqual([
-	expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
-	expect(data.status).toBe('ok');
-	expect(data.notes).toContain(
-	expect(result.error).toMatchObject({ code: 'stale_value', cause: 'upload_checksum_mismatch' });
-	expect(result.error?.detail).toContain('у локального «guide.md» — 20,5 КБ');
-	expect(h.drive.trashed).toHaveLength(1);
-	expect(h.journalled).toEqual([]);
-	expect(data.status).toBe('ok');
-	expect(data.notes).toContain(
-	expect(result.error).toMatchObject({
-	expect(result.error?.detail).toContain(
-	expect(result.error?.detail).toContain('удали его руками');
-	expect(h.journalled).toEqual([]);
-	expect((undone.data as UndoData).status).toBe('ok');
-	expect(h.drive.revisionsOf(id).at(-1)?.sha256).toBe(sha(SALES_V1));
-	expect(refused.error).toMatchObject({
-	expect(other.drive.revisionsOf(otherId)).toHaveLength(before);
-	expect(slides.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
-	expect(slides.error?.detail).toContain(
-	expect(folder.error).toMatchObject({ code: 'bad_request', cause: 'upload_not_a_file' });
-	expect(folder.error?.detail).toContain(
-	expect(h.drive.calls).not.toContain('upload');
-	expect(result.error).toMatchObject({
-	expect(result.error?.detail).toContain('CLAUDE_PROJECT_DIR');
-	expect(h.vetted).toEqual([]);
-	expect(h.drive.calls).toEqual([]);
-	expect(h.drive.asked).toEqual([]);
-	expect(result.error?.code).toBe('needs_grant');
-	expect(h.vetted).toEqual([]);
-	expect(h.drive.asked).toEqual([]);
-	expect(h.drive.calls).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'upload_outside_project' });
-	expect(h.drive.calls).toEqual([]);
-	expect(result.error?.code).toBe('internal');
-	expect(result.error?.detail).toContain('Проверка локального файла не подключена');
-	expect(h.drive.calls).toEqual([]);
-	expect(data.status).toBe('preview');
-	expect(data.structural?.anchor).toContain('новый файл «Инструкция.md»');
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'unknown_field' });
-	expect(result.error?.detail).toContain('«locallPath» (возможно, «localPath»)');
-	expect(h.vetted).toEqual([]);
-	expect(h.drive.calls).toEqual([]);
-	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'schema_violation' });
-	expect(h.drive.calls).toEqual([]);
-	expect(file).toEqual({
-	expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
-	expect(await vetLocalFile(project, path)).toEqual(expected);
-	expect(await vetLocalFile(link, 'docs/report.md')).toEqual(expected);
-	expect(await vetLocalFile(link, join(project, 'docs', 'report.md'))).toEqual(expected);
-	expect(await vetLocalFile(project, join(link, 'docs', 'report.md'))).toEqual(expected);
-	expect(file.path).toBe(await realpath(join(project, 'docs', 'report.md')));
-	expect(file.name).toBe('report.md');
-	expect((await vetLocalFile(inner, 'docs/a.md')).name).toBe('a.md');
-	for (const name of NEAR_SECRETS) expect((await vetLocalFile(project, name)).name).toBe(name);
-	expect(file.size).toBe(300_000);
-	expect(file.sha256).toBe(createHash('sha256').update(content).digest('hex'));
-	expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_no_project' });
-	expect(payload.detail).toContain('CLAUDE_PROJECT_DIR пуст или не абсолютный');
-	expect(missing.cause).toBe('upload_no_project');
-	expect(missing.detail).toContain(
-	expect(missing.detail).toContain('берёт только из каталога проекта сессии');
-	expect(missing.detail).toContain('Открой сессию в папке проекта и положи файл в неё');
-	expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_not_found' });
-	expect(payload.detail).toContain(
-	expect(payload.detail).toContain(`или от каталога проекта «${project}»: проверь его`);
-	expect((await refusal('docs/report.md/x')).detail).toContain('(ENOTDIR)');
-	expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_outside_project' });
-	expect(payload.detail).toContain('«../outside/plan.txt» — вне каталога проекта: на Диск');
-	expect(payload.detail).toContain('выкладывает файлы только из проекта сессии');
-	expect(payload.detail).toContain('скажи человеку: положить его в проект решает он');
-	expect(payload.detail).not.toContain(join(base, 'outside'));
-	expect(payload, path).toMatchObject({ code: 'bad_request', cause: 'upload_outside_project' });
-	expect(payload.detail).toContain('«../outside/missing.txt» — вне каталога проекта: на Диск');
-	expect((await refusal(path, link)).cause, path).toBe('upload_not_found');
-	expect(root.cause).toBe('upload_no_project');
-	expect(root.detail).toContain('Каталог проекта сессии — «/», корень диска или домашняя папка');
-	expect((await refusal('notes.txt')).cause).toBe('upload_no_project');
-	expect((await vetLocalFile(project, 'notes.txt')).name).toBe('notes.txt');
-	expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_unreadable' });
-	expect(payload.detail).toContain('Файл «locked.md» не читается (EACCES): права на него');
-	expect(payload.detail).toContain('права на файлы решает он');
-	expect(payload.cause).toBe('upload_outside_project');
-	expect(payload.detail).toContain(`«${path}» — ссылка из каталога проекта наружу`);
-	expect(payload.detail).not.toContain('outside');
-	expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_hidden_path' });
-	expect(payload.detail).toContain(`«${inner}» — скрытый путь («${segment}»): в скрытых`);
-	expect(payload.detail).toContain('настройки, и на Диск G connect их не выкладывает');
-	expect(payload, path).toMatchObject({ code: 'bad_request', cause: 'upload_secret_like' });
-	expect(payload.detail).toContain(
-	expect((await refusal('token.json')).detail).toContain('переименовать файл решает он');
-	expect(payload).toMatchObject({ code: 'bad_request', cause: 'upload_not_file' });
-	expect(payload.detail).toContain(text);
-	expect(payload.detail).toContain('выкладывается только обычный файл');
-	expect(max).toBe(104_857_600);
-	expect(payload).toMatchObject({ code: 'policy_denied', cause: 'upload.max-bytes' });
-	expect(payload.detail).toContain(`Файл «video.mp4» — ${max + 1} байт, предел — ${max} байт`);
-	expect(payload.detail).toContain('выложит его на Диск сам');
-	expect(await locateLocalFile(project, 'exact.mp4')).toEqual({
-	for (const [name, type] of Object.entries(expected)) expect(mimeTypeOf(name), name).toBe(type);
-	for (const name of unknown) expect(mimeTypeOf(name), name).toBe('application/octet-stream');
-	expect((await vetLocalFile(project, 'monkey')).mimeType).toBe('application/octet-stream');
L26	expect(result.error).toBeUndefined();
Q36	expect(names(answer)).toEqual(['проект 8', 'проект 9', 'проект 10', 'проект 11']);
Q36	expect(answer).toMatchObject({ fromRow: 8, toRow: 11, truncated: true, nextFromRow: 13 });
Q36	expect(answer.warnings).toEqual([cut('строка 12 окна пуста и в ответ не вошла')]);
Q36	expect(answer.rows.value).toHaveLength(end.count);
Q36	expect(answer.toRow).toBe(end.toRow);
Q36	if (end.toRow === undefined) expect(answer).not.toHaveProperty('toRow');
Q36	expect(answer).toMatchObject({ truncated: true, nextFromRow: end.nextFromRow });
Q36	expect(answer.warnings).toEqual(warnings);
Q36	expect(answer.rows.value).toHaveLength(count);
Q36	expect(answer.toRow).toBe(toRow);
Q36	expect(answer).toMatchObject({ truncated: false });
Q36	expect(answer).not.toHaveProperty('nextFromRow');
Q36	expect(answer.warnings).toEqual([]);
Q36	expect(gcRead.description).toContain('toRow');
Q38	expect(answer.rows.value).toEqual([EMPTY, EMPTY]);
Q38	expect(answer.formats?.value).toEqual([both, both]);
Q36	expect(answer).toMatchObject({ toRow: 4, truncated: true, nextFromRow: 5 });
Q36	expect(answer.warnings).toEqual([]);
Q38	expect(middle.map((record) => record['Проект'])).toEqual([
Q38	expect(middle[1]).toEqual(EMPTY);
Q38	expect(tail.rows.value).toEqual([middle[1], middle[2]]);
Q38	expect(answer.rows.value).toEqual([EMPTY, EMPTY]);
Q38	expect(answer).toMatchObject({ toRow: 4, truncated: true, nextFromRow: 6 });
Q38	expect(answer.warnings).toEqual([cut('строка 5 окна пуста и в ответ не вошла')]);
Q38	expect(answer.rows.value).toEqual([]);
Q38	expect(answer).not.toHaveProperty('toRow');
Q38	expect(answer).not.toHaveProperty('formats');
Q38	expect(answer).toMatchObject({ truncated: true, nextFromRow: 5 });
Q38	expect(answer.warnings).toEqual([cut('строки 3–4 окна пусты и в ответ не вошли')]);
Q38	expect(answer.rows.value).toEqual(Array.from({ length: count }, () => EMPTY));
Q38	expect(answer.rows.value).toEqual([EMPTY]);
Q38	expect(answer.notes?.value).toEqual([{ Статус: 'заполнить после созвона' }]);
Q38	expect(answer).toMatchObject({ toRow: 3, truncated: true, nextFromRow: 4 });
Q38	expect(answer.warnings).toEqual([]);
Q38	expect(answer.rows.value).toEqual([]);
Q38	expect(answer.warnings).toEqual([cut('строка 3 окна пуста и в ответ не вошла')]);
Q38	expect(answer.rows.value).toEqual([
Q38	expect(answer.formats?.value).toEqual([{}, { '(C)': GREEN }]);
Q38	expect(answer.toRow).toBe(3);
Q30	expect((await read(sheet, { fromRow: 3, limit: 1, withFormat: true })).rows.value).toEqual([]);
A1	expect(window.rows).toEqual(rows.slice(1, 4));
A1	expect(window.gridRows).toBe(5);
```

Привязаны к примерам: **A1 A14 A2 A3 A4 A7 B1 B2 B3 B4 B5 B7 B8 C1 C2 C3 C4 C550 C6 C9 D2 D3 F1 F2 F4 F6 F7 G1 K3 L10 L11 L22 L26 L7 Q1 Q10 Q11 Q12 Q13 Q14 Q15 Q16 Q17 Q18 Q19 Q2 Q20 Q21 Q22 Q23 Q24 Q25 Q26 Q27 Q28 Q29 Q3 Q30 Q31 Q32 Q33 Q35 Q36 Q37 Q38 Q39 Q4 Q40 Q41 Q42 Q43 Q44 Q5 Q6 Q7 Q8 Q9 U1 X1 X7**. Остальные 453 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 453

## Ревью ожиданий

- **asserts_reviewed_by:** human:anton at=2026-11-11 (слово владельца в сессии: ответ «Подписываю» на вопрос с
  вариантами — в вопросе названы 1387 новых проверок, 934 привязанных к примерам спеки и 453 непривязанных
  (статусы и коды плана превью, отказы, тексты ответов, запросы к фейку Google) и путь к полному списку;
  дайджест выше — тот же, база `main`)
