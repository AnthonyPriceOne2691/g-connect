# Verify report — токен под пальцем (D-24)

Статус: **код готов, живой прогон пройден 2026-10-18** (слово владельца «давай прогон»;
отложен был 2026-10-17, «Позже»). Мерж — словом владельца, через `merge_guard`.

## Оракулы по примерам

| id | Чем судится | Где |
|---|---|---|
| U1 | строки refresh-токена нет ни в одном файле профиля; круг ключом профиля (настоящий age) | `tests/profiles.test.ts`, `tests/token-vault.test.ts` (U11), живьём — шаг 2 |
| U2 | отзыв — до входа, вход — только после `invalid_grant` на старом токене; ответы Google по документации | `tests/token-seal.test.ts`, живьём — шаг 3 |
| U3 | закрытый Google → `google_locked` без окна; `gc_unlock` → одно касание → данные | `tests/mcp-unlock.test.ts` (протокол), `tests/token-vault.test.ts` |
| U4 | второе обращение в течение часа — без окна | те же |
| U5 | после часа (запас минута) — снова `google_locked`, открыть — снова касание | `tests/token-vault.test.ts` (часы теста) |
| U6 | отмена или 60 с тишины → `unlock_declined`, к Google ни одного запроса | `tests/token-age.test.ts`, `tests/token-vault.test.ts`, `tests/mcp-unlock.test.ts` |
| U7 | `token.json` удалён — скрипт, читающий его, падает | `tests/token-seal.test.ts`, живьём — шаг 8 |
| U8 | чужой ключ / другой Mac — «войди заново», а не мусор | `tests/token-age.test.ts` |
| U9 | вход пишет шифротекст, `token.json` не появляется | `tests/auth.test.ts` |
| U10 | нет `age` или плагина — отказ с командой установки | `tests/token-age.test.ts`, `tests/token-seal.test.ts` |
| U11 | новый refresh-токен от Google — перешифрован без касания | `tests/token-vault.test.ts` |
| U12 | `gc_targets` — «закрыт» со строкой или «открыт до HH:MM», без окна | `tests/mcp-unlock.test.ts` |
| U13 | запись вне реестра требует обоих касаний | `tests/mcp-unlock.test.ts` |
| U14 | `gc run` — `GOOGLE_ACCESS_TOKEN` у ребёнка, refresh-токена нет, код возврата его | `tests/token-seal.test.ts`, живьём — шаг 9 |

## Обратные прогоны (каждый — красный на своём тесте)

- `PATH` сессии протёк к ребёнку `age` → «плагина нет на PATH ребёнка» красный.
- Перепутаны «касания не было» и «ключ не тот» → U8 и U6 красные.
- Таймер убивает только `age`, без группы → тест с заглушкой «`sleep 30 & wait`» красный
  дважды (до явного внука оракул флакал: `sh` то подменял себя на `sleep`, то нет).
- Без склейки одновременных `unlock` → «одно окно, а не два» красный.
- Refresh-токен оставлен в памяти → U5 «снова касание» красный.
- Открытие Google вне `gc_unlock` (в `tokenForClients`) → U3, U6, U13 красные.
- Вход без ожидания подтверждения отзыва → порядок и «отзыв не подтверждён» красные.
- `token.json` удалён до входа → «вход не удался — token.json на месте» красный.

## Найдено по дороге

- **Дефект общего запуска процессов** (старше поставки): по таймеру вызов ждал закрытия
  потоков, которые держит внук. У `age` внук — плагин с окном Touch ID: окно без ответа
  повесило бы вызов, пока плагин не выйдет сам. Починено: своя группа процессов, убивается
  целиком, ответ — сразу (`src/core/subprocess.ts`).
- **Доли мутаций до PR** (урок L31): доля 4/4 — 56%, 1/4 — 62%; `subprocess.ts` судили только
  швы. Дописаны проверки свойств (минимальное окружение ребёнка, смерть внука, ранний EPIPE,
  классы отказов `age`, края хранилища): 74% · 71% · 68% · 77%.
