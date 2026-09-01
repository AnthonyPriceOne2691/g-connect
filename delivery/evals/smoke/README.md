# Durable smoke oracles

Проверки уровня репозитория: команда + ожидание. Гоняются `bash delivery/evals/smoke/run.sh`
и в CI (`quality.yml`). Оракул, который никто не исполняет, неотличим от проходящего.

| ID | Command | Expected | Timeout |
|---|---|---|---|
| S1 | `python3 scripts/delivery_check.py` | exit 0, без errors | 30s |
| S2 | `git ls-files delivery/active/.gitkeep` | непустой вывод | 5s |
| S3 | `git ls-files \| grep -E 'credentials\.json\|token\.json\|^\.env$'` | пустой вывод (секретов в дереве нет) | 5s |
| S4 | `python3 -c "import json; json.load(open('.claude/settings.json'))"` | exit 0 | 5s |
| S5 | `npx vitest run` | exit 0 | 120s |
| S6 | `npx tsc --noEmit` | exit 0 | 120s |
| S7 | `bash scripts/lint/check_gate_coverage.sh` | exit 0 | 30s |
| S8 | резолвер: шесть ступеней на фикстуре | `tests/sheets.test.ts` зелёный по A4/A4b/A4c/A5/A6/A11 | входит в S5 |
| S9 | `bash scripts/lint/check_grep_gate_ts.sh --rule core-no-library` | exit 0: шов с googleapis один | 10s |

S8 не отдельная команда, а именованный набор в сьюте: id примеров живут в спеке
(§3.1d), и тест помечен ими в комментарии — так обещание связано с проверкой.
