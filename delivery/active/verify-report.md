# Verify — G connect из любого проекта (разрешение касанием)

Ветка `feat/cross-project`, база `main` (e9b664a). Слайсы 1–6 сделаны и закоммичены;
слайс 7 (живой прогон X1–X12) ждёт владельца — `live-run.md`.

## Живой прогон 2026-10-17 (слайс 7, T13)

Владелец поручил пройти шаги без него («обойдитесь сами»), кроме пальца. Соседний проект —
Prepare: X1–X2 — НОВАЯ сессия Claude Code в `~/Documents/Prepare` без интерфейса
(`claude -p`), остальное — стабильная сборка от имени Prepare (`gc_call.mjs`,
`GC_SERVER`, `CLAUDE_PROJECT_DIR`), ключ подписи — `irreversible` (выбор владельца).

| # | Пример | Что увидели |
|---|---|---|
| 1 | X1 | сессия в Prepare сама нашла `mcp__g-connect__*`, `permission_denials: []`; `gc_targets` → «G connect не открыт… попроси владельца сказать „открой G connect“» |
| 2 | X2 | `gc_apply` в таблицу владельца → `needs_grant / no_grant`, записей ноль |
| 3 | X3 | палец владельца — `granted` до 23:59:59 за ~3 с (окно Touch ID было: подпись без касания шла бы доли секунды) |
| 4 | X7 | **дефект** — таблица создана, а вызов упал `not_found`: контур читал ревизию папки как таблицы, строки журнала нет (сирота). Починено (`revisionAfterWrite`, `revisionOf`), сирота — в корзину; повтор — `ok`, журнал с `project: Prepare`, B2 — `stringValue «2025-06-01»` (RAW) |
| 5 | X8 | `upsertRow` с первой фразы, B2 `2025-06-01 → 2025-07-01` |
| 6 | X9 | без фразы — `confirm_required`, просит «удаляю строку x.com»; с фразой и кодом — удалено, откат вернул строку со значениями и видом. **Фразу подставил агент по поручению владельца — проверена механика, не подпись (урок L15)** |
| 7 | X10 | откат записи Prepare из «Ahrefs cases» — отказ, но `needs_grant` (у второго проекта нет разрешения): до проверки «чужой проект» запрос не дошёл; её судят тесты через протокол и проба `undo.own-project` |
| 8 | X12 | **дефект** — в репозитории G connect действовала стабильная сборка: неодобренная проектная `.mcp.json` уступает пользовательской. Починено: `connect_claude.sh` ставит запись области local на `dist/` репозитория; `claude mcp get` в репозитории — Local → `dist/`, в Prepare — User → стабильная |
| 9 | — | **дефект** — откат создания в «Мой диск» упал `not_found` тем же классом (ревизия папки). Починено; повтор после второго касания — файл в корзине Drive |
| 10 | — | отзыв — `revoked`, запись снова `needs_grant`, файлов разрешений 0; тестовая таблица — в корзине |

Ещё по ходу: `claude mcp add` объявляет `--env` вариадическим — имя сервера после него
уходило в переменные; фейк в тесте этого не видел (L23), поймал живой запуск. Замечено:
`upsertRow` пишет «как набрал бы человек» — `2025-07-01` стала датой (45839); режим
«текстом» есть только у создания таблицы — кандидат.

Три из четырёх дефектов живого прогона — один класс: фейк шва (ревизия, CLI) согласен
сам с собой, а живой Google и живой `claude` — нет. Каждый закрыт оракулом через протокол с
обратным прогоном.

## Оракулы по примерам спеки