- **Оценка плана занижена на треть** (1400/28 → 1903/39 до живого прогона): waiver поднят
  словом владельца до 45/2400/4.
- Первый запуск только что созданного скрипта macOS проверяет дольше 300 мс — таймер теста
  группы процессов поднят до 1,5 с (на продукт не влияет: `age` — подписанная программа).

## Живой прогон

Пройден 2026-10-18 — `live-run.md`, «Результат». Несущий порядок выдержан: стабильная
сборка из ветки → `gc seal` владельцем → памятка → сессия от имени соседнего проекта →
`gc run`. Живьём: U1, U2, U3, U4, U7, U12, U14 и сверх плана U6 (отмена в окне →
`unlock_declined`). Тестами: U5, U8, U10, U11, U13. Починок не понадобилось.

## Риски и непокрытое

- Граница согласия, а не изоляция: программа под тем же пользователем, подменившая `age`,
  `node` или стабильную сборку, дождётся ожидаемого касания. В окне — текст
  `age-plugin-se`, не наш; кто просит, видно только по строке в чате.
- Ошибочное касание неожиданного окна отдаёт refresh-токен до 7 дней (Testing).
- Окно Touch ID из процесса без окна (`age-plugin-se` под сервером) — **замерено
  2026-10-18**: показывается, касание и отмена доходят до ядра.
- Отмена касания — **замерена 2026-10-18**: `unlock_declined (declined)`, не «ключ не тот».
- Не наблюдалось живьём: строку до окна пишет свежий агент соседней сессии — шаги 5–7 вёл
  агент поставки по слову владельца. Правило доходит двумя каналами: инструкции сервера и
  памятка.
- Ctrl-C в `gc run` или `gc seal` при открытом окне — CLI умирает, `age` в своей группе
  остаётся, окно ждёт ответа человека (решение в `decisions.md`, «Своя группа процессов»).

## Исполнение рисковых путей

`runtime_paths`: `src/core/token/*.ts`, `src/core/auth.ts`, `src/core/profiles.ts`,
`src/cli/manual.ts`.

- **Прогнал** `gc seal` на настоящей машине — владелец в своём терминале (`manual.ts` →
  `seal-flow.ts` → `age.ts`, `auth.ts`, `profiles.ts`): ключ анклава, пробное касание, отзыв,
  вход в браузере. **Увидел**: `token.json` нет, `token.age` — шифротекст age,
  `token.meta.json` без токена, права 600/700, строк вида refresh-токена нет ни в одном файле
  `~/.gconnect`; `gc status` — `connected`, без окна. at=2026-10-18
- **Прогнал** стабильную сборку ветки одним процессом от имени соседнего проекта
  (`vault.ts`, `sealing.ts`, `age.ts`, `subprocess.ts`): `gc_read` при закрытом Google,
  `gc_unlock` с отменой и с касанием, два чтения, `gc_targets`. **Увидел**: `google_locked` за
  1 мс без окна; окно Touch ID из процесса сервера без окна; отмена → `unlock_declined
  (declined)`; касание → карта настоящей таблицы; второй запрос без окна; «открыт до 02:22».
  at=2026-10-18
- **Прогнал** `gc run -- node <проба Drive about>` (`manual.ts` → `run-with-token.ts`).
  **Увидел**: строка → касание → Drive 200 с адресом аккаунта; refresh-токена в окружении
  ребёнка нет; код возврата 0. at=2026-10-18
- **Прогнал** `install_stable.sh 3efb59b` и `connect_claude.sh --apply` с ключом `irreversible`
  по слову владельца. **Увидел**: проба собранного сервера зелёная дважды (восемь
  инструментов), блок памятки один, копия в `~/.claude/backups/`. at=2026-10-18
- CI на `e44c4cb`: 717 тестов на настоящем `age` (Linux, без пропусков), доли мутаций
  72 · 72 · 68 · 77 при пороге 60; на `3efb59b` (только документы) все пять проверок
  зелёные. at=2026-10-17

## Изменение поверхности модели (§14.4)

