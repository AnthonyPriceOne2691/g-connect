# Durable smoke oracles

Проверки уровня репозитория: команда + ожидание. Пока продукта нет, оракулы — на контур;
с фазы 1 сюда добавляются оракулы ядра (см. DESIGN.md §15, критерии MVP).

| ID | Command | Expected | Timeout |
|---|---|---|---|
| S1 | `python3 scripts/delivery_check.py` | exit 0, без errors | 30s |
| S2 | `git ls-files delivery/active/.gitkeep` | непустой вывод | 5s |
| S3 | `git ls-files \| grep -E 'credentials\.json\|token\.json\|\.env$'` | пустой вывод (секретов в дереве нет) | 5s |
| S4 | `python3 -c "import json,sys; json.load(open('.claude/settings.json'))"` | exit 0 | 5s |

Планируется с фазы 1 (не выдумывать раньше кода):

| ID | Command | Expected |
|---|---|---|
| S5 | `npm test` | exit 0 |
| S6 | `npm run build` | exit 0, `dist/mcp/server.js` существует |
| S7 | резолвер: 6 ступеней на фикстуре таблицы | ok / preview / needs_clarification по ожиданию |

Optional: `run.sh` прогоняет ID по порядку и выходит 1 на первом падении.
