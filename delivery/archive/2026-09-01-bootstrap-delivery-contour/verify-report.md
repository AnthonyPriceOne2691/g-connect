# Verify report

**Date:** 2026-09-01
**Verifier:** human:anton
**asserts_reviewed_by:** n/a (класс S; уровень 3 §3.1d обязателен для M/L, здесь acceptance-примеры A1–A9 живут в tasks.md и проверяются командами ниже)
**CI run:** n/a — CI не развёрнут, `ci-oracles: weak` объявлено в STATUS; DoD этой поставки закрывается чеклистом §7.3 + приёмкой человеком
**Commit:** 3d93014 (последний коммит bootstrap до архивации; проверяющий — human:anton, §5.2)

## Shape oracles
- [x] n/a — CQG не развёрнут (`shape-oracles: weak`), момент развёртывания в STATUS

## Behavior oracles
- [x] n/a — кода продукта в этой поставке нет; тестов нет, потому что нет модулей

## Product oracles
- [x] PASS — `python3 scripts/delivery_check.py`: 0 errors (warning про `ci-oracles: weak` ожидаем и объявлен)
- [x] PASS — `delivery/evals/smoke` S1–S4 прогнаны, см. ниже
- [x] n/a — `active/eval-smoke.md` обязателен для M/L, класс S

## Чеклист DoD bootstrap (§7.3)

- [x] `delivery/CONSTITUTION.md` существует и не копирует CQG/OKF дословно
- [x] `delivery/active/STATUS.md` с `phase:` и `class:`
- [x] Hook A.5 в `AGENTS.md`
- [x] `scripts/delivery_check.py` запускается
- [x] `delivery/evals/smoke/README.md` создан
- [x] `decisions.md` и `archive/INDEX.md` созданы
- [x] `delivery/active/.gitkeep` закоммичен (`git ls-files delivery/active/`)
- [x] `.claude/settings.json` создан и совпадает с блоком `agent-permissions` в constitution
- [x] В constitution явный backlog «шаг 2/3 §0.1» вместо указателей (CQG/OKF не в репо)
- [x] Версии канонов записаны в constitution и STATUS (`delivery@1.84`)
- [x] CI-джоба **не** настроена → в STATUS `ci-oracles: weak` + пункт backlog
- [ ] ⚠ Branch protection подтверждён человеком — **не подтверждён**: серверной защиты нет
      (CI и гейт мержа развёртываются на шаге ②), поэтому `ci-oracles: weak`, а не `deployed`
- [x] Раскладка путей: `delivery_check` показывает непустое чтение артефактов —
      STATUS, constitution, `.claude/settings.json`, `decisions.md`, `archive/INDEX.md`
- [ ] (Опц.) hooks §10 не подключены — `hooks: not-deployed`

## Ревью рисковых мест (§12.5)

**Класс риска: интеграция.** Дифф этой поставки — только документы (`DESIGN.md`, `README.md`, `delivery/`), кода нет.
Поэтому риск здесь не «что сломается в рантайме», а «какое из объявленных мест интеграции
развалится при реализации». Три таких, с именами из диффа:

1. **`http/server.ts` как новая поверхность.** Объявлен локальный фасад на `127.0.0.1` для
   двух клиентов (`agent/runner.ts` и `ui/`). Сломаться может тем, что фасад начнёт
   обрастать своей логикой — тогда режим A (MCP) и режимы B/C разойдутся в поведении,
   и это не покажет ни один тест, потому что оба пути «работают». Компенсация записана в
   D-13 и §13.2: UI и раннер только рендерят типизированные ответы core
   (`preview` / `needs_clarification` / карта / индекс). Проверяемо: критерий MVP №5
   требует один и тот же сценарий через MCP и через раннер.
2. **Три места, где живут правила** (`policy/rules.md`, `policy/rules.json`, `instructions`
   MCP-сервера). Классический дубль: текст правил разъедется с машинной частью, и «правило
   есть» перестанет означать «правило работает». Компенсация — D-12: `rules.json`
   исполняется в core, `rules.md` только объясняет; при реализации нужен тест, что каждое
   ограничение из `rules.json` имеет отказ на уровне core, а не только строчку в тексте.
3. **`ui/` как второе дерево зависимостей** (React + Vite + TS + Tailwind, D-14) в проекте,
   где ядро — серверный TS. Риск не технический, а процессный: сборка UI начнёт диктовать
   версии tooling ядру. Компенсация: `ui/` — отдельный package со своим lock-файлом,
   ядро от него не зависит; фаза 4, то есть после того как ядро устоялось.

Риска в самих `delivery/*` нет: это артефакты процесса, их отказ виден `delivery_check`
немедленно и стоит один прогон.

## Spec coverage gaps
- A9 закрывается пушем в публичный репозиторий; проверка «секретов в дереве нет» — оракул S3.
- Выбор варианта A/B/C по AGENT_STACK §7.1 (каноны вне репо) отложен до шага ② и записан
  в `STACK-ACCEPTANCE.md` → «Остатки», а не замолчан.

## Verdict
- [x] READY FOR HANDOFF (после приёмки человеком: строка `Commit:` и подпись verifier)
- [ ] NEED CONVERGE (new tasks)
- [ ] BLOCKED