| Пример | Где судится | Чем |
|---|---|---|
| X1 | `tests/mcp-grant-tool.test.ts`, `tests/connect-claude.test.ts` | право проекта в `gc_targets`; подключение ставит `mcp__g-connect__*` без дублей |
| X2 | `tests/mcp-grant-write.test.ts`, проба `write.grant` | вне реестра без разрешения — `needs_grant` с действием, записей ноль |
| X3 | `tests/grant.test.ts`, `tests/mcp-grant-tool.test.ts` | выдача, отказ касания, ключа нет; второй `open` палец не просит |
| X4 | `tests/grant.test.ts`, проба `grant.signature` | без подписи, мусор, чужой ключ, правка после подписи, другое пространство |
| X5, X6 | `tests/grant.test.ts`, `tests/mcp-grant-write.test.ts` | чужой проект и переложенный файл; после 23:59:59 — «истекло <время>» |
| X7 | `tests/mcp-grant-write.test.ts` | таблица в «Моём диске», шапка и строка RAW, код плана меняется с содержимым, откат в корзину |
| X8, X9 | `tests/mcp-grant-write.test.ts` | первой фразой под разрешением; разрушающее — план и фраза |
| X10 | `tests/mcp-grant-write.test.ts`, проба `undo.own-project` | чужая запись по id — отказ; «своих нет» — причина, а не «журнал пуст» |
| X11 | `eval-smoke.md` | установка из коммита, обратный прогон красной пробой, откат |
| X12 | `eval-smoke.md` | механизм — приоритет областей Claude Code; живьём — слайс 7 |

Сьют: **664** теста (+59 за поставку), 47 файлов; `probe_mcp` — семь инструментов и три
действия `gc_grant` в схеме транспорта.

## Обратные прогоны (уроки L7, L22)

Каждый — правка механизма в обратную сторону, оракул обязан покраснеть; все покраснели:

- проверка подписи «всегда верна» — 6 красных (`grant.test.ts`); без проверки срока — X6;
- без проверки read-only реестра — 2; откат видит чужие записи — 1; чужая запись по id
  откатывается — 2; журнал без проекта — 5; без конверта под разрешением — 5;
- второй `open` просит палец — 1;
- запись содержимого не RAW — 1; содержимое не в коде плана — 1; конверт не видит
  ячейки создания — 1;
- фильтр маски мутационного гейта выключен — 2 (`mutation-scope.test.ts`, накат контура);
- стабильная сборка из коммита со сломанными правилами — «проба красная — переключения
  не было», стабильная осталась прежней.

## Что гейты отклонили по ходу — и почему были правы

- **Сложность (×4):** `currentGrant` (11), `cmdGrant` (13), `createFile` (14), `runCreate`
  (14). Каждый раз деление по смыслу, а не по длине: «файл и подпись» против «содержимого»
  у разрешения — порядок «подпись раньше содержимого» стал структурой кода; «вход
  создания» против «плана» и «сообщений после записи».
- **Детектор §3.4a** (`rglob` мимо `.gitignore`) нашёл «отправку наружу» в копии скриптов
  контура внутри `.stable/` — ложное, но оно показало, что сборке не место в репозитории:
  перенесена в `~/Library/Application Support/g-connect/` (decisions.md). Находка — в Prepare.
- **Prettier** — форматирование нового теста; переформатировано, без `--no-verify`.

## Мутационный прогон по изменённым файлам ядра

Прогон 2026-10-17 канонным гейтом с поправкой (BASE=main, бюджет 3000 с, локально): в маске
`stryker.config.json` — **14 файлов** ядра (вне маски отброшены `env.ts`, адаптеры Google,
типы, каталог ошибок и весь `src/mcp/`, `src/cli/`), **1591 мутант, убито 1114 — 70%**
при пороге 60 — OK. В CI тот же гейт идёт четырьмя долями.

**CI PR #4 (2026-10-17) — доля 1/4 красная: убито 163 из 273, 59% при пороге 60.** Доля
судит СВОИ файлы, а не сумму: в 1/4 по алфавиту легли `create-op.ts` (54%), `secretive.ts`
и `plan.ts`, и слабый файл утянул её под порог, хотя сумма по 14 файлам — 70%. Локальный
прогон без доли этого не предсказывал (урок L31). Порог не трогал: у `create-op.ts` не были
проверены отказ сверх бюджета ячеек, пустое имя, «корзина тоже не приняла»
(`write_outcome_unknown`), `asText: false` и точный текст превью и ответа — дописаны тесты
(`mcp-grant-write.test.ts`), мёртвый `mimeOf` удалён. Перепрогон доли 1/4 локально:
**убито 207 из 272 — 76%** (`create-op.ts` — 77%); доли 2–4 на CI — 71%, 74%, 70%.
Остаток выживших `create-op.ts` — эквивалентные (`?? 'root'` при parentId от фасада, пустые
массивы заготовки, ветки `undefined` у ссылки созданного) и тексты причин; у
`secretive.ts` — нормализация имени ключа и разбор строки агента: их естественное место —
следующая поставка «токен под пальцем», она этот файл и меняет.

