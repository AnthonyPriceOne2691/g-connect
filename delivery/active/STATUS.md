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
- **human_ok_spec:** yes (by=human:anton, at=2026-10-19) reason=ответы «Всё сразу» (чтение) и «Да, запись первой» (объём Q1–Q7) на вопросы с вариантами; примеры — в вопросах; Q8–Q10 — ответ «Починить класс сейчас»; Q11–Q15 — ответ «Всё — в PR #9» (примеры — в описании варианта); Q16–Q19 — ответ «Всё, отдельным PR #11»; Q20–Q22 — ответ «Сейчас третьим агентом, PR #12»; Q23–Q26 — ответ «Заметки сейчас, комментарии следом»; Q27–Q32 — ответ «Да, хотфикс PR #14 сейчас»; Q33–Q35 — ответ «Хотфикс PR #15 сейчас»; Q36–Q38 — ответ «да» на предложение PR #16 и выбор «withFormat с пустыми строками»; Q39 и Q41 — ответы «setCells по rows» и «Сброс numberFormat»; Q40 — ответ «Явный ключ «(A)»»
- **human_ok_plan:** yes (by=human:anton, at=2026-10-19) reason=ответ «Подписываю» на вопрос с вариантами: план из семи слайсов, отклонённые альтернативы в plan.md; слайсы 8–9 — «В PR #9 к длинным листам»; слайсы 10–13 — «Всё — в PR #9» и слова «выделяй сразу два-три агента»; слайсы 14–15 — «Всё, отдельным PR #11» (два агента параллельно)
- **shape-oracles:** cqg-deployed
- **behavior-oracles:** tests-present (963 теста; инструменты — через настоящий протокол)
- **artifact_oracle:** scripts/probe_mcp.mjs reason=судит СОБРАННЫЙ сервер по протоколу — в CI на каждом PR и перед переключением стабильной сборки
- **ci-oracles:** tooling
- **worktree:** ветка fix/long-sheets reason=класс M (§5.1); мерж только через merge_guard.sh, за ним contour_doctor
- **parallel_sessions:** merge-guard
- **hooks:** not-deployed reason=OKF не развёрнут (okf@absent)
- **blockers:** none
- **waivers:** max_loc_diff=1000 max_files_touched=20 reason=ответ «Разделить на #17 и #18» на вопрос с вариантами (в описании варианта — разрешение на 1000 строк и 20 файлов для PR #18) — PR #18 (Q40: 867 строк чистого прироста, 20 файлов в счёте предела относительно PR #17; с документами поставки — 899 и 26) by=human:anton at=2026-10-20
- **new_dependency:** none
- **runtime_paths:** src/core/google/
  <!-- шов Google целиком: размер листа из метаданных, диапазон '<лист>', окно строк, маски полей вида (сброс null), копия формата строки, локаль книги — отказ виден только живьём -->
- **irreversible_surfaces:** none reason=запись по-прежнему через превью, предусловие и журнал с откатом; поставка убирает затирание, а не добавляет запись; вид ячеек — тоже с откатом (вид дописанной строки после отката остаётся на пустой строке — названо)
- **model_surface:** src/policy/rules.md,src/policy/rules.json,src/mcp/tools.ts,src/mcp/read-values.ts,src/core/ops.ts,src/core/format-fields.ts,src/mcp/apply-schema.ts,src/core/sheets/notes.ts,src/core/sheets/bounds.ts,src/core/sheets/sheet-choice.ts,src/mcp/target-arg.ts,src/core/sheets/unlabeled-key.ts
  <!-- агенту уйдут: fromRow, truncated с sheetRows и nextFromRow, предупреждение карты о части листа, отказ write.full-sheet; withFormat и formats, поля вида fontFamily/fontSize/numberFormat, allRows и rows у formatCells, заметки о виде дат и оформлении дописанной строки -->
- **rule_enforcers:** src/policy/rules.json
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** no
- **observability:** 1
- **observe_signal:** запись на листах длиннее 500 строк попадает после последней строки и в строку ключа; gc_read отдаёт лист целиком или честно говорит, с какой строки продолжить; строки, дописанные в «Реестр инфраструктуры», — шрифтом соседних, первые даты в пустых колонках — видом листа
- **observe_until:** 2026-12-01
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4
