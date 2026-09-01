# AGENTS.md — G connect

**Первым делом в новой сессии:** прочитай [MEMORY.md](MEMORY.md) — там текущее состояние,
открытые хвосты и gotchas. Затем [DESIGN.md](DESIGN.md) и `delivery/active/STATUS.md`.

Проект: универсальное ядро доступа агента к Google Docs / Sheets / Drive и локальным
папкам, с MCP- и CLI-фасадами. Дизайн-решения — [DESIGN.md](DESIGN.md) (источник правды:
любое изменение архитектуры = правка дизайна в том же коммите). Общение — по-русски.

## Canon stack / Agent Delivery Harness

- **Start here:** `AGENT_STACK.md` (order: Delivery → CQG → OKF).
  ⚠ Каноны лежат **вне репозитория**, в `Prepare/` — вариант выбирается на шаге ② CQG
  (AGENT_STACK §7.1); текущее состояние и следствия: `delivery/STACK-ACCEPTANCE.md`.
- Process canon: `AGENT_DELIVERY_HARNESS.md`.
- Active delivery: `delivery/active/STATUS.md` — read before coding.
- **Order:** follow delivery phases. Do not oneshot large work.
- **Done:** only when verify oracles pass; never declare done on red.
- Prefer git worktree for class M/L (Delivery §5.1).
- Smoke/evals: `delivery/evals/smoke/` + `active/eval-smoke.md` (Delivery §6).
- Metrics on handoff: Delivery §9 / A.10 (`scripts/delivery_metrics.py`).
- Hooks if deployed: Delivery §10.
- Skills/prompts: no inline prompts (CQG).
- Do **not** duplicate code-quality rules here — use `CODE_QUALITY_GATES.md` if present.
- Do **not** invent domain canon — use `knowledge/` / OKF if present.
- Deploy order for missing layers: Delivery → CQG → OKF (see `AGENT_STACK.md`).

## Развёрнуто на сегодня

- ① Delivery — да. ② CQG — нет (шаг 2 §0.1 в backlog, момент: конец фазы 1).
  ③ OKF — нет (момент: после фазы 2). ④ CI и гейт мержа — нет.
- Поэтому в STATUS честно стоит `shape-oracles: weak`, `ci-oracles: weak`.

## Гейт перед объявлением done

```bash
python3 scripts/delivery_check.py        # артефакты фазы, права, журналы
```