## Исполнение рисковых путей

`runtime_paths`: `src/core/grant*.ts`, `scripts/install_stable.sh`, `scripts/connect_claude.sh`.

- **Прогнал** `install_stable.sh` на настоящей машине: сборка `main` за 16 с, проба
  собранного сервера зелёная дважды (после сборки и после `npm prune --omit=dev`);
  обратный прогон — коммит со сломанными правилами отклонён, стабильная не тронута; откат
  и возврат. **Увидел** в стабильной сборке ни одного файла рабочей ветки. at=2026-10-17
- **Прогнал** подпись и проверку настоящим `/usr/bin/ssh-keygen` и подпись через НАСТОЯЩИЙ
  `ssh-agent` с ключом под комментарием в формате Secretive; **увидел** разрешение,
  принятое ключом агента, и отказ по ключу с другим именем. at=2026-10-17
- **Прогнал** `connect_claude.sh` в режиме показа на настоящих конфигах: правила
  `mcp__g-connect__*` и памятки нет, сервер — стабильная сборка. **На настоящих конфигах
  `--apply` НЕ запускался**: по спеке это шаг установки со словом владельца. at=2026-10-17
- **Прогнал** живьём (раздел «Живой прогон»): окно Touch ID из дочернего процесса сервера
  через агента Secretive — работает (палец, ~3 с); новая сессия в соседнем проекте — видит
  инструменты без запроса прав; `connect_claude.sh --apply` на настоящих конфигах — по слову
  владельца, с копиями в `~/.claude/backups/`. at=2026-10-17

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md`, `rules.json` и схемы инструментов (`src/mcp/apply-schema.ts`,
`src/mcp/grant-tool.ts`) — то, что уходит агенту как `instructions`, `policy://rules` и
`tools/list`.

1. **Право записи переписано:** «право даёт только реестр» стало неправдой и заменено на
   «реестр или разрешение проекта; read-only реестра не открывается разрешением»;
   добавлено, когда звать `gc_grant open` и когда нет («только по просьбе владельца»).
2. **Конверт под разрешением** — те же границы, что конверт по умолчанию; свой конверт цели
   сильнее; разрушающее — фразой.
3. **Создание** — и в «Мой диск»; таблица сразу со шапкой и строками, RAW по умолчанию.
4. **Откат** — только записи своего проекта.
5. **Три новых правила** (`write.grant`, `grant.signature`, `undo.own-project`) с пробами;
   `write.allowlist` переформулирован; оракул «у каждого правила есть проба — и наоборот»
   судит связь. **Седьмой инструмент** в `tools/list` — `gc_grant` с тремя действиями.

Прогнал `npm run build` и `probe_mcp`: семь инструментов, действия `gc_grant` в схеме, 46
правил в `dist/policy`. at=2026-10-17

## Ревью рисковых мест (§12.5)

- **Разрешение — граница согласия, а не изоляция.** Сервер не может проверить, из какого
  проекта пришёл запрос: агент с Bash может поднять сервер с чужим `CLAUDE_PROJECT_DIR`
  (и воспользоваться чужим разрешением) или пойти в Google токеном из `~/.gconnect` напрямую
  — владелец 2026-10-13 считает прямую работу нормой. Разрешение защищает от записи без
  согласия у агента, который работает через G connect, и от записи мимо превью, журнала и
  отката, — а не от злонамеренного процесса того же пользователя ОС. Названо, не скрыто.
  **Решение владельца 2026-10-17:** закрыть следующей поставкой «токен под пальцем» — токен
  Google шифруется ключом Secure Enclave (`age-plugin-se`), расшифровка только по Touch ID,
  рабочий токен живёт в памяти сервера; цена принята: соседние сессии больше не берут
  токен напрямую, касание — на первое обращение сессии к Google и раз в час.
