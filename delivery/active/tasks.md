# Tasks

Уроки из архива (§2.2a): **L1** — гейты в свежем репозитории проверяют согласованность
заявлений, а не код. Применимо здесь напрямую: любое объявление в STATUS (`new_dependency`,
`runtime_paths`) должно совпадать с тем, что реально появилось в дереве, иначе первый же
прогон это назовёт.

## Slice 1 — каркас и фундамент без сети

- [x] T1: `package.json` (Node 24, ESM, `type: module`), `tsconfig.json` (strict), `vitest.config.ts`
- [x] T2: `src/core/errors.ts` — классы §13.7, поля `code/title/detail/cause/retryable/action/correlationId`
- [x] T3: `src/core/profiles.ts` — раскладка `~/.gconnect/<account>/`, чтение credentials/token, права 600, `no_profile`
- [x] T4: `src/core/retry.ts` — backoff на 429/5xx, порт из `run.js`
- [x] T5: `src/core/targets.ts` — alias/URL/ID → `{id, type}`; тип по URL
- [x] T6: тесты слайса 1 + A12 (нет профиля → `no_profile` с action)

### Сделано вне списка (по требованию гейтов)

- [x] CI на GitHub Actions (компенсация §10.4 п.4 по эскалации): `npm ci`, `tsc --noEmit`,
      `vitest run`, `delivery_check`; шаги независимы с `if: always()`
- [x] Реляционные оракулы на fast-check (§6.5): 10 свойств
- [x] Фаза 0: креды скопированы в `~/.gconnect/default/` (700/600), проверено на живом профиле

## Slice 2 — Sheets и резолвер на моках

- [x] T7: `src/core/sheets/client.ts` — интерфейс `SheetsClient` + фейк для тестов с фикстурой спеки
- [x] T8: `src/core/sheets/map.ts` — листы, `usedRange`, автоопределение `headerRow`, профиль колонок (типы, enum из `dataValidation`, формульные, protected) → A1
- [x] T9: `src/core/resolver.ts` — шесть ступеней для имён колонок → A4, A5, A6, A11
- [x] T10: `src/core/values.ts` — нормализация значений по типу колонки → A7, A8, A9
- [x] T11: `dryRun`-план и `expectRevision` — в `sheets/rows.ts` (`ApplyOutcome`, `RowOptions`); zod-схема операций переезжает в фазу 2 к MCP: до внешней границы валидировать нечего, типы TS строже
- [x] T12: `src/core/sheets/rows.ts` — `appendRow` / `upsertRow` / `setCells` → A2, A3, A10
- [x] T13: тест «в коде нет имён листов и колонок» (грепом по `src/`)

## Slice 3 — реальный путь

- [x] T14: `src/core/auth.ts` — OAuth, redirect `127.0.0.1:3333`, refresh, сообщение про смену scopes
- [x] T15a: склейка с настоящим `googleapis` (`core/google/exchanger.ts`, `core/google/sheets.ts`), обвязка `npm run gc` (login/status/map/upsert), живое ЧТЕНИЕ реальной таблицы прошло
- [ ] T15b: живая ЗАПИСЬ — нужна тестовая таблица владельца в `targets.json` с `allow: write` (ждёт человека)
- [ ] T16: `verify-report.md` — блок «Исполнение рисковых путей» по `auth.ts` и `profiles.ts`
- [ ] T17: оракулы S5–S7 в `evals/smoke/README.md` включены и прогнаны
