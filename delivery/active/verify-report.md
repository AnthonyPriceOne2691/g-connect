# Verify report — два профиля рядом (D-25)

Статус: **код готов, живой прогон пройден 2026-10-19** (`live-run.md`, «Результат»). Мерж —
словом владельца, через `merge_guard`.

## Оракулы по примерам

| id | Чем судится | Где |
|---|---|---|
| W1 | по серверу на профиль: user и local, правило на каждый, ключ `irreversible` у обоих | `tests/connect-claude.test.ts`; живьём — шаги 1–2 |
| W2 | профиль — первой строкой инструкций и в `gc_targets`; о другом — только имя сервера | `tests/mcp-profile.test.ts` (протокол); проба собранного сервера; живьём — шаг 4 |
| W3 | `google_locked` со строкой своего профиля; касание открывает только свой | `tests/mcp-profile.test.ts`; живьём — шаг 5 |
| W4 | разрешение второго профиля не трогает первое, отзыв — тоже; фраза своего профиля | `tests/grant.test.ts`, `tests/mcp-profile.test.ts`; живьём — шаг 6 |
| W5 | рабочий сервер не откатывает запись личного — называет его сервер; по id — отказ правилом | `tests/mcp-profile.test.ts` (протокол), проба `undo.own-profile` |
| W6 | файл прежней раскладки не открывает запись никому | `tests/grant.test.ts`, проба `grant.per-profile` |
| W7 | профиль без входа — сервер поднят, `gc_targets` называет шаг владельца | `tests/mcp-profile.test.ts` |
| W8 | отключение снимает оба сервера (user и local), оба правила и памятку | `tests/connect-claude.test.ts` |
| W9 | памятка называет оба сервера и правило выбора, без адресов и названий файлов | `tests/connect-claude.test.ts`; живьём — шаг 3 |
| W10 | у личного — имя, строка, фраза, команда и памятка слово в слово как до D-25 | `tests/mcp-profile.test.ts`, `tests/connect-claude.test.ts` (6 прежних тестов скрипта — зелёные без правки) |

## Обратные прогоны (каждый — красный на своём тесте, 2026-10-19)

- Откат без фильтра профиля (`ownRecords` пропускает чужой аккаунт) → W5 красный.
- Разрешения в общем каталоге (`grantsDir` без профиля) → W4 красный.
- Строка личного профиля в отказе `google_locked` у рабочего сервера → W3 красный.
- Профиль не первой строкой инструкций, а после правил → W2 красный.
- Скрипт регистрирует один `g-connect` на все профили → W1 красный.

## Мутации — теми же долями, что CI (L31)

Локально 2026-10-19, `MIN_KILLED=60`, база `main`: доля 1/4 — 118 из 167 (70%), 2/4 — 42 из 49
(85%), 3/4 — 91 из 104 (87%), 4/4 — 144 из 192 (75%). Судятся шесть файлов ядра; слой MCP
(`src/mcp/*`) и CLI вне маски Stryker — их судят тесты через протокол.

## Найдено по дороге

- **Инструкции сервера доходят до агента не целиком.** В сессии Claude Code агенту видны
  ~5 тыс. знаков из 23 тыс.; раздел «Про доступ» (D-24) — за обрезкой. Отчёт token-touch
  утверждал, что правило касания доходит инструкциями, — на деле описанием `gc_unlock`,
  ответом `google_locked` и памяткой. Отсюда профиль — первой строкой инструкций.
- **bash 3.2 в UTF-8 читал байты `»` как часть имени переменной**: `«$profile»` падал
  «unbound variable» раньше понятного отказа. Нашёл тест опечатки в списке профилей;
  починено фигурными скобками, в других скриптах репозитория таких мест нет.
- **id P1…P22 заняты** тестами поставки про документы — примеры переименованы в W до кода,
  с подтверждением владельца (L8).
- **Оракул B2 поймал путь к профилю** в подсказке `gc_targets` («положи файл в
  ~/.gconnect/work/») — убран: каталог с токенами агенту читать незачем.
- **`tools.ts` — 499 строк из 500**: `gc_targets` вынесен в `targets-tool.ts` (L20).

