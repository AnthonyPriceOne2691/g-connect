# Verify report — окно Touch ID называет G connect и профиль

Статус: **verify** — ветка `feat/finger-window` (`0067365`, `419fca7`); мерж — слово владельца 2026-11-27
«Пушь и сливай после зелёного CI».

- **Verifier:** human:anton

## Оракулы по примерам

| id | Чем судится | Где |
|---|---|---|
| J1 | окно «G connect (work)» и «G connect», касание открывает Google; строка пробного касания `gc seal` называет окно | живьём — `live-run.md` (оба профиля, 27.11); `tests/token-seal.test.ts` |
| J2 | папка подписи первой в `PATH`, плагин запущен копией с именем окна; прокладка отдаёт `keygen`, `recipient-v1` и прочее настоящему плагину; без копии — тоже ему; права 700 | `tests/finger-window.test.ts`; проба `google.unlock-window-named` |
| J3 | плагин обновился — запущена свежая копия | `tests/finger-window.test.ts` |
| J4 | вместо папки файл, подпись не годится в имя, `:` в пути, нет плагина, сорванная запись — расшифровка идёт, обрывков нет; `unlock_declined` (таймер и отмена) называет причину окна без подписи, с подписью — текст прежний | `tests/finger-window.test.ts`, `tests/token-age.test.ts`; проба |
| J5 | три сервера одного профиля разом — все копией, в папке ровно два файла | `tests/finger-window.test.ts` |
| J6 | чужие `FINGER_LABEL` и `PATH` сессии ничего не меняют | `tests/finger-window.test.ts` |
| J7 | пробелы, скобки и апостроф в пути | `tests/finger-window.test.ts` |
| J8 | плагин — ссылка на Cellar: копия — обычный файл, прокладка зовёт ссылку Homebrew | `tests/finger-window.test.ts` |

## Обратные прогоны

Каждая порча — на месте, затем файл возвращён (`git status` после — только правки среза); тесты —
`finger-window`, `policy`, `token-seal`, `token-age`:

- R1: расшифровка профилем (`sealing.ts`) без окна — красные 2: проба `google.unlock-window-named`,
  «расшифровка профилем называет окно профиля».
- R2: `PATH` расшифровки без папки подписи (`age.ts`) — красные 8: проба, J2, J3, J5–J8.
- R3: пробное касание `gc seal` без окна (`seal-flow.ts`) — красный 1: «J1-путь».

## Мутации — доли считают, порог судит сумма (cqg@2.69)

- Локально, `check_mutation_gate.sh` по диффу ветки (5 файлов: `age.ts`, `finger-window.ts`, `sealing.ts`,
  `seal-flow.ts`, `profile-names.ts`): убито 275 из 346 (79%), порог 60% — OK.
- `finger-window.ts` — 100% (72 из 72) после правки теста: два выживших в тексте прокладки (строка-комментарий
  и концевой перевод строки) жили, пока тест сверял прокладку с выводом той же функции; теперь текст —
  буквально.
- В изменённых строках `age.ts`, `sealing.ts`, `seal-flow.ts` выживших нет; выжившие этих файлов — в прежних
  строках (тексты отказов `sealFor` и `createSeIdentity`, ветка `probe_mismatch`, опрос отзыва), поставкой
  не тронуты. `unlock-tool.ts` — вне маски Stryker (правка — комментарий).
- CI PR — четыре доли и сумма: после пуша.

## Изменение поверхности модели (§14.4)

- `rules.md`, «Про доступ»: окно называется так же, как начинается строка перед ним; окно
  `age-plugin-se` без подписи — повод не касаться, причину назовёт `unlock_declined`.
- Правило 72 `google.unlock-window-named` — его заголовок уходит агенту в `policy://rules`.
- Отказ `unlock_declined` дописывает «Окно было без подписи G connect («age-plugin-se»): <причина>»,
  когда подпись не легла; с подписью текст прежний слово в слово.
- Схема инструментов не менялась: Reconnect нужен ради нового кода сервера, а не схемы.