- **Подделка разрешения.** Подложенный файл — отказ: подпись проверяется ключом, который
  отдаёт агент Secretive, раньше содержимого. Подменённый «ssh-keygen» в PATH — не
  исполняется: пути `/usr/bin/…`. Подставленный `SSH_AUTH_SOCK` — не читается: сокет —
  контейнер Secretive. Остаток: процесс того же пользователя теоретически подменит сокет в
  контейнере — от этого защищает платформа (доступ к данным чужого приложения), не мы.
- **Рефлекс касания.** Агент может вызвать окно Touch ID без просьбы — защита: палец,
  правило в `rules.md` и описании инструмента, второй `open` при действующем разрешении
  палец не просит. Канон замерял четыре касания подряд без знания о подписываемом —
  поэтому живой прогон X3 проверяет и то, как выглядит окно.
- **Read-only реестра под разрешением** — не пишется (решение агента, decisions.md).
- **Деньги** — риска нет, потому что поставка ничего не тратит: «бюджет» в диффе — бюджет
  ячеек одной правки (`write.max-changes`) и время мутационного прогона (`BUDGET_SEC`).
- **Транзакция БД** — базы нет; `src/core/sheets/commit.ts` — запись в Google Sheets через
  контур плана, а атомарности между вызовами Google не бывает. Поэтому создание таблицы со
  шапкой — два вызова, и сбой второго отправляет файл в корзину (`writeContent`), чтобы не
  осталось сироты без строки журнала.
- **Производительность** — разрешение спрашивается лениво (`authorizeWrite`): запись в цель
  реестра к агенту Secretive не ходит; проверенная подпись кэшируется процессом, а
  `ssh-add -L` на проверку — около 10 мс.

## Непокрытое, названное вслух

- X10 живьём дошёл до `needs_grant`, а не до «чужой проект»: второй проект без разрешения; проверку проекта судят тесты.
- X9 живьём: фраза — агента по поручению владельца (механика, не подпись, L15).
- X4 живьём (подложить файл в настоящий `~/.gconnect`) и X6 живьём (ждать полуночи) — тестами.
- Desktop-приложение (вкладка Code) берёт запись уровня пользователя раньше проектной —
  внутри репозитория там окажется стабильная сборка (документация Claude Code).
- Покрытие изменённого кода — порога нет (STACK-ACCEPTANCE, остатки).

## Assertion digest (ревью ожиданий, не кода)

