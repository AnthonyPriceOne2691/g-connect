#!/usr/bin/env python3
"""Правки пользовательских конфигов Claude Code для G connect (scripts/connect_claude.sh).

Один помощник на показ и на запись: показ, разобравший файлы иначе, чем запись, обещал бы
одно, а делал другое. Правки идемпотентны: правило не дублируется, памятка живёт блоком
между метками и заменяется целиком. Чужие правила и чужой текст не трогаются.

Usage: connect_claude_edit.py status|connect|disconnect <settings.json> <CLAUDE.md> <rule>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BEGIN = "<!-- g-connect:begin (scripts/connect_claude.sh) -->"
END = "<!-- g-connect:end -->"

MEMO = f"""{BEGIN}
## G connect — таблицы, документы и Drive Google

Инструменты `mcp__g-connect__*` есть в каждом проекте: `gc_targets` (что доступно и открыт
ли G connect для этого проекта), `gc_read` (карта `mode: "map"`, значения, текст),
`gc_search`, `gc_scan`, `gc_apply` (запись: по умолчанию превью), `gc_undo`, `gc_grant`.
Правила целиком — ресурс `policy://rules`.

- Перед правкой — `gc_read` с `mode: "map"`; адресуй по именам колонок, а не по A1.
- Запись вне реестра — по разрешению проекта. Ответ `needs_grant` — скажи владельцу:
  «скажи „открой G connect“ и приложи палец». `gc_grant` с `action: "open"` — только когда
  он сам об этом попросил: окно Touch ID без просьбы учит касаться не глядя.
- Разрушающее (удаление, массовая замена) — его фразой с названием предмета; код плана
  называет человек, а не ты.
- После записи скажи, что именно записано, и что откат — одной фразой (`gc_undo`).
{END}
"""


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


def status(settings_path: Path, memo_path: Path, rule: str) -> None:
    settings = load_settings(settings_path)
    allowed = rule in settings.get("permissions", {}).get("allow", [])
    memo = memo_path.read_text(encoding="utf-8") if memo_path.exists() else ""
    print(f"  правило:  {rule} — {'есть' if allowed else 'нет'} в {settings_path}")
    print(f"  памятка:  {'есть' if BEGIN in memo else 'нет'} в {memo_path}")


def connect(settings_path: Path, memo_path: Path, rule: str) -> None:
    settings = load_settings(settings_path)
    allow = allow_list(settings)
    if rule not in allow:
        allow.append(rule)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    memo = without_block(memo_path.read_text(encoding="utf-8")) if memo_path.exists() else ""
    memo_path.write_text((memo.rstrip("\n") + "\n\n" if memo.strip() else "") + MEMO, encoding="utf-8")


def disconnect(settings_path: Path, memo_path: Path, rule: str) -> None:
    if settings_path.exists():
        settings = load_settings(settings_path)
        allow = settings.get("permissions", {}).get("allow")
        if isinstance(allow, list) and rule in allow:
            allow.remove(rule)
            settings_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if memo_path.exists():
        memo_path.write_text(without_block(memo_path.read_text(encoding="utf-8")), encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 5 or sys.argv[1] not in {"status", "connect", "disconnect"}:
        raise SystemExit(__doc__)
    action, settings, memo, rule = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
    {"status": status, "connect": connect, "disconnect": disconnect}[action](settings, memo, rule)


if __name__ == "__main__":
    main()
