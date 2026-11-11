# Active delivery status

- **slug:** long-sheets
- **stack:** delivery@2.06, cqg@2.69, okf@absent
- **class:** M
- **kind:** bugfix
- **repro_test:** tests/long-sheets.test.ts reason=Q4/Q5 на листе в 600 строк — красный на коде до починки: appendRow целится в 501-ю, upsertRow не находит ключ ниже 500-й
- **diagnosis:** getSpreadsheet с названным листом читает A1:ZZ500 (read.max-rows), и на этом обрезанном снимке считаются граница данных appendRow, поиск ключа upsertRow и предусловие assertBeforeValues — строка 501 видится пустой; gc_read values считает truncated по уже обрезанному ответу; фейк Google в тестах обрезку не моделировал
- **phase:** verify
- **builder:** agent:claude-opus-5-5
- **verifier:** human:anton
- **human_ok_spec:** yes (by=human:anton, at=2026-10-19) reason=ответы «Всё сразу» (чтение) и «Да, запись первой» (объём Q1–Q7) на вопросы с вариантами; примеры — в вопросах; Q8–Q10 — ответ «Починить класс сейчас»; Q11–Q15 — ответ «Всё — в PR #9» (примеры — в описании варианта); Q16–Q19 — ответ «Всё, отдельным PR #11»; Q20–Q22 — ответ «Сейчас третьим агентом, PR #12»; Q23–Q26 — ответ «Заметки сейчас, комментарии следом»; Q27–Q32 — ответ «Да, хотфикс PR #14 сейчас»; Q33–Q35 — ответ «Хотфикс PR #15 сейчас»; Q36–Q38 — ответ «да» на предложение PR #16 и выбор «withFormat с пустыми строками»; Q39 и Q41 — ответы «setCells по rows» и «Сброс numberFormat»; Q40 — ответ «Явный ключ «(A)»»; Q42 — выбор «Вид как у строки N» (мелочи, все три); Q43–Q44 — ответ «бери» (2026-10-21); Q45–Q48 — ответы «Да, новый файл и замена», «Из папки проекта сессии», «Свежая версия по имени» и слова «не плодим копии» (2026-11-09); Q49–Q52 — слова владельца «хотфиксом нужно реализовать срочно», «создай лист, сделай там шапку, занеси данные. И просто создай лист и внеси данные… с A1 вниз» (2026-11-11)
- **human_ok_plan:** yes (by=human:anton, at=2026-10-19) reason=ответ «Подписываю» на вопрос с вариантами: план из семи слайсов, отклонённые альтернативы в plan.md; слайсы 8–9 — «В PR #9 к длинным листам»; слайсы 10–13 — «Всё — в PR #9» и слова «выделяй сразу два-три агента»; слайсы 14–15 — «Всё, отдельным PR #11» (два агента параллельно); слайсы 27–30 — «Перейти на zod 4 сейчас» и слова «можешь для скорости запускать параллельных агентов» (2026-11-09); слайсы 31–32 — «можешь запустить пару параллельных агентов» (2026-11-11)
- **shape-oracles:** cqg-deployed
- **behavior-oracles:** tests-present (1281 тест на PR #23; инструменты — через настоящий протокол)
- **artifact_oracle:** scripts/probe_mcp.mjs reason=судит СОБРАННЫЙ сервер по протоколу — в CI на каждом PR и перед переключением стабильной сборки
- **ci-oracles:** tooling
- **worktree:** ветка fix/long-sheets reason=класс M (§5.1); мерж только через merge_guard.sh, за ним contour_doctor
- **parallel_sessions:** merge-guard
- **hooks:** not-deployed reason=OKF не развёрнут (okf@absent)
- **blockers:** none
- **waivers:** max_loc_diff=17000 max_files_touched=110 reason=ответ «Одним мержем: 17000/110» на вопрос с вариантами — мерж поставки long-sheets целиком (PR #9–#23) в main одним squash через merge_guard: 16 684 строки чистого прироста, 109 файлов кода относительно main (lockfile, снимок deps-audit, delivery/ и workflow не в счёте); пределы отдельных PR — в spec.md «Решения владельца» by=human:anton at=2026-11-11
- **new_dependency:** none
- **runtime_paths:** src/core/google/
  <!-- шов Google целиком: размер листа из метаданных, диапазон '<лист>', окно строк, маски полей вида (сброс null), копия формата строки, локаль книги; загрузка Drive — сессия resumable, 308 и Range, поля ответа последнего куска, ревизии на общем диске, точность name = в q — отказ виден только живьём -->
- **irreversible_surfaces:** none reason=загрузка на Диск (D-27) — с откатом: новый файл в корзину, замена — прежней ревизией, закреплённой до замены; запись по-прежнему через превью, предусловие и журнал с откатом; поставка убирает затирание, а не добавляет запись; вид ячеек — тоже с откатом (вид дописанной строки после отката остаётся на пустой строке — названо)
- **model_surface:** src/policy/rules.md,src/policy/rules.json,src/mcp/tools.ts,src/mcp/read-values.ts,src/core/ops.ts,src/core/format-fields.ts,src/mcp/apply-schema.ts,src/core/sheets/notes.ts,src/core/sheets/bounds.ts,src/core/sheets/sheet-choice.ts,src/mcp/target-arg.ts,src/core/sheets/unlabeled-key.ts,src/core/sheets/format-source.ts,src/core/upload/upload-schema.ts,src/core/upload/upload-plan.ts,src/core/upload/local-file.ts,src/mcp/run-upload.ts,src/core/error-catalog.ts
  <!-- агенту уйдут: fromRow, truncated с sheetRows и nextFromRow, предупреждение карты о части листа, отказ write.full-sheet; withFormat и formats, поля вида fontFamily/fontSize/numberFormat, allRows и rows у formatCells, заметки о виде дат и оформлении дописанной строки; uploadFile (localPath, name, replace), ответ file со ссылкой, отказы загрузки, storage_full, заголовок и описание gc_apply -->
- **rule_enforcers:** src/policy/rules.json
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** reason=ответ «Поднять снимок до 19» на вопрос с вариантами — deps_audit_baseline.txt js_total 4 → 38 (19 moderate: гейт считает их дважды); после zod 4 high нет, исправления в наших диапазонах нет — 6 в рабочей сборке (googleapis → gaxios → rimraf → glob → minimatch, путь не вызывается), 13 в инструментах разработки by=human:anton at=2026-11-09
- **observability:** 1
- **observe_signal:** запись на листах длиннее 500 строк попадает после последней строки и в строку ключа; gc_read отдаёт лист целиком или честно говорит, с какой строки продолжить; строки, дописанные в «Реестр инфраструктуры», — шрифтом соседних, первые даты в пустых колонках — видом листа; гайды и ролики сессии parsing-and-outri-4a ложатся на общий диск свежей версией с той же ссылкой, без копий
- **observe_until:** 2026-12-01
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4