Дифф задел `src/policy/rules.md`, `src/policy/rules.json` и `tools/list` — то, что уходит
агенту как `instructions`, `policy://rules` и список инструментов.

1. **Восьмой инструмент `gc_unlock`** — открыть Google сессии касанием на час; в описании:
   звать после `google_locked` и только сразу после строки человеку.
2. **Новый отказ `google_locked`** с действием `unlock_google` у всех инструментов, идущих в
   Google; `unlock_declined` — «касания не было, не повторяй сам»; `token_unsealed` и
   `seal_tool_missing` — с командой (`gc seal`, установка `age`).
3. **`gc_targets`** называет состояние Google: «закрыт» со строкой или «открыт до ЧЧ:ММ».
4. **«Про доступ» в `rules.md`**: строка перед окном слово в слово; неожиданное окно —
   повод не касаться; токен сам не расшифровывать и `~/.gconnect` не читать.
5. **Два новых правила** (`token.sealed-at-rest`, `google.unlock-only-tool`) с пробами —
   правил 48.
6. **Памятка** вне репозитория (`~/.claude/CLAUDE.md` из `connect_claude_edit.py`) — тот же
   текст правила; обновлена по слову владельца.

Прогнал `npm run build` и `probe_mcp` дважды внутри `install_stable.sh`: восемь
инструментов, `gc_unlock` объявлен; живьём агент получил `google_locked` с действием и
строку в `gc_targets`. at=2026-10-18

## Ревью рисковых мест (§12.5)

- **Граница согласия, а не изоляция — и после поставки.** Программа того же пользователя,
  подменившая `age`, `node` или стабильную сборку, дождётся ожидаемого касания и получит
  токен. Пути программ абсолютные (`/opt/homebrew/bin`, `/usr/bin`), окружение ребёнка —
  `PATH=/usr/bin:/bin`, но запись в Homebrew и в `~/Library/Application Support/g-connect/`
  у пользователя есть. Поставка защищает от открытого файла на диске и от агента, который
  работает через G connect, — не от злонамеренного процесса того же пользователя.
- **Ошибочное касание.** Окно `age-plugin-se` системное, без слов G connect: своё окно
  отличается только строкой в чате. Касание неожиданного окна отдаёт refresh-токен
  процессу, который его вызвал, — до 7 дней (Testing).
- **Отзыв гасит все токены приложения.** `gc seal` отзывает старый вход, и вместе с ним
  умирают токены этого OAuth-клиента у других программ и машин; названо в спеке. Обрыв на
  любом шаге оставляет `token.json`, повтор `gc seal` начинает сначала.
- **Ctrl-C при открытом окне** — CLI умирает, `age` в своей группе остаётся, окно ждёт
  ответа человека. Утечки нет: ответ `age` уходит в закрытую трубу.
- **Хранилище — память процесса.** Access-токен живёт до истечения минус 60 секунд,
  refresh-токен выбрасывается после обмена; новый refresh-токен от Google перешифровывается
  без касания (U11, тест).
- **Деньги** — риска нет, потому что поставка ничего не тратит: «бюджет» в диффе — бюджет
  ячеек правки и время мутационного прогона.
- **Транзакция БД** — базы нет; файлы профиля пишутся черновиком и переименованием
  (`writeSecret`), поэтому оборванная запись не оставляет полуфайла.
- **Производительность** — одновременные `gc_unlock` склеиваются в одно окно (тест «одно
  окно, а не два»); закрытый Google отвечает за 1 мс, к ключу не ходит.

## Assertion digest (ревью ожиданий, не кода)

База: `main` · сгенерировано `assert_digest.sh`

Новых/изменённых утверждений: **158**, из них без ссылки на пример спеки:
**70**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое
значение — из спеки или придумано под реализацию?**