База: `origin/main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **136**, из них без ссылки на пример спеки:
**87**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
-	expect(out).toContain('ничего не пишу');
-	expect(out).toContain('mcp__g-connect__* — нет');
-	expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
-	await expect(readFile(claudeLog, 'utf8')).rejects.toThrow();
-	expect(calls[0]).toBe('mcp remove g-connect --scope user');
-	expect(calls[1]).toMatch(
-	expect(s.permissions.allow).toEqual(['Bash(ls)', 'mcp__g-connect__*']);
-	expect((s as unknown as { model: string }).model).toBe('opus');
-	expect(memo).toContain('открой G connect');
-	expect(await readdir(join(home, '.claude', 'backups'))).toHaveLength(1);
-	expect(
-	expect(memo.match(/g-connect:begin/g)).toHaveLength(1);
-	expect(memo.startsWith('# Мои правила\n\nНе трогать.\n')).toBe(true);
-	expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
-	expect(memo).toBe('# Мои правила\n');
-	expect((await readFile(claudeLog, 'utf8')).trim().split('\n').at(-1)).toBe(
-	expect(() => run('--apply')).toThrow(/стабильной сборки нет/);
-	expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
-	fc.assert(
-	expect(parseGrantText(grantText(grant))).toEqual(grant);
-	expect(new Date(Date.parse(doc.expires))).toEqual(endOfLocalDay(NOON));
-	expect(new Date(Date.parse(late.expires))).toEqual(new Date(2026, 9, 18, 23, 59, 59));
-	expect(parseGrantText(grantText(late))).toEqual(late);
-	for (const variant of variants) expect(parseGrantText(variant)).toBeUndefined();
-	expect(state).toEqual({ state: 'granted', grant });
-	expect((await stat(file)).mode & 0o777).toBe(0o600);
-	expect((await stat(grantsDir())).mode & 0o777).toBe(0o700);
-	expect(await readFile(file, 'utf8')).not.toContain('token');
-	await expect(issueGrant(declining, PROJECT_A, 'default', NOON)).rejects.toMatchObject({
-	expect((await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).state).toBe('none');
-	await expect(issueGrant(forging, PROJECT_A, 'default', NOON)).rejects.toBeInstanceOf(GcError);
-	expect((await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).state).toBe('none');
-	await expect(issueGrant(noKey(owner), PROJECT_A, 'default', NOON)).rejects.toMatchObject({
-	expect(await currentGrant(noKey(owner), PROJECT_A, 'default', NOON)).toMatchObject({
-	expect(await revokeGrant(PROJECT_A)).toBe(true);
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
-	expect(await revokeGrant(PROJECT_A)).toBe(false);
-	expect(await currentGrant(fileKeys(owner), undefined, 'default', NOON)).toMatchObject({
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
X5	expect(await currentGrant(fileKeys(owner), PROJECT_B, 'default', NOON)).toMatchObject({
X5	expect(await currentGrant(fileKeys(owner), PROJECT_B, 'default', NOON)).toMatchObject({
-	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toMatchObject({
X6	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', midnight)).toEqual({
X6	expect((await currentGrant(fileKeys(owner), PROJECT_A, 'default', lastSecond)).state).toBe(
-	expect(listing).toHaveLength(3);
-	expect(listing).toEqual(
-	expect(agentKeyName('ecdsa-sha2-nistp256 AAAA irreversible@secretive.MacBook-Air.local')).toBe(
-	expect(agentKeyName('ssh-ed25519 AAAA evil@elsewhere')).toBeUndefined();
-	expect(keyNameKey('G connect')).toBe(keyNameKey('g-connect'));
-	expect(await keys.signerKey()).toBe(owner.pub);
-	expect(await currentGrant(keys, PROJECT_A, 'default', NOON)).toEqual({
-	await expect(
-	expect(data.grant).toMatchObject({ project: PROJECT, state: 'no_grant' });
-	expect(data.grant.detail).toContain('открой G connect');
-	expect(data.grant.state).toBe('granted');
T23	expect(data.grant.expires).toMatch(/T23:59:59[+-]\d\d:\d\d$/);
-	expect(result.data).toMatchObject({ status: 'granted', project: PROJECT });
-	expect(String((result.data as { hint: string }).hint)).toContain('до ');
-	expect(touches).toBe(1);
-	expect(again.data).toMatchObject({ status: 'already_granted', state: 'granted' });
-	expect(touches).toBe(1);
-	expect(result.error).toMatchObject({ code: 'grant_declined' });
-	expect(status.data).toMatchObject({ status: 'status', state: 'no_grant' });
-	expect((await callMcp(gcGrant, { action: 'revoke' }, deps())).data).toMatchObject({
-	expect((await callMcp(gcGrant, { action: 'revoke' }, deps())).data).toMatchObject({
-	expect((await callMcp(gcGrant, {}, deps())).data).toMatchObject({ state: 'no_grant' });
-	expect(result.error).toMatchObject({ code: 'needs_grant', cause: 'no_project' });
-	expect(touches).toBe(0);
-	expect(result.error?.code).toBe('bad_request');
-	expect(touches).toBe(0);
X8	expect(result.ok).toBe(true);
X8	expect((result.data as { status: string }).status).toBe('ok');
X8	expect(client.writes.length).toBeGreaterThan(0);
X8	expect(journalled).toHaveLength(1);
X8	expect(journalled[0]?.project).toBe(PROJECT);
X2	expect(result.error).toMatchObject({ code: 'needs_grant', cause: 'no_grant' });
X2	expect(result.error?.action?.kind).toBe('open_grant');
X2	expect(client.writes).toHaveLength(0);
X5	expect(other.error).toMatchObject({ code: 'needs_grant', cause: 'other_project' });
X5	expect(expired.error).toMatchObject({ code: 'needs_grant', cause: 'expired' });
X5	expect(expired.error?.detail).toContain('истекло 2026-10-17T23:59:59+03:00');
-	expect(result.error).toMatchObject({ code: 'policy_denied', cause: 'write.allowlist' });
-	expect(client.writes).toHaveLength(0);
-	expect(result.error?.code).not.toBe('needs_grant');
-	expect(grantCalls()).toBe(0);
-	expect((result.data as { status: string }).status).toBe('confirm_required');
-	expect(client.writes).toHaveLength(0);
X9	expect(data.status).toBe('confirm_required');
X9	expect(data.structural?.confirmPhrase).toContain('удаляю');
X9	expect(client.writes).toHaveLength(0);
-	expect(created.ok).toBe(true);
-	expect(drive.created).toEqual([
-	expect(journalled[0]?.project).toBe(PROJECT);
-	expect((write.data as { status: string }).status).toBe('ok');
-	expect(result.error?.code).toBe('needs_grant');
-	expect(drive.created).toHaveLength(0);
X7	expect(preview.notes).toEqual(
X7	expect(other.planId).not.toBe(preview.planId);
X7	expect(drive.created).toHaveLength(0);
X7	expect((result.data as { status: string }).status).toBe('ok');
X7	expect(drive.created[0]).toMatchObject({ name: 'Тест G connect', parentId: 'root' });
X7	expect(client.writes).toEqual([
A1	expect(notes).toContain('https://drive.google.com/open?id=FILE1');
A1	expect(notes).toContain('пишется сразу');
A1	expect((undone.data as { status: string }).status).toBe('ok');
A1	expect(drive.trashed).toEqual(['FILE1']);
A1	expect(journalled.at(-1)).toMatchObject({ op: 'undo', project: PROJECT });
X7	expect(result.ok).toBe(false);
X7	expect(drive.trashed).toEqual(['FILE1']);
X7	expect(journalled).toHaveLength(0);
X7	expect(result.error).toMatchObject({ code: 'bad_request', cause: 'row_wider_than_header' });
X7	expect(drive.created).toHaveLength(0);
X7	expect((result.data as { status: string }).status).toBe('confirm_required');
X7	expect(drive.created).toHaveLength(0);
X10	expect(journalled[0]?.project).toBe(OTHER);
-	expect(result.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-project' });
-	expect(result.error?.detail).toContain(OTHER);
-	expect(result.data).toMatchObject({ status: 'nothing_to_undo', reason: 'only_other_projects' });
-	expect(result.error).toBeUndefined();
-	expect((result.data as { status: string }).status).toBe('ok');
-	expect(journalled.at(-1)).toMatchObject({ op: 'undo', project: OTHER });
L10	expect(result.error?.code).toBe('needs_grant');
L10	expect(result.error?.action?.kind).toBe('open_grant');
L10	expect(result.error?.detail).toContain('открой G connect');
L10	expect(result.error?.code).toBe('needs_grant');
G16	expect(result.error?.code).toBe('needs_grant');
G16	await expect(authorizeWrite(readOnly, () => Promise.resolve(GRANTED))).rejects.toMatchObject({
G16	await expect(authorizeWrite(unlisted, () => Promise.resolve(none))).rejects.toMatchObject({
G16	expect(await authorizeWrite(unlisted, () => Promise.resolve(GRANTED))).toMatchObject({
G16	expect(await currentGrant(keys, project, 'default')).toMatchObject({
B2	await expect(
B2	expect(policyRules()).toHaveLength(46);
```

Привязаны к примерам: **A1 B2 G16 L10 T23 X10 X2 X5 X6 X7 X8 X9**. Остальные 87 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 87

## Ревью ожиданий

- **asserts_reviewed_by:** human:anton at=2026-10-17 (слово владельца в сессии: ответ
  «Подписываю» на вопрос с вариантами; ожидания выведены из примеров X1–X12 подписанной
  спеки и поведения настоящего `ssh-keygen`; непривязанные в дайджесте — структурные:
  форма ответа, тексты отказов, «превью не пишет»)
