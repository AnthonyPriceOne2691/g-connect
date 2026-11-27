# Live run — подпись окна Touch ID (2026-11-27)

Сборка ветки `feat/finger-window` (`0067365`, `npm run build`, `probe_mcp` зелёный), вызов своим
процессом сервера — `scripts/gc_call.mjs`. Перед каждым окном владельцу объявлены строка
`unlockLine` и имя окна; уговор — касаться, только если окно названо именно так.

| id | Что | Итог |
|---|---|---|
| J1 | `GCONNECT_ACCOUNT=work gc_unlock` — окно «G connect (work) needs to authenticate to continue» | касание через 8,6 с, `unlocked`; в `~/.gconnect/work/finger` — ровно копия «G connect (work)» (299 664 байт, клон плагина) и прокладка, всё 700 |
| J1 | `gc_unlock` личного профиля — окно «G connect needs to authenticate to continue» | касание через 5,4 с, `unlocked` |

Google открывался только в процессе прогона и закрылся вместе с ним. Пробное касание `gc seal` —
тем же швом, живьём не проверялось (нужен новый вход); окно разрешения проекта (Secretive) — вне
поставки.