```
U9	expect(await readTokenMeta()).toMatchObject({
U9	expect(await plainOnDisk()).toBe(false);
U9	expect(await readTokenMeta()).toBeNull();
-	await expect(requireUsableProfile('default')).rejects.toMatchObject({
-	expect(memo).toContain('gc_unlock');
-	expect(memo).toContain('G connect\n  попросит палец');
L29	import { expect } from 'vitest';
L29	expect(status.refreshAgeDays).toBeGreaterThanOrEqual(6);
L29	expect(status.warnings.join(' ')).toContain('Testing');
L29	expect(status.warnings.join(' ')).toContain('войди заново');
L29	expect((await profileStatus('fresh')).warnings).toHaveLength(0);
L29	await expect(writeSealedToken(leaky, { refresh_token: '1//r' }, 'leak')).rejects.toMatchObject({
L29	expect(await readSealedToken('leak')).toBeNull();
L29	expect((await profileStatus('legacy')).state).toBe('unsealed');
L29	await expect(requireProfile('legacy')).rejects.toMatchObject({
L29	expect(code).toBe('google_locked');
L29	expect(unseals).toBe(0);
L29	expect(agentKeyName('  ecdsa  AAAA  G connect@secretive.host')).toBe('G connect');
L29	expect(agentKeyName('ecdsa AAAA @secretive.host')).toBeUndefined();
L29	expect(keyNameKey('  G_connect  key ')).toBe('g-connect-key');
L29	expect(SECRETIVE_SOCKET).toBe(
-	expect(
-	expect(empty.map((tool) => tool.name)).toEqual(['gc_targets', 'gc_unlock']);
-	expect(tool.inputSchema.additionalProperties).toBeUndefined();
U3	expect(locked.error).toMatchObject({
U3	expect(touches).toBe(0);
U3	expect(opened.data).toMatchObject({
U3	expect(touches).toBe(1);
U3	expect((await callMcp(gcRead, { target: SHEET }, d)).ok).toBe(true);
U4	expect((await callMcp(gcUnlock, {}, d)).data).toMatchObject({ status: 'already_unlocked' });
U4	expect(touches).toBe(1);
U12	expect(before.google.state).toBe('locked');
U12	expect(before.google.detail).toContain('G connect попросит палец');
U12	expect(before.google.detail).toContain('gc_unlock');
U12	expect(after.google).toMatchObject({
U12	expect(touches).toBe(1);
U6	expect(declined.error).toMatchObject({
U6	expect((await callMcp(gcRead, { target: SHEET }, d)).error?.code).toBe('google_locked');
L27	expect(result.error?.code).toBe('bad_request');
L27	expect(touches).toBe(0);
U13	expect((await callMcp(gcApply, upsert, locked)).error?.code).toBe('google_locked');
U13	expect((await callMcp(gcApply, upsert, deps(open))).error?.code).toBe('needs_grant');
U13	expect((await callMcp(gcApply, upsert, deps(open, granted))).ok).toBe(true);
U13	expect(json).not.toContain('r-секрет');
U13	expect(policyRules()).toHaveLength(48);
-	expect(status.state).toBe('unsealed');
-	expect(status.hasToken).toBe(false);
-	expect(status.warnings.join(' ')).toContain('gc -- seal');
-	await expect(requireProfile()).rejects.toMatchObject({
-	expect(JSON.stringify(status)).not.toContain('r-секрет');
-	expect(status).not.toHaveProperty('expiresAt');
-	expect((await stat(join(profileDir(), file))).mode & 0o777).toBe(0o600);
-	expect((await stat(profileDir())).mode & 0o777).toBe(0o700);
-	await expect(writeSealedToken(leaky, { refresh_token: '1//утечка' })).rejects.toMatchObject({
-	expect(await readSealedToken()).toBeNull();
-	await expect(profileSealer(ageToolsIn('/opt/homebrew/bin'))).rejects.toMatchObject({
U1	expect(meta.recipient).toBe(sealer.recipient);
U1	expect(await readFile(join(profileDir(), file), 'utf8')).not.toContain('секрет-U1');
U1	expect(stored?.meta).toEqual(await readTokenMeta());
U1	expect(await unsealer.unseal(stored?.sealed ?? '', meta)).toContain('1//секрет-U1');
-	expect(await readSealedToken()).toBeNull();
-	expect(await readTokenMeta()).toBeNull();
-	expect((await readTokenMeta(account))?.scope).toBe(scope);
-	expect((await stat(join(profileDir(account), 'token.age'))).mode & 0o777).toBe(0o600);
-	expect([
-	expect(status.hasCredentials && status.hasToken).toBe(true);
-	if (dir && plain) expect(status.warnings.join(' ')).toContain('открытым файлом');
-	expect((await run('/usr/bin/env', [])).stdout.trim()).toBe('PATH=/usr/bin:/bin');
-	expect(named.split('\n').sort()).toEqual(['', 'PATH=/usr/bin:/bin', 'X=1']);
-	expect(await run('/bin/echo', ['привет'])).toEqual({
-	expect((await run('/bin/cat', [])).stdout).toBe('');
-	expect((await run('/usr/bin/true', [], { input: 'x'.repeat(2_000_000) })).code).toBe(0);
-	expect(result.timedOut).toBe(true);
-	expect(() => process.kill(pid, 0)).toThrow();
U8	expect(sealed.startsWith('-----BEGIN AGE ENCRYPTED FILE-----')).toBe(true);
U8	expect(sealed).not.toContain('проба-секрета');
U8	expect(await unsealWith(tools, ownKey, sealed, ownRecipient)).toBe(plain);
U8	expect(await codeOf(unsealWith(tools, otherKey, sealed, ownRecipient))).toMatchObject({
U6	expect(await codeOf(unsealWith(tools, otherKey, sealed, otherRecipient))).toMatchObject({
U10	expect(missing).toMatchObject({
U10	expect(await codeOf(unsealWith(absent, ownKey, 'x', ownRecipient))).toMatchObject({
U10	expect(await codeOf(requireAgeTools(absent))).toMatchObject({ code: 'seal_tool_missing' });
U10	expect(await codeOf(sealFor(noPlugin, SE_RECIPIENT, 'секрет'))).toMatchObject({
-	expect(refused).toMatchObject({ code: 'internal', cause: 'age_seal_failed' });
-	expect(refused.detail).not.toContain('report unexpected');
-	expect(await codeOf(unsealWith(tools, garbage, sealed, ownRecipient))).toMatchObject({
-	expect(await codeOf(sealFor(withPlugin, SE_RECIPIENT, 'секрет'))).toMatchObject({
-	expect(recipientInIdentity(await readFile(ownKey, 'utf8'))).toBe(ownRecipient);
-	expect(recipientInIdentity('AGE-SECRET-KEY-1…')).toBeUndefined();
-	expect((await findAgeTools([join(dir, 'пусто'), AGE_DIR ?? ''])).age).toBe(
-	expect((await findAgeTools([join(dir, 'пусто')])).age).toBe(join(dir, 'пусто', 'age'));
U6	expect(result).toMatchObject({
U6	expect(Date.now() - started).toBeLessThan(5_000);
-	expect(await createSeIdentity(ageToolsIn(stub), file)).toBe('age1se1stub');
-	expect((await stat(file)).mode & 0o777).toBe(0o600);
U1	expect(calls).toEqual(['revoke:1//старый', 'alive?', 'alive?', 'alive?', 'login']);
U1	expect(report.revoked).toBe(true);
U1	expect(await present(plainFile())).toBe(false);
U1	expect((await readTokenMeta())?.recipient).toBe(report.recipient);
-	await expect(sealProfile(flow(1_000))).rejects.toMatchObject({
-	expect(calls).not.toContain('login');
-	expect(await present(plainFile())).toBe(true);
-	await expect(sealProfile(flow(0, true))).rejects.toMatchObject({
-	expect(await present(plainFile())).toBe(true);
-	expect(calls).toEqual(['login']);
-	expect(report.revoked).toBe(false);
U6	await expect(sealProfile({ ...flow(), tools: { ...tools, age: fake } })).rejects.toMatchObject({
U6	expect(calls).toEqual([]);
U6	expect(await present(plainFile())).toBe(true);
U10	await expect(
U10	expect(calls).toEqual([]);
U14	'const e = process.env; require("fs").writeFileSync(process.argv[1], JSON.stringify({' +
U14	expect(code).toBe(7);
U14	expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ a: 'ya29.U14', r: false });
U14	expect(v.touches).toBe(1);
-	await expect(
-	expect(launched).toBe(0);
-	await expect(spawnInherit(join(tmpdir(), 'нет-такой-команды'), [], {})).rejects.toMatchObject({
-	expect(isInvalidGrant(failure('invalid_grant'))).toBe(true);
-	expect(isInvalidGrant({ message: 'request failed: invalid_grant' })).toBe(true);
-	expect(isInvalidGrant(failure('invalid_client'))).toBe(false);
-	expect(isInvalidGrant(undefined)).toBe(false);
-	expect(isAlreadyRevoked(failure('invalid_token'))).toBe(true);
-	expect(isAlreadyRevoked(failure('invalid_request'))).toBe(false);
-	expect(isAlreadyRevoked(null)).toBe(false);
U3	expect(codeOf(() => v.accessToken())).toMatchObject({
U3	expect(v.status()).toEqual({ state: 'locked' });
U3	expect(touches).toBe(0);
U3	expect(opened.state).toBe('unlocked');
U3	expect(touches).toBe(1);
U3	expect(refreshed).toEqual(['1//r1']);
A1	expect(v.accessToken()).toBe('A1');
A1	expect(v.accessToken()).toBe('A1');
A1	expect(touches).toBe(1);
U5	expect(codeOf(() => v.accessToken())).toMatchObject({
U5	expect(v.status()).toEqual({ state: 'locked' });
U5	expect(touches).toBe(2);
A2	expect(v.accessToken()).toBe('A2');
-	expect(touches).toBe(1);
U6	await expect(v.unlock()).rejects.toMatchObject({ payload: { code: 'unlock_declined' } });
U6	expect(v.status()).toEqual({ state: 'locked' });
U6	expect(refreshed).toHaveLength(0);
U6	expect(touches).toBe(2);
U11	expect(touches).toBe(1);
U11	expect(stored?.meta.obtained_at).toBe(42);
U11	expect(await unsealer.unseal(stored?.sealed ?? '', stored!.meta)).toContain('1//r2');
U11	expect(await readFile(join(profileDir(), file), 'utf8')).not.toContain('1//r2');
-	await expect(vault().unlock()).rejects.toMatchObject({ payload: { code: 'token_unsealed' } });
-	expect(touches).toBe(0);
-	await expect(vault().unlock()).rejects.toMatchObject({ payload: { code: 'scope_missing' } });
-	expect(touches).toBe(0);
-	expect(await vault().unlock()).toEqual({
-	await expect(w.unlock()).rejects.toMatchObject({
-	expect(w.status()).toEqual({ state: 'locked' });
-	await expect(vault().unlock()).rejects.toMatchObject({
-	await expect(vault().unlock()).rejects.toMatchObject({
-	await expect(vault().unlock()).rejects.toMatchObject({
-	expect(touches).toBe(0);
```

Привязаны к примерам: **A1 A2 L27 L29 U1 U10 U11 U12 U13 U14 U3 U4 U5 U6 U8 U9**. Остальные 70 — нет.

Читать нужно **только строки с `-` в первой колонке**: их ожидание
ничем не подписано. Подпись: `asserts_reviewed_by: human:… at=…`.

asserts_without_example: 70

## Ревью ожиданий

- **asserts_reviewed_by:** human:anton at=2026-10-18 (слово владельца в сессии: ответ
  «Подписываю» на вопрос с вариантами; ожидания выведены из примеров U1–U14 подписанной
  спеки, решения D-24 и уроков; непривязанные в дайджесте — структурные: права 600/700, «в
  статусе нет секрета», коды отказов, текст памятки, форма ответа инструментов; живой
  прогон 2026-10-18 их подтвердил)
