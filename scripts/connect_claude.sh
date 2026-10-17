#!/usr/bin/env bash
# Подключить G connect ко ВСЕМ проектам Claude Code на этой машине (поставка cross-project,
# T12, пример X1). Cursor и Codex не трогаются — решение владельца 2026-10-17.
#
# Что ставит, и всё — с резервной копией в ~/.claude/backups/g-connect-<время>/:
#   1. сервер уровня пользователя `g-connect` → стабильная сборка (scripts/install_stable.sh);
#      внутри репозитория G connect проектная `.mcp.json` выше по приоритету — там dev (X12);
#   2. правило `mcp__g-connect__*` в permissions.allow ~/.claude/settings.json — инструменты
#      зовутся без запроса прав (X1); запись всё равно идёт через превью, журнал и откат;
#   3. памятку агентам в ~/.claude/CLAUDE.md — блоком между метками, повторный запуск его
#      заменяет, а не дублирует.
#
# Usage:
#   scripts/connect_claude.sh                     # показать, что изменится (ничего не пишет)
#   scripts/connect_claude.sh --apply             # подключить
#   scripts/connect_claude.sh --disconnect        # показать, что снимется
#   scripts/connect_claude.sh --disconnect --apply
# Для проверки на временном каталоге: CLAUDE_HOME (вместо ~/.claude), CLAUDE_JSON (вместо
# ~/.claude.json), CLAUDE_BIN (вместо `claude`).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
CLAUDE_HOME=${CLAUDE_HOME:-"$HOME/.claude"}
CLAUDE_JSON=${CLAUDE_JSON:-"$HOME/.claude.json"}
CLAUDE_BIN=${CLAUDE_BIN:-claude}
SETTINGS="$CLAUDE_HOME/settings.json"
MEMO="$CLAUDE_HOME/CLAUDE.md"
RULE='mcp__g-connect__*'
NAME='g-connect'

MODE=connect
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --disconnect) MODE=disconnect ;;
    *) printf 'connect_claude: неизвестный аргумент %s\n' "$arg" >&2; exit 2 ;;
  esac
done

red=$(printf '\033[31m'); green=$(printf '\033[32m'); reset=$(printf '\033[0m')
die() { printf '%sconnect_claude: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

SERVER=$(bash "$ROOT/scripts/install_stable.sh" --path)
NODE=$(command -v node) || die "нет node в PATH"
[[ "$MODE" == disconnect || -f "$SERVER" ]] \
  || die "стабильной сборки нет ($SERVER) — сначала scripts/install_stable.sh"

# Правки JSON и памятки — одним помощником на python: тот же разбор в показе и в записи.
edit() { python3 "$ROOT/scripts/connect_claude_edit.py" "$@"; }

if [[ "$APPLY" == 0 ]]; then
  printf 'connect_claude (%s, показ — ничего не пишу):\n' "$MODE"
  printf '  сервер:  %s %s\n' "$NODE" "$SERVER"
  edit status "$SETTINGS" "$MEMO" "$RULE"
  printf 'Сделать: scripts/connect_claude.sh%s --apply\n' "$([[ "$MODE" == disconnect ]] && echo ' --disconnect')"
  exit 0
fi

BACKUP="$CLAUDE_HOME/backups/g-connect-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
for f in "$SETTINGS" "$MEMO" "$CLAUDE_JSON"; do
  [[ -f "$f" ]] && cp -p "$f" "$BACKUP/"
done
printf 'резервные копии: %s\n' "$BACKUP"

"$CLAUDE_BIN" mcp remove "$NAME" --scope user >/dev/null 2>&1 || true
if [[ "$MODE" == connect ]]; then
  "$CLAUDE_BIN" mcp add --scope user --transport stdio --env GCONNECT_ACCOUNT=default \
    "$NAME" -- "$NODE" "$SERVER" >/dev/null || die "claude mcp add не удался — откат из $BACKUP"
  edit connect "$SETTINGS" "$MEMO" "$RULE"
  printf '%sG connect подключён: новые сессии Claude Code в любом проекте видят mcp__g-connect__*.%s\n' \
    "$green" "$reset"
else
  edit disconnect "$SETTINGS" "$MEMO" "$RULE"
  printf '%sG connect отключён: сервер уровня пользователя, правило и памятка сняты.%s\n' \
    "$green" "$reset"
fi
