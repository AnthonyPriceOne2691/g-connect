# Active delivery status

- **slug:** token-touch
- **stack:** delivery@2.01, cqg@2.56, okf@absent
- **class:** L
- **kind:** feature
- **repro_test:** n/a reason=kind=feature
- **diagnosis:** n/a reason=kind=feature
- **phase:** plan
- **builder:** agent:claude-opus-5-5
- **verifier:** human:anton
- **human_ok_spec:** yes (by=human:anton, at=2026-10-17) reason=ответ «Подписываю» на вопрос с вариантами; решения владельца в спеке: ключ анклава «палец или пароль Mac», запасной ход `gc run` — да, накат контура cqg@2.63 · delivery@2.04 — до кода поставки
- **human_ok_plan:** pending reason=план и waiver предъявлены владельцу 2026-10-17
- **shape-oracles:** cqg-deployed
- **behavior-oracles:** tests-present (671 тест; тесты инструментов — через настоящий протокол)
- **artifact_oracle:** scripts/probe_mcp.mjs reason=судит СОБРАННЫЙ сервер по протоколу — в CI на каждом PR и перед переключением стабильной сборки
- **ci-oracles:** tooling
- **worktree:** ветка feat/token-touch reason=класс L (§5.1); мерж только через merge_guard.sh, за ним contour_doctor
- **parallel_sessions:** merge-guard
- **hooks:** not-deployed reason=OKF не развёрнут (okf@absent)
- **blockers:** none
- **runtime_paths:** src/core/token/*.ts,src/core/auth.ts,src/core/profiles.ts,src/cli/manual.ts
  <!-- расшифровка через age и age-plugin-se с окном Touch ID из дочернего процесса сервера, отзыв и вход в Google: отказ виден только живьём; список уточнит план -->
- **irreversible_surfaces:** none reason=отзыв старого входа в Google и удаление открытого token.json восстанавливаются новым входом владельца в браузере; оба шага делает только `gc seal`, и он требует касания владельца ДО отзыва — человек в цепочке, агент до необратимого сам не дотягивается
- **model_surface:** src/policy/rules.md,src/policy/rules.json
  <!-- агенту уйдут: инструмент gc_unlock, отказ google_locked с действием, правило «строка человеку перед окном»; памятка в ~/.claude/CLAUDE.md — вне репозитория, правится скриптом connect_claude.sh -->
- **rule_enforcers:** src/policy/rules.json
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** no
- **observability:** 1
- **observe_signal:** на диске нет открытого токена; обращение к Google из новой сессии проходит только после касания, объявленного строкой агента; скрипт с token.json не работает
- **observe_until:** 2026-12-01
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4
