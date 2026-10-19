#!/usr/bin/env python3
"""Правки пользовательских конфигов Claude Code для G connect (scripts/connect_claude.sh).

Один помощник на показ и на запись: показ, разобравший файлы иначе, чем запись, обещал бы
одно, а делал другое. Правки идемпотентны: правило не дублируется, памятка живёт блоком
между метками и заменяется целиком. Чужие правила и чужой текст не трогаются.

Профили (D-25): сервер на профиль, пары «профиль=сервер» называет connect_claude.sh — правило
имени живёт там и в ядре (src/core/profile-names.ts), тест сверяет оба. Отключение снимает все
серверы G connect: их имена — из правил `mcp__g-connect…__*` в settings.json.

Usage:
  connect_claude_edit.py status|connect <settings.json> <CLAUDE.md> <профиль=сервер>...
  connect_claude_edit.py disconnect <settings.json> <CLAUDE.md>
  connect_claude_edit.py servers <settings.json>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BEGIN = "<!-- g-connect:begin (scripts/connect_claude.sh) -->"
END = "<!-- g-connect:end -->"

MEMO = f"""{BEGIN}
## G connect — таблицы, документы и Drive Google

Инструменты `mcp__g-connect__*` есть в каждом проекте: `gc_targets` (что доступно и открыт
ли G connect для этого проекта), `gc_read` (карта `mode: "map"`, значения, текст),
`gc_search`, `gc_scan`, `gc_apply` (запись: по умолчанию превью), `gc_undo`, `gc_grant`,
`gc_unlock`. Правила целиком — ресурс `policy://rules`.

- С Google — только через эти инструменты: токен под пальцем владельца, сам его не
  расшифровывай и `~/.gconnect` не читай. Ответ `google_locked` — скажи человеку «G connect
  попросит палец, чтобы открыть Google этой сессии на час» и сразу вызови `gc_unlock`; окно
  без такой строки — повод не касаться.
- Перед правкой — `gc_read` с `mode: "map"`; адресуй по именам колонок, а не по A1.
- Запись вне реестра — по разрешению проекта. Ответ `needs_grant` — скажи владельцу:
  «скажи „открой G connect“ и приложи палец». `gc_grant` с `action: "open"` — только когда
  он сам об этом попросил: окно Touch ID без просьбы учит касаться не глядя.
- Разрушающее (удаление, массовая замена) — его фразой с названием предмета; код плана
  называет человек, а не ты.
- После записи скажи, что именно записано, и что откат — одной фразой (`gc_undo`).
{END}
"""


# Правило сервера G connect в settings.json: `mcp__g-connect__*` или `mcp__g-connect-<профиль>__*`.
RULE_RE = re.compile(r"^mcp__(g-connect(?:-[a-z0-9][a-z0-9_-]*)?)__\*$")

SEVERAL = """{begin}
## G connect — таблицы, документы и Drive Google

Инструменты G connect есть в каждом проекте — свой сервер на каждый профиль Google:
{servers}. У каждого: `gc_targets` (профиль сервера, что доступно и открыт ли G connect для
этого проекта), `gc_read` (карта `mode: "map"`, значения, текст), `gc_search`, `gc_scan`,
`gc_apply` (запись: по умолчанию превью), `gc_undo`, `gc_grant`, `gc_unlock`. Правила
целиком — ресурс `policy://rules`.

- Профиль — по файлу: чей аккаунт видит файл, того и сервер. Не знаешь, чей файл, —
  спроси человека. Касание, разрешение и откат у каждого профиля свои.
- С Google — только через эти инструменты: токен под пальцем владельца, сам его не
  расшифровывай и `~/.gconnect` не читай. Ответ `google_locked` — скажи человеку строку из
  этого ответа («G connect попросит палец, чтобы открыть Google этой сессии на час», у
  профиля не default — с его именем: «G connect (work) попросит палец…») и сразу вызови
  `gc_unlock` того же сервера; окно без такой строки — повод не касаться.
- Перед правкой — `gc_read` с `mode: "map"`; адресуй по именам колонок, а не по A1.
- Запись вне реестра — по разрешению проекта. Ответ `needs_grant` — скажи владельцу фразу
  из ответа («скажи „открой G connect“ и приложи палец», у профиля не default — с его
  именем). `gc_grant` с `action: "open"` — только когда он сам об этом попросил: окно
  Touch ID без просьбы учит касаться не глядя.