## Живой прогон

Пройден 2026-10-19: W1, W2, W3, W4, W9 — живьём, касания (Touch ID — рабочий Google, Secretive
— разрешение) и слова владельца; W5–W8, W10 — тестами. Найдена и починена одна вещь —
подсказка показа без списка профилей.

## Исполнение рисковых путей

`runtime_paths`: `scripts/connect_claude.sh`, `src/core/grant/grants.ts`.

- **Прогнал** `connect_claude.sh --profiles=default,work` — показ, затем `--apply` на
  настоящих конфигах по слову владельца. **Увидел**: два сервера на стабильной сборке и
  `Connected` вне репозитория, `g-connect-work` на dev `dist/` в репозитории, правила обоих,
  один блок памятки без адресов; копия в `~/.claude/backups/`. at=2026-10-19
- **Прогнал** `gc_grant open` у рабочего сервера стабильной сборки (касание Secretive) и
  `gc_targets` личного в том же проекте, затем `revoke`. **Увидел**: разрешение рабочего до
  23:59, у личного `no_grant` до и после, после отзыва файлов разрешений 0 — в каталоге
  `grants/work/`, общий каталог пуст. at=2026-10-19
- CI PR #7 на `9af6b66`: quality и четыре доли зелёные (70 · 85 · 87 · 75), 53 файла тестов.
  at=2026-10-19

## Риски и непокрытое

- Подключение — по явному списку. Сервер профиля, выпавшего из списка, остаётся
  подключённым: показ без `--apply` называет его правило «лишним», снять — отключить всё.
- Агент, выбравший не тот сервер, ходит токеном не того аккаунта: чтение чужого файла
  отказом Google, запись — через превью, код плана и разрешение своего профиля. Правило
  выбора — в памятке и первой строке инструкций, а не механизм.
- Две сессии одного профиля по-прежнему делят журнал и разрешение проекта (как до D-25).

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md`, `src/policy/rules.json`, инструкции сервера
(`serverInstructions`), `gc_targets`, описания `gc_unlock` и `gc_grant` — то, что уходит агенту
как `instructions`, `policy://rules`, `tools/list` и ответы.

1. **Первая строка инструкций** называет профиль сервера и говорит: другие профили — свои
   серверы, чей файл не знаешь — спроси человека.
2. **`gc_targets`** отдаёт `profile` (свой: имя, сервер, состояние, шаг владельца) и
   `otherProfiles` (только имена серверов) вместо списка `accounts` со статусами всех.
3. **Строка перед окном и фраза разрешения** — своего профиля: «G connect (work) попросит
   палец…», «открой G connect (work)»; у личного — прежние слово в слово. Строка теперь и в
   самом отказе `google_locked`.
4. **Откат** отвечает `only_other_profiles` с именем сервера, названная по id чужая запись —
   отказ `undo.own-profile`.
5. **Два новых правила** с пробами — `grant.per-profile`, `undo.own-profile` (правил 50);
   раздел «Профили» в `rules.md`.
6. **Памятка** вне репозитория (`connect_claude_edit.py`): с одним личным профилем — слово
   в слово прежняя, с несколькими — серверы и правило выбора.

По файлам: `src/mcp/tools.ts` — первая строка инструкций (`serverInstructions(account)`) и
переезд `gc_targets` в `targets-tool.ts`, поведение остальных инструментов не изменено;
`src/mcp/unlock-tool.ts` — строка своего профиля в `gc_targets.google` и описание `gc_unlock`
с обеими формами строки; `src/mcp/grant-tool.ts` — фраза своего профиля в отказе, сводке и
подсказке, описание `open` с обеими формами фразы, отзыв — своего профиля.

Прогнал `npm run build` и `probe_mcp`: восемь инструментов, «instructions начинаются с
профиля сервера», 50 правил в `dist/policy`. at=2026-10-19

## Ревью рисковых мест (§12.5)

- **Безопасность** — поставка трогает два механизма согласия: разрешение проекта (раскладка
  файлов) и откат (чьи записи видны). Чем опасно здесь — ниже по пунктам; токены и их
  хранение (D-24) не менялись: у каждого профиля свой ключ анклава, касание — своё.
