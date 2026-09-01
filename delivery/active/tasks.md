# Tasks

Уроки из архива (§2.2a): **L1** — гейты в свежем репозитории проверяют согласованность
заявлений, а не код. Применимо здесь напрямую: любое объявление в STATUS (`new_dependency`,
`runtime_paths`) должно совпадать с тем, что реально появилось в дереве, иначе первый же
прогон это назовёт.

## Slice 1 — каркас и фундамент без сети

- [ ] T1: `package.json` (Node 24, ESM, `type: module`), `tsconfig.json` (strict), `vitest.config.ts`
- [ ] T2: `src/core/errors.ts` — классы §13.7, поля `code/title/detail/cause/retryable/action/correlationId`
- [ ] T3: `src/core/profiles.ts` — раскладка `~/.gconnect/<account>/`, чтение credentials/token, права 600, `no_profile`
- [ ] T4: `src/core/retry.ts` — backoff на 429/5xx, порт из `run.js`
- [ ] T5: `src/core/targets.ts` — alias/URL/ID → `{id, type}`; тип по URL
- [ ] T6: тесты слайса 1 + A12 (нет профиля → `no_profile` с action)

## Slice 2 — Sheets и резолвер на моках

- [ ] T7: `src/core/sheets/client.ts` — интерфейс `SheetsClient` + фейк для тестов с фикстурой спеки
- [ ] T8: `src/core/sheets/map.ts` — листы, `usedRange`, автоопределение `headerRow`, профиль колонок (типы, enum из `dataValidation`, формульные, protected) → A1
- [ ] T9: `src/core/resolver.ts` — шесть ступеней для имён колонок → A4, A5, A6, A11
- [ ] T10: `src/core/values.ts` — нормализация значений по типу колонки → A7, A8, A9
- [ ] T11: `src/core/ops.ts` — zod-схема операций, `dryRun`-план, `expectRevision`
- [ ] T12: `src/core/sheets/rows.ts` — `appendRow` / `upsertRow` / `setCells` → A2, A3, A10
- [ ] T13: тест «в коде нет имён листов и колонок» (грепом по `src/`)

## Slice 3 — реальный путь

- [ ] T14: `src/core/auth.ts` — OAuth, redirect `127.0.0.1:3333`, refresh, сообщение про смену scopes
- [ ] T15: склейка с настоящим `googleapis`, ручной прогон на тестовой таблице
- [ ] T16: `verify-report.md` — блок «Исполнение рисковых путей» по `auth.ts` и `profiles.ts`
- [ ] T17: оракулы S5–S7 в `evals/smoke/README.md` включены и прогнаны
