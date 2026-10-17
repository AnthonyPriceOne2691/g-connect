# Active delivery status

- **slug:** cross-project
- **stack:** delivery@2.01, cqg@2.56, okf@absent
- **class:** L
- **kind:** feature
- **repro_test:** n/a reason=kind=feature
- **diagnosis:** n/a reason=kind=feature
- **phase:** verify
- **builder:** agent:claude-opus-5-5
- **verifier:** human:anton
- **human_ok_spec:** yes (by=human:anton, at=2026-10-17) reason=ответ «Подписываю» на вопрос с вариантами, спека и план предъявлены вместе; решения владельца в спеке: «всё своё на срок», срок до 23:59 местного, Secretive и Touch ID, клиент только Claude Code
- **human_ok_plan:** yes (by=human:anton, at=2026-10-17) reason=тот же ответ «Подписываю»; слайсы от изолированного к связующему, отклонённые альтернативы перечислены в plan.md
- **shape-oracles:** cqg-deployed
- **behavior-oracles:** tests-present (610 тестов; тесты инструментов — через настоящий протокол)
- **artifact_oracle:** scripts/probe_mcp.mjs reason=судит СОБРАННЫЙ сервер по протоколу — в CI на каждом PR; для стабильной сборки — та же проба на .stable/dist перед переключением (T1)
- **ci-oracles:** tooling
- **worktree:** ветка feat/cross-project reason=класс L (§5.1); мерж только через merge_guard.sh, за ним contour_doctor
- **parallel_sessions:** merge-guard
- **hooks:** not-deployed reason=OKF не развёрнут (okf@absent)
- **blockers:** none
- **waivers:** max_files_touched=46 max_loc_diff=2452 max_runtime_paths=3 reason=поставка цельная: подпись разрешения, право записи по нему, gc_grant, таблица со шапкой и подключение к Claude Code держатся друг за друга; замер разреза показал, что первая часть всё равно 43 файла и 2170 строк — слово владельца в сессии 2026-10-17 («Одна поставка, waiver») by=human:anton at=2026-10-17
- **runtime_paths:** src/core/grant*.ts,scripts/install_stable.sh,scripts/connect_claude.sh
  <!-- окно Touch ID из дочернего процесса сервера через агента Secretive, ssh-keygen -Y sign/verify, запись в конфиги Claude Code уровня пользователя: отказ виден только живьём (слайс 7) -->
- **irreversible_surfaces:** none reason=записи в Google идут через превью, журнал и откат, удаление — в корзину; правка ~/.claude/settings.json и ~/.claude/CLAUDE.md — скриптом с резервной копией и согласием владельца; писем и доступа по ссылке поставка не добавляет
- **model_surface:** src/policy/rules.md,src/policy/rules.json,src/mcp/apply-schema.ts
  <!-- агенту уйдут: седьмой инструмент gc_grant, отказ needs_grant с действием для человека, правила записи по разрешению; памятка в ~/.claude/CLAUDE.md — вне репозитория, правится скриптом connect_claude.sh -->
- **rule_enforcers:** src/policy/rules.json
  <!-- реестр «правило → enforced_in» с пробами; указатели проверяются тестами policy -->
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** no
- **observability:** 1
- **observe_signal:** из соседнего проекта запись без касания отказывает needs_grant, после касания проходит до 23:59 только в этом проекте; поддельный файл разрешения не принимается
- **observe_until:** 2026-12-01
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4