- **Разрешение — механизм безопасности, и его раскладка поменялась.** Ошибка в пути
  открыла бы запись не тому профилю или закрыла обоим. Держат: проверка профиля в тексте
  подписи (`other_account` у файла, скопированного в чужой каталог), отдельный каталог на
  профиль (`grantsDir(account)` без значения по умолчанию — вызвать без профиля нельзя),
  тест на файл прежней раскладки (W6), проба `grant.per-profile`.
- **Выбор сервера — правило, а не механизм.** Агент может пойти не тем сервером: читать
  ему даст только то, что видит аккаунт этого сервера, писать — через превью, код плана и
  разрешение этого профиля. Подмены профиля без ведома человека нет: строка и фраза
  называют профиль.
- **Откат по чужой записи на общем файле** — закрыт фильтром профиля (`ownRecords`),
  названная по id — отказ правилом; оба судит тест через протокол (W5).
- **Скрипт подключения правит конфиги владельца.** Отказы — до записи (опечатка, дубль,
  профиль без каталога, список при отключении), копии — в `~/.claude/backups/`, тесты — на
  временном каталоге; живьём — только словом владельца.
- **Деньги** — риска нет, потому что поставка ничего не тратит: «бюджет» в диффе — бюджет
  ячеек правки и время мутационного прогона.
- **Транзакция БД** — базы нет; файл разрешения пишется в каталог профиля целиком
  (`writeFile` + `chmod`), журнал — дописыванием строки, как до D-25.
- **Производительность** — `gc_targets` читает статус только своего профиля (раньше —
  всех) и список каталогов профилей: дешевле прежнего.

## Assertion digest (ревью ожиданий, не кода)

