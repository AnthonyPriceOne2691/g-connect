# Active delivery status

- **slug:** long-sheets
- **stack:** delivery@2.06, cqg@2.69, okf@absent
- **class:** M
- **kind:** bugfix
- **repro_test:** tests/long-sheets.test.ts reason=Q4/Q5 на листе в 600 строк — красный на коде до починки: appendRow целится в 501-ю, upsertRow не находит ключ ниже 500-й
- **diagnosis:** getSpreadsheet с названным листом читает A1:ZZ500 (read.max-rows), и на этом обрезанном снимке считаются граница данных appendRow, поиск ключа upsertRow и предусловие assertBeforeValues — строка 501 видится пустой; gc_read values считает truncated по уже обрезанному ответу; фейк Google в тестах обрезку не моделировал
- **phase:** implement
- **builder:** agent:claude-opus-5-5
- **verifier:** human:anton
- **human_ok_spec:** yes (by=human:anton, at=2026-10-19) reason=ответы «Всё сразу» (чтение) и «Да, запись первой» (объём Q1–Q7) на вопросы с вариантами; примеры — в вопросах; Q8–Q10 — ответ «Починить класс сейчас»
- **human_ok_plan:** yes (by=human:anton, at=2026-10-19) reason=ответ «Подписываю» на вопрос с вариантами: план из семи слайсов, отклонённые альтернативы в plan.md; слайсы 8–9 — «В PR #9 к длинным листам»; объём — waiver ниже
- **shape-oracles:** cqg-deployed
- **behavior-oracles:** tests-present (737 тестов; инструменты — через настоящий протокол)
- **artifact_oracle:** scripts/probe_mcp.mjs reason=судит СОБРАННЫЙ сервер по протоколу — в CI на каждом PR и перед переключением стабильной сборки
- **ci-oracles:** tooling
- **worktree:** ветка fix/long-sheets reason=класс M (§5.1); мерж только через merge_guard.sh, за ним contour_doctor
- **parallel_sessions:** merge-guard
- **hooks:** not-deployed reason=OKF не развёрнут (okf@absent)
- **blockers:** none
- **waivers:** max_loc_diff=1600 max_files_touched=30 reason=ответ «Да: 1600 строк, 30 файлов» на вопрос с вариантами; после ответа «Разделить на два PR» здесь — Q1–Q10 (909 строк, 18 файлов), Q11–Q15 — PR #10 поверх by=human:anton at=2026-10-19
- **new_dependency:** none
- **runtime_paths:** src/core/google/sheets.ts
  <!-- шов Google: размер листа из метаданных, диапазон '<лист>' целиком, окно строк — отказ виден только живьём -->
- **irreversible_surfaces:** none reason=запись по-прежнему через превью, предусловие и журнал с откатом; поставка убирает затирание, а не добавляет запись
- **model_surface:** src/policy/rules.md,src/policy/rules.json,src/mcp/tools.ts
  <!-- агенту уйдут: fromRow, truncated с sheetRows и nextFromRow, предупреждение карты о части листа, отказ write.full-sheet -->
- **rule_enforcers:** src/policy/rules.json
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** no
- **observability:** 1
- **observe_signal:** запись на листах длиннее 500 строк попадает после последней строки и в строку ключа; gc_read отдаёт лист целиком или честно говорит, с какой строки продолжить
- **observe_until:** 2026-12-01
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4
