# Stack acceptance

**Date:** 2026-09-01
**Stack:** delivery@1.84 · cqg@2.32 · okf@absent
**Где лежат каноны:** вне репо: `~/Documents/Prepare/` (см. «Остатки»)

checked_at: 2026-09-01
stale_after: 2026-10-01

## Что развёрнуто

| Слой | Состояние | Примечание |
|---|---|---|
| ① delivery/ | deployed | дерево §2.3 целиком; `scripts/delivery_*.py` — 13 модулей |
| ② гейты | deployed | 23 хука pre-commit + 2 на pre-push; стек TS, адаптация — карта ролей ниже |
| ③ knowledge/ | absent | момент: после фазы 2; инварианты пока в DESIGN.md D-1…D-10 |
| ④ CI + гейт мержа | tooling | `quality.yml` (8 шагов, все `if: always()`); `merge_guard.sh` в репо; серверной защиты ветки нет (тариф) |

## Карта ролей гейтов

Стек — чистый TypeScript/Node, а канон рассчитан на Python-backend + TS-frontend.
Поэтому часть ролей заняли другие скрипты: инвариант — **роль, а не имя файла**.
Причины `n/a` живут в `scripts/lint/not-applicable.json` (машинно читаются мета-гейтом).

| Роль (инвариант) | Канонический скрипт | В этом проекте | Статус |
|---|---|---|---|
| Конфиги парсятся | `check-yaml` / `check-json` | как есть (+`exclude` на tsconfig: JSONC) | как есть |
| CI зелёный, не только локально | `check_ci_status.sh` | как есть (нужен `gh`) | как есть |
| Доступ к настройкам типизированно | `check_grep_gate.sh --rule config-access` | `check_grep_gate_ts.sh --rule config-access` (`process.env` вне `src/core/env.ts`) | адаптирован |
| DI вместо магии импорта | `--rule di-indirection` | `check_grep_gate_ts.sh --rule di-indirection` (динамический `import()` в ядре) | адаптирован |
| Сервис не знает про web | `--rule service-no-web` | `check_grep_gate_ts.sh --rule core-no-library` + `layers-gate` (`core-is-leaf`) | адаптирован |
| Нет модулей-помоек | `--rule no-grab-bag-module` | `check_grep_gate_ts.sh --rule no-grab-bag-module` (маска `.ts`) | адаптирован |
| Ошибки не молчат | `check_ast_gate.py --rule silent-except` | eslint `no-empty` (без `allowEmptyCatch`) + `check_grep_gate_ts.sh --rule blind-error` | адаптирован |
| Длинные промпты — в файлы | `--rule inline-prompt` | n/a: промптов нет; появятся в фазе 4 как `policy/rules.md` | n/a + причина |
| Event loop не голодает | `--rule cpu-in-async` | eslint `no-floating-promises`, `no-misused-promises` | адаптирован |
| Список-эндпоинт имеет границу | `--rule unbounded-list` | n/a: web-эндпоинтов нет; границы чтения — `ReadOptions.maxRows`, под тестами | n/a + причина |
| Длина файлов под контролем | `check_file_length.sh` | как есть, маска `*.ts *.py` (24 TS + 13 python-скриптов контура) | как есть |
| Копипаст не растёт | `check_jscpd_gate.sh` | как есть (jscpd) | как есть |
| Warnings линтера не растут | `check_eslint_warnings.sh` | n/a: eslint настроен в `error`, а не `warning` — правило жёстче снимка | n/a + причина |
| **Сложность функций под контролем** | `check_complexity_gate.sh` | как есть (половина ts, eslint) | как есть |
| **Сообщения ошибок с контекстом** | `--rule blind-error` | `check_grep_gate_ts.sh --rule blind-error` (`gcError` с `detail` и `action`) | адаптирован |
| **Зависимости без уязвимостей** | `check_deps_audit.sh` | как есть, npm-половина; python-половина пропускается (нет `pip-audit`) | частично |
| **Тесты действительно утверждают** | `check_mutation_gate.sh` | **не закрыта**: Stryker не установлен. Частично — 18 property-оракулов на fast-check | остаток, см. ниже |
| Направление зависимостей | `check_layers_gate.sh` | как есть (половина ts, dependency-cruiser + свой конфиг) | адаптирован |
| Покрытие изменённого кода | `check_diff_coverage.sh` | `vitest run --coverage` на pre-push и в CI; канонический скрипт — python-only | адаптирован |
| Снимки только вниз | `check_baseline_ratchet.sh` | как есть (в CI) | как есть |
| Секреты не в гите | `detect-secrets-guard` | как есть, baseline `.secrets.baseline` (5 ложных срабатываний зафиксированы) | как есть |
| **Все гейты подключены** | `check_gate_coverage.sh` | как есть: 16 скриптов, 9 подключено, 7 осознанно нет | как есть |
| **Судит ли вписанное** | `contour_doctor.py` | как есть + свои канарейки в `scripts/lint/canaries.json` | как есть |

## Полнота, не только зелёность

- [x] `check_gate_coverage.sh` — OK: 16 скриптов, подключено 9, осознанно нет 7, правил сверено 6
- [x] `pre-commit run --all-files` — 23 хука, все зелёные
- [x] `contour_doctor.py` — **DEAD 0**: ни один объявленный гейт не молчит на своём нарушении.
      AUTO 41 · WEAK 9 · ABSENT 7 · TOOL 3 · SKIP 2. WEAK — честные пропуски по
      отсутствию python-инструментов в пробе доктора (ruff, mutmut, pip-audit, pytest-cov)
- [ ] `stack_selftest.py` — n/a: каноны вне репозитория, самопроверка гоняется в `Prepare/`
- [x] `python3 scripts/delivery_check.py` — прогнан, errors нет
- [x] Число просмотренных артефактов непустое: `delivery_check` читает STATUS, constitution,
      `.claude/settings.json`, `decisions.md`, `archive/INDEX.md` — не «нет каталога, пропускаю»

## Остатки (не закрыто — и почему)

| Инвариант | Почему не закрыт | Компенсация |
|---|---|---|
| Каноны вне репозитория | общие для всех проектов, версионируются отдельно в `Prepare/` | выбор варианта A/B/C по AGENT_STACK §7.1 — обязателен на шаге ② CQG; до этого в CI самопроверки канонов нет и это объявлено, а не замолчано |
| force-push / обход админом | серверной защиты ветки нет (CI и гейт мержа не развёрнуты) | правило в constitution «no force-push to main» + `deny: Bash(git push --force:*)` в правах агента |
| Серверная защита ветки | бесплатный тариф GitHub на приватных правилах; репозиторий публичный, но rulesets не включены | мерж только через `scripts/merge_guard.sh` + pre-push хук; `ci-oracles: tooling`, а не `deployed` |
| **Мутационный гейт** (тесты утверждают) | Stryker не установлен: мутационный прогон не влезал в фазу 1 | 18 property-оракулов на fast-check (§6.5) закрывают часть роли; **это не эквивалент** — задача на фазу 2 |
| python-половины гейтов (`pip-audit`, `mutmut`, `pytest-cov`, `ruff`) | прод-Python в проекте нет | половины честно пропускаются с названной причиной; TS-половины работают |

## Разбор: где эта процедура подвела

Записывать КАЖДЫЙ случай, когда приёмка показала зелено, а дыра была.
Формат: симптом → корневая причина → что добавлено в harness → как проверено.

_Пока пусто: первое развёртывание в этом проекте._