База: `main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **81**, из них без ссылки на пример спеки:
**6**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
W1	expect(adds).toHaveLength(4);
W1	expect(adds[0]).toContain(
W1	expect(adds[2]).toContain(
W1	expect(adds[3]).toMatch(
W1	expect((await settings()).permissions.allow).toEqual([
W9	expect(text).toContain('`mcp__g-connect__*` — профиль default');
W9	expect(text).toContain('`mcp__g-connect-work__*` — профиль work');
W9	expect(text).toContain('Не знаешь, чей файл, —\n  спроси человека');
W9	expect(text).toContain('«G connect (work) попросит палец…»');
W9	expect(text).not.toMatch(/@|docs\.google|spreadsheets\//);
W9	expect(text.match(/g-connect:begin/g)).toHaveLength(1);
W8	expect(removes).toEqual([
W8	expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
W8	expect(await memo()).toBe('# Мои правила\n');
W10	expect((await calls()).filter((c) => c.includes('g-connect-'))).toEqual([]);
W10	expect(text).toContain('Инструменты `mcp__g-connect__*` есть в каждом проекте');
W10	expect(text).not.toContain('профиль default');
-	expect(() => run('--profiles=default,Work', '--apply')).toThrow(/строчная латиница/);
-	expect(() => run('--profiles=work,work', '--apply')).toThrow(/назван дважды/);
-	expect(() => run('--profiles=default,ghost', '--apply')).toThrow(/профиля «ghost» нет/);
-	expect(() => run('--disconnect', '--profiles=work', '--apply')).toThrow(/список профилей/);
-	expect((await settings()).permissions.allow).toEqual(['Bash(ls)']);
-	await expect(readFile(claudeLog, 'utf8')).rejects.toThrow();
L21	expect(registered).toEqual(['default', 'work', 'team-2'].map(serverName));
L21	import { expect } from 'vitest';
B2	expect(await revokeGrant(PROJECT, 'work')).toBe(true);
B2	expect(await currentGrant(keys, PROJECT, 'default')).toMatchObject({ state: 'granted' });
B2	expect(await currentGrant(keys, PROJECT, 'default')).toMatchObject({ reason: 'no_grant' });
B2	await expect(
B2	expect(await pickUndoRecord(source, 'T', { account: 'work', project: PROJECT })).toMatchObject({
B2	expect((await stat(grantsDir('default'))).mode & 0o777).toBe(0o700);
B2	expect(await revokeGrant(PROJECT_A, 'default')).toBe(true);
B2	expect(await revokeGrant(PROJECT_A, 'default')).toBe(false);
B2	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toMatchObject({
W4	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toEqual({
W4	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toEqual({
W4	expect(await revokeGrant(PROJECT_A, 'work')).toBe(true);
W4	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'default', NOON)).toMatchObject({
W4	expect(await currentGrant(fileKeys(owner), PROJECT_A, 'work', NOON)).toMatchObject({
W4	expect((await listGrants(fileKeys(owner), 'default', NOON)).map((g) => g.project)).toEqual([
W6	expect(await currentGrant(fileKeys(owner), PROJECT_A, account, NOON)).toMatchObject({
W2	expect(work.client.getInstructions()?.split('\n')[0]).toContain(
W2	expect(personal.client.getInstructions()?.split('\n')[0]).toContain(
W2	expect(own.profile).toMatchObject({
W2	expect(own.profile.about).toContain('профиль work');
W2	expect(own.otherProfiles).toEqual(['профиль default — сервер g-connect']);
W2	expect(own).not.toHaveProperty('accounts');
W2	expect(mine.otherProfiles).toEqual(['профиль work — сервер g-connect-work']);
W3	expect(locked.error).toMatchObject({ code: 'google_locked' });
W3	expect(locked.error?.detail).toContain(`«${line}»`);
W3	expect(((await work.call('gc_targets', {})).data as Targets).google.detail).toContain(line);
W3	expect(touches['work'] ?? 0).toBe(0);
W3	expect((await work.call('gc_unlock', {})).data).toMatchObject({ status: 'unlocked' });
W3	expect(touches['work']).toBe(1);
W3	expect((await work.call('gc_read', { target: SHEET, mode: 'map' })).ok).toBe(true);
W3	expect(((await personal.call('gc_targets', {})).data as Targets).google.state).toBe('locked');
W3	expect(touches['default'] ?? 0).toBe(0);
B2	expect(undo.data).toMatchObject({
B2	expect(client.writes).toHaveLength(0);
B2	expect(named.error).toMatchObject({ code: 'policy_denied', cause: 'undo.own-profile' });
B2	expect(client.writes).toHaveLength(0);
W7	expect(own.profile.state).toBe('needs_reauth');
W7	expect(own.profile.next).toBe(
W4	expect(workGrant.detail).toContain('«открой G connect (work)»');
W4	expect(ownGrant.detail).toContain('«открой G connect»');
W4	await expect(authorizeWrite(unlisted, none, 'work')).rejects.toMatchObject({
W10	expect(serverName('default')).toBe('g-connect');
W10	expect(unlockLine('default')).toBe(
W10	expect(grantPhrase('default')).toBe('открой G connect');
W10	expect(gcCommand('default', 'seal')).toBe('npm run gc -- seal');
W10	expect(serverName('work')).toBe('g-connect-work');
W10	expect(grantPhrase('work')).toBe('открой G connect (work)');
W10	expect(personal.client.getServerVersion()?.name).toBe('g-connect');
W10	expect(work.client.getServerVersion()?.name).toBe('g-connect-work');
W10	expect(locked.error?.detail).toContain(`«${unlockLine('default')}»`);
W10	expect(locked.error?.detail).not.toContain('(default)');
W10	expect(data.profile).toMatchObject({ account: 'default', state: 'needs_reauth' });
W10	await expect(
W10	await expect(
W10	expect(await authorizeWrite(unlisted, () => Promise.resolve(GRANTED), 'default')).toMatchObject(
W10	expect(policyRules()).toHaveLength(50);
```

Привязаны к примерам: **B2 L21 W1 W10 W2 W3 W4 W6 W7 W8 W9**. Остальные 6 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 6

## Ревью ожиданий

- **asserts_reviewed_by:** human:anton at=2026-10-19 (слово владельца в сессии: ответ
  «Подписываю» на вопрос с вариантами; ожидания выведены из примеров W1–W10 подписанной
  спеки и плана; шесть непривязанных — отказы скрипта подключения на опечатку, дубль,
  неизвестный профиль и список при отключении: слайс 4 плана и урок L27)
