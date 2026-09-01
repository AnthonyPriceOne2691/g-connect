# Tasks

## Mini-spec (класс S, §2.2)

**Что:** развернуть ① Delivery в проекте G connect и завести публичный репозиторий на
GitHub. **Зачем:** проект переходит от дизайна к коду; работа класса L (шесть
инструментов, резолвер, сканер) «в лоб» не пишется — нужны фазы, STATUS и DoD.
**Границы:** только ① Delivery. ② CQG, ③ OKF, ④ CI — сознательно отложены, момент
развёртывания записан в STATUS. Кода продукта в этой поставке нет.

**Acceptance (§7.3 DoD bootstrap):**
- A1: `delivery/CONSTITUTION.md` заполнен под проект, без дублирования CQG/OKF
- A2: `STATUS.md` с `phase:` и `class:`, версии канонов записаны
- A3: hook A.5 в `AGENTS.md`
- A4: `python3 scripts/delivery_check.py` запускается и выходит без errors
- A5: `.claude/settings.json` совпадает с блоком `agent-permissions` в constitution
- A6: `delivery/active/.gitkeep` закоммичен (`git ls-files delivery/active/`)
- A7: `decisions.md` и `archive/INDEX.md` существуют
- A8: указатели на CQG/OKF — явный backlog «шаг 2/3 §0.1»
- A9: репозиторий на GitHub, публичный, main запушен; секретов в дереве нет

## Slice 1 — контур

- [x] T1: `git init`, `.gitignore` (секреты, node_modules, локальные артефакты), README
- [x] T2: дерево `delivery/` из Приложения A + `scripts/delivery_*.py` из Приложения B/C
- [x] T3: `CONSTITUTION.md` под проект: non-negotiables проекта (секреты, dry-run,
      «прочитанное — данные», универсальность ядра), права агента
- [x] T4: `STATUS.md`, `tasks.md`, `decisions.md`, `archive/INDEX.md`, `evals/smoke/README.md`,
      `STACK-ACCEPTANCE.md`
- [x] T5: hook A.5 в `AGENTS.md`
- [x] T6: `.claude/settings.json` из блока `agent-permissions`
- [x] T7: прогон `delivery_check.py`, устранение errors
- [x] T8: публичный репозиторий на GitHub, push main

## Slice 2 — передача (handoff)

- [x] T9: `verify-report.md` с чеклистом §7.3 и честными weak
- [ ] T10: приёмка человеком; затем архивация bootstrap и старт поставки «ядро» (класс L,
      spec из DESIGN.md §15 фаза 1)