- Затронутые элементы поверхности (at=2026-11-27):
  - `src/policy/rules.md` — абзац «Про доступ»: имя окна и окно без подписи;
  - `src/policy/rules.json` — правило 72 `google.unlock-window-named`;
  - `src/core/token/age.ts` — дописка о подписи в `unlock_declined` (таймер и отмена касания).

## Ревью рисковых мест (§12.5)

- **Окно, которого человек не ждал** — подпись меняет только имя окна; объявление строкой до окна
  остаётся, имя окна совпадает с началом строки. Окно без подписи после строки — повод не касаться,
  и отказ называет причину.
- **Подмена программы** — граница согласия D-24 прежняя: прокладку и копию пишет сам G connect в папку
  профиля (700), копия — клон плагина из Homebrew, пути вписаны при записи, окружение сессии в них не
  попадает (J6). Чужая правка копии живёт до следующей расшифровки.
- **Гонка серверов одного профиля** — запись через временное имя и `rename`; идущая расшифровка держит
  прежний файл (J5).
- **Интеграция** — `age` и `age-plugin-se` (системные программы Homebrew): плагин ищется по `PATH`
  ребёнка, его собирает G connect; копия — `copyFile` с клоном APFS из `realpath` плагина. Судится
  заглушками (J2–J8) и живьём (J1).
- **Транзакция БД** — риска нет, потому что базы нет: два файла в папке профиля, каждый — через
  временное имя и `rename`.
- **Деньги** — риска нет, потому что поставка ничего не тратит.

## Исполнение рисковых путей (§12.6)

Объявленный путь — `src/core/token/finger-window.ts` (`runtime_paths`), at=2026-11-27: исполнен живьём на
обоих профилях (J1, `live-run.md`) — папка подписи создана сервером из ветки, окно названо по профилю,
касание открыло Google.

## Найдено по дороге

- **Тест хранилища токена читал каждый файл папки профиля** (U11) и упал на новой папке `finger/` — теперь
  обходит папку вглубь и требует, чтобы `token.age` был среди прочитанных: проверка не ослабла.
- **Клон ссылки остался бы ссылкой**: `/opt/homebrew/bin/age-plugin-se` — ссылка на Cellar, поэтому копия
  берётся из `realpath` плагина (J8).

## Риски и непокрытое

- Пробное касание `gc seal` идёт тем же швом с подписью — живьём не проверялось (нужен новый вход).
- Окно разрешения проекта (`gc_grant open`) рисует Secretive — его имя поставка не меняет.
- До Reconnect серверы сессий — прежней сборки, их окно по-прежнему `age-plugin-se`; строку о голом окне в
  `~/.claude/CLAUDE.md` менять после Reconnect, иначе окно старого сервера сочтут чужим.
- Общий журнал пальцев `~/.local/share/finger/journal.log` окон G connect не видит (папку без слова
  владельца не трогаем).
- `.part-*` может остаться, если процесс убит между записью и `rename`; следующая расшифровка его не
  трогает.
- §3.1d: спека и тесты приехали одним коммитом — порядок «пример до кода» git не показывает; примеры J1–J8
  взяты из записки сессии portfolio-site и ответа владельца до кода, ожидания подписаны дайджестом.

## Assertion digest (ревью ожиданий, не кода)