- Разрушающее (удаление, массовая замена) — его фразой с названием предмета; код плана
  называет человек, а не ты.
- После записи скажи, что именно записано, и что откат — одной фразой (`gc_undo`).
{end}
"""


def rule_of(server: str) -> str:
    return f"mcp__{server}__*"


def memo_for(pairs: list[tuple[str, str]]) -> str:
    """Один личный профиль — памятка слово в слово как до D-25 (W10); иначе — про все."""
    if pairs == [("default", "g-connect")]:
        return MEMO
    servers = ", ".join(f"`{rule_of(server)}` — профиль {profile}" for profile, server in pairs)
    return SEVERAL.format(begin=BEGIN, end=END, servers=servers)


def parse_pairs(raw: list[str]) -> list[tuple[str, str]]:
    pairs = []
    for item in raw:
        profile, sep, server = item.partition("=")
        if not sep or not profile or not RULE_RE.match(rule_of(server)):
            raise SystemExit(f"connect_claude_edit: пара «{item}» не вида профиль=g-connect[-профиль]")
        pairs.append((profile, server))
    return pairs


def our_rules(settings: dict) -> list[str]:
    return [r for r in settings.get("permissions", {}).get("allow", []) if isinstance(r, str) and RULE_RE.match(r)]

def load_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def allow_list(settings: dict) -> list:
    return settings.setdefault("permissions", {}).setdefault("allow", [])


def without_block(text: str) -> str:
    start = text.find(BEGIN)
    if start < 0:
        return text
    end = text.find(END, start)
    if end < 0:
        raise SystemExit(f"connect_claude_edit: в памятке есть {BEGIN}, но нет {END} — правлю руками")
    tail = text[end + len(END):]
    return (text[:start].rstrip("\n") + "\n" + tail.lstrip("\n")).strip("\n") + ("\n" if text.strip() else "")


def status(settings_path: Path, memo_path: Path, pairs: list[tuple[str, str]]) -> None:
    settings = load_settings(settings_path)
    allowed = settings.get("permissions", {}).get("allow", [])
    for _, server in pairs:
        rule = rule_of(server)
        print(f"  правило:  {rule} — {'есть' if rule in allowed else 'нет'} в {settings_path}")
    named = {rule_of(server) for _, server in pairs}
    for extra in (r for r in our_rules(settings) if r not in named):
        print(f"  лишнее:   {extra} — его профиль не в списке; снять все — --disconnect --apply")
    memo = memo_path.read_text(encoding="utf-8") if memo_path.exists() else ""
    print(f"  памятка:  {'есть' if BEGIN in memo else 'нет'} в {memo_path}")


def connect(settings_path: Path, memo_path: Path, pairs: list[tuple[str, str]]) -> None:
    settings = load_settings(settings_path)
    allow = allow_list(settings)
    for _, server in pairs:
        if rule_of(server) not in allow:
            allow.append(rule_of(server))
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    memo = without_block(memo_path.read_text(encoding="utf-8")) if memo_path.exists() else ""
    memo_path.write_text((memo.rstrip("\n") + "\n\n" if memo.strip() else "") + memo_for(pairs), encoding="utf-8")


def disconnect(settings_path: Path, memo_path: Path) -> None:
    if settings_path.exists():
        settings = load_settings(settings_path)
        allow = settings.get("permissions", {}).get("allow")
        ours = our_rules(settings)
        if isinstance(allow, list) and ours:
            settings["permissions"]["allow"] = [r for r in allow if r not in ours]
            settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if memo_path.exists():
        memo_path.write_text(without_block(memo_path.read_text(encoding="utf-8")), encoding="utf-8")


def servers(settings_path: Path) -> None:
    for rule in our_rules(load_settings(settings_path)):
        match = RULE_RE.match(rule)
        if match:
            print(match.group(1))


def main() -> None:
    args = sys.argv[1:]
    action = args[0] if args else ""
    if action in {"status", "connect"} and len(args) >= 4:
        handler = status if action == "status" else connect
        handler(Path(args[1]), Path(args[2]), parse_pairs(args[3:]))
    elif action == "disconnect" and len(args) == 3:
        disconnect(Path(args[1]), Path(args[2]))
    elif action == "servers" and len(args) == 2:
        servers(Path(args[1]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
