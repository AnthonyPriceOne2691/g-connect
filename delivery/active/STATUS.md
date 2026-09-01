# Active delivery status

- **slug:** bootstrap-delivery-contour
- **stack:** delivery@1.84, cqg@absent, okf@absent
- **class:** S
- **kind:** bootstrap
- **repro_test:** n/a reason=kind=bootstrap, не багфикс
- **diagnosis:** n/a reason=kind=bootstrap, дефекта не разбирали
- **phase:** verify
- **builder:** agent:claude-opus-5
- **verifier:** human:anton
- **human_ok_spec:** n/a reason=class=S, mini-spec живёт в tasks.md (§2.2)
- **human_ok_plan:** n/a reason=class=S
- **shape-oracles:** weak
- **behavior-oracles:** weak reason=кода продукта ещё нет; дёшево и не сделано — тестов нет, потому что нет модулей. Контур проверяется delivery_check и чеклистом §7.3
- **artifact_oracle:** n/a reason=проект пока ничего не собирает; TS-сборка появится в фазе 1
- **ci-oracles:** weak
- **worktree:** none (S)
- **hooks:** not-deployed
- **blockers:** none
- **waivers:** none
- **new_dependency:** none
- **runtime_paths:** none reason=контур — markdown и python-проверки; путей, чей отказ не виден ни сборке, ни тестам, в нём нет. При появлении Google-API появятся: OAuth-вход, запись в живой документ
- **model_surface:** n/a reason=продукт пока не вызывает модель; поверхность появится вместе с рецептами (DESIGN.md §13, §14)
- **canon_drift_waiver:** no
- **baseline_growth_waiver:** no
- **observability:** 1
- **observe_signal:** delivery_check зелёный на чистом клоне + чеклист §7.3 закрыт целиком + следующая поставка (ядро, класс L) стартует с непустым spec из DESIGN.md
- **observe_until:** 2026-09-15
- **circuit_breakers:** defaults from AGENT_DELIVERY_HARNESS.md §3.4 (kind=bootstrap: объём breaker'ом не мерится, §3.4)

## Развёрнуто и что осталось

| Слой | Состояние | Момент развёртывания |
|---|---|---|
| ① Delivery | deployed | сейчас |
| ② CQG + гейт мержа | absent | конец фазы 1 (есть core — ратчету есть что мерить) |
| ③ OKF | absent | после фазы 2 (модули устоялись) |
| ④ CI | absent | вместе с ② |

Почему не всё сразу: на нуле кода гейты CQG просматривают ноль файлов и выходят
зелёными — ровно тот фальшивый зелёный, против которого канон и написан
(AGENT_STACK §2 A′ п.1). Решение записано в `decisions.md`.
