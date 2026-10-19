# Active delivery status

- **slug:** two-profiles
- **stack:** delivery@2.04, cqg@2.63, okf@absent
- **class:** M
- **kind:** feature
- **repro_test:** n/a reason=kind=feature
- **diagnosis:** n/a reason=kind=feature
- **phase:** verify
- **builder:** agent:claude-opus-5-5
- **verifier:** human:anton
- **human_ok_spec:** yes (by=human:anton, at=2026-10-19) reason=ответ «Подписываю» на вопрос с вариантами; решения владельца в спеке: имя второго сервера g-connect-work, без запроса прав, как личный; id примеров P→W до кода — подтверждено владельцем («Да, W1…W10») вместе с планом
- **human_ok_plan:** yes (by=human:anton, at=2026-10-19) reason=ответ «Подписываю» на вопрос с вариантами: план из семи слайсов, отклонённые альтернативы в plan.md, waiver 30/1300/2
- **shape-oracles:** cqg-deployed
- **behavior-oracles:** tests-present (734 теста; тесты инструментов — через настоящий протокол; живой прогон W1–W4, W9 — 2026-10-19, `live-run.md`)
- **artifact_oracle:** scripts/probe_mcp.mjs reason=судит СОБРАННЫЙ сервер по протоколу — в CI на каждом PR и перед переключением стабильной сборки
- **ci-oracles:** tooling
- **worktree:** ветка feat/two-profiles reason=класс M (§5.1); мерж только через merge_guard.sh, за ним contour_doctor
- **parallel_sessions:** merge-guard
- **hooks:** not-deployed reason=OKF не развёрнут (okf@absent)
- **blockers:** none
- **waivers:** max_files_touched=30 max_loc_diff=1300 max_runtime_paths=2 reason=оценка с поправкой L36 — ~1050 строк в ~24 файлах, из них тесты ~550; рисковых путей два (scripts/connect_claude.sh, src/core/grant/grants.ts) — «Подписываю» на план by=human:anton at=2026-10-19
- **new_dependency:** none
- **runtime_paths:** scripts/connect_claude.sh,src/core/grant/grants.ts
  <!-- конфиги Claude Code владельца (~/.claude.json, settings.json, CLAUDE.md) и файлы разрешений в ~/.gconnect: отказ виден только живьём; список уточнит план -->
- **irreversible_surfaces:** none reason=подключение и отключение пишут конфиги Claude Code с резервной копией в ~/.claude/backups/ и откатываются ею; разрешения живут до 23:59 и открываются заново касанием
- **model_surface:** src/policy/rules.md,src/mcp/tools.ts,src/mcp/unlock-tool.ts,src/mcp/grant-tool.ts
  <!-- агенту уйдут: профиль сервера первой строкой инструкций, свой профиль в gc_targets, строка и фраза с именем профиля; памятка — вне репозитория, правится connect_claude.sh -->
- **rule_enforcers:** src/policy/rules.json
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** no
- **observability:** 1
- **observe_signal:** в сессии видны оба сервера; касание открывает только свой профиль; разрешение и откат одного профиля не трогают другой
- **observe_until:** 2026-12-01
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4