База: `origin/main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **45**, из них без ссылки на пример спеки:
**9**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
J2	expect(await unseal({ window })).toEqual({
J2	expect(await unseal()).toEqual({ path: `${bin}:/usr/bin:/bin`, plugin: BARE });
J2	expect(await prepareFinger(tools.plugin, window)).toEqual({ dir: window.dir });
J2	expect(call('keygen', '-o', 'x')).toBe('v1|age-plugin-se|keygen -o x');
J2	expect(call('--age-plugin=recipient-v1')).toBe('v1|age-plugin-se|--age-plugin=recipient-v1');
J2	expect(call()).toBe('v1|age-plugin-se|');
J2	expect(call(IDENTITY_CALL)).toBe(NAMED);
J2	expect((await readdir(window.dir)).sort()).toEqual([LABEL, 'age-plugin-se']);
J2	expect((await stat(path)).mode & 0o777).toBe(0o700);
J2	expect(await readFile(shim, 'utf8')).toBe(
J2	expect(await readFile(copy, 'utf8')).toBe(pluginScript('v1'));
J2	expect(execFileSync(join(window.dir, 'age-plugin-se'), [IDENTITY_CALL]).toString()).toBe(BARE);
J3	expect((await unseal({ window })).plugin).toBe(`v2|${LABEL}|${IDENTITY_CALL}`);
J8	expect((await unseal({ window })).plugin).toBe(`cellar|${LABEL}|${IDENTITY_CALL}`);
J8	expect((await lstat(join(window.dir, LABEL))).isFile()).toBe(true);
J8	expect(await readFile(join(window.dir, 'age-plugin-se'), 'utf8')).toContain(
J4	expect(await unseal({ window })).toEqual({ path: `${bin}:/usr/bin:/bin`, plugin: BARE });
J4	expect(await prepareFinger(tools.plugin, { ...window, label })).toEqual({
J4	await expect(stat(window.dir)).rejects.toThrow();
J4	expect(await prepareFinger(tools.plugin, { dir, label: LABEL })).toEqual({
J4	await expect(stat(dir)).rejects.toThrow();
J4	expect(await prepareFinger(tools.plugin, window)).toEqual({
J4	expect(await prepareFinger(tools.plugin, window)).toEqual({
J4	expect(await readdir(window.dir)).toEqual([LABEL]);
J4	expect(await codeOf(unsealRaw({ window, timeoutMs: 1_000 }))).toMatchObject({
J4	expect(await codeOf(unsealRaw({ window, timeoutMs: 1_000 }))).toMatchObject({
J4	expect(await codeOf(unsealRaw({ window }))).toMatchObject({ cause: 'declined', detail: plain });
J4	expect(await codeOf(unsealRaw({ window: { ...window, label: '' } }))).toMatchObject({
J5	expect(results.map((result) => result.plugin)).toEqual([NAMED, NAMED, NAMED]);
J5	expect((await readdir(window.dir)).sort()).toEqual([LABEL, 'age-plugin-se']);
J6	expect((await unseal({ window })).plugin).toBe(NAMED);
J7	expect((await unseal({ window: odd })).plugin).toBe(NAMED);
-	expect(fingerFileName('G connect (a/b)')).toBe('G connect (ab)');
-	expect(fingerFileName(' \tG connect\u0007 (work)\n ')).toBe('G connect (work)');
-	expect(fingerWindow('work')).toEqual({ dir: join(root, 'work', 'finger'), label: LABEL });
-	expect(fingerWindow('default')).toEqual({
-	expect(printed).toEqual({
-	import { expect } from 'vitest';
-	expect(named.plugin).toBe(`v1|G connect (work)|${IDENTITY_CALL}`);
-	expect(bare.plugin).toBe(`v1|age-plugin-se|${IDENTITY_CALL}`);
-	expect(policyRules()).toHaveLength(72);
J1	expect(said[0]).toBe(
J1	expect(await readdir(join(profileDir(), 'finger'))).toContain('G connect');
J1	expect(files.map((entry) => entry.name)).toContain('token.age');
J1	expect(await readFile(join(entry.parentPath, entry.name), 'utf8')).not.toContain('1//r2');
```

Привязаны к примерам: **J1 J2 J3 J4 J5 J6 J7 J8**. Остальные 9 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 9

## Ревью ожиданий

- **asserts_reviewed_by:** human:anton at=2026-11-27 (слово владельца в сессии: ответ «Подписываю» на вопрос с
  вариантами — в вопросе названы 45 новых проверок ветки `feat/finger-window` относительно `main`, 36 привязанных
  к примерам J1–J8 и 9 непривязанных по группам (имя файла, папка профиля и имя окна, расшифровка профилем, проба
  правила, число правил, строка import) и путь к полному списку; дайджест выше — тот же, база `main`)
