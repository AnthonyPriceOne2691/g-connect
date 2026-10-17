#!/usr/bin/env bash
# Стабильная сборка сервера G connect — её запускают сессии Claude Code во ВСЕХ проектах
# машины (поставка cross-project, T1; примеры X11, X12).
#
# Сборка берётся из КОММИТА (по умолчанию `main`) через `git archive`, а не из рабочего
# дерева: незакоммиченная правка и рабочая ветка в неё не попадают по построению, и
# соседние сессии не меняют поведения, пока установка не выполнена (X11). Внутри
# репозитория G connect работает dev-сборка `dist/` — её ставит запись области local
# (`connect_claude.sh`): неодобренная проектная `.mcp.json` уступает пользовательской
# записи, замер 2026-10-17 (X12, урок L33).
#
# Живёт ВНЕ репозитория — в `~/Library/Application Support/g-connect/`. Внутри (`.stable/`
# под `.gitignore`) её читали проверки, обходящие дерево мимо git: детектор §3.4a нашёл в
# копии скриптов контура свой же список отправителей писем и потребовал объявить
# «отправку наружу» (замер 2026-10-17).
#
# Переключение — только при зелёной пробе. Новая сборка собирается в `stable-next/`, проба
# судит СОБРАННЫЙ сервер по протоколу дважды — после сборки и после
# `npm prune --omit=dev`, то есть ровно то, что поедет, — и лишь тогда `stable/` уезжает в
# `stable-prev/`, а новая встаёт на её место. Красная проба — `stable/` не тронут.
# Работающие сессии держат прежний процесс сервера: новая сборка берётся при следующем
# его запуске (новая сессия или `/mcp` → reconnect).
#
# Usage:
#   scripts/install_stable.sh              # собрать main и переключить
#   scripts/install_stable.sh <ref>        # собрать другой коммит
#   scripts/install_stable.sh --rollback   # вернуть прежнюю сборку
#   scripts/install_stable.sh --status     # какая сборка стоит
#   scripts/install_stable.sh --path       # путь к серверу стабильной сборки
# Каталог переопределяется GCONNECT_STABLE_HOME.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
HOME_DIR=${GCONNECT_STABLE_HOME:-"$HOME/Library/Application Support/g-connect"}
STABLE="$HOME_DIR/stable"
NEXT="$HOME_DIR/stable-next"
PREV="$HOME_DIR/stable-prev"
SWAP="$HOME_DIR/stable-swap"

red=$(printf '\033[31m'); green=$(printf '\033[32m'); reset=$(printf '\033[0m')
die() { printf '%sinstall_stable: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }
built() { cat "$1/.stable-commit" 2>/dev/null || echo "(неизвестно)"; }

case "${1:-}" in
  --path)
    printf '%s\n' "$STABLE/dist/mcp/server.js"
    exit 0 ;;
  --status)
    [[ -d "$STABLE" ]] || die "стабильной сборки нет — scripts/install_stable.sh"
    printf 'стабильная: %s\nпрежняя:    %s\nкаталог:    %s\n' "$(built "$STABLE")" \
      "$([[ -d "$PREV" ]] && built "$PREV" || echo нет)" "$HOME_DIR"
    exit 0 ;;
  --rollback)
    [[ -d "$PREV" ]] || die "прежней сборки нет (stable-prev) — откатывать не на что"
    [[ -d "$STABLE" ]] || die "текущей сборки нет — откатывать нечего"
    rm -rf "$SWAP"
    mv "$STABLE" "$SWAP" && mv "$PREV" "$STABLE" && mv "$SWAP" "$PREV"
    printf '%sоткат: стабильная — %s%s\n' "$green" "$(built "$STABLE")" "$reset"
    exit 0 ;;
esac

REF=${1:-main}
SHA=$(git rev-parse --verify --quiet "$REF^{commit}") || die "нет коммита '$REF'"

rm -rf "$NEXT"
mkdir -p "$NEXT"
git archive "$SHA" | tar -x -C "$NEXT"
printf '%s %s\n' "$SHA" "$REF" > "$NEXT/.stable-commit"

printf 'install_stable: %s (%s) → сборка в %s\n' "${SHA:0:12}" "$REF" "$NEXT"
( cd "$NEXT" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent ) \
  || die "сборка не удалась — переключения не было, stable не тронут"

probe() {
  ( cd "$NEXT" && node scripts/probe_mcp.mjs ) \
    || die "проба $1 красная — переключения не было, stable не тронут; сборка оставлена в stable-next для разбора"
}
probe "собранного сервера"
( cd "$NEXT" && npm prune --omit=dev --no-audit --no-fund --loglevel=error ) \
  || die "npm prune не удался — переключения не было, stable не тронут"
probe "после prune (то, что поедет)"

rm -rf "$PREV"
[[ -d "$STABLE" ]] && mv "$STABLE" "$PREV"
mv "$NEXT" "$STABLE"
printf '%sстабильная сборка: %s (%s) — %s%s\n' "$green" "${SHA:0:12}" "$REF" \
  "$STABLE/dist/mcp/server.js" "$reset"
printf 'Работающие сессии подхватят её при следующем запуске сервера (/mcp → reconnect).\n'
