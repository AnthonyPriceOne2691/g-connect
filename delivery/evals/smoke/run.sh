#!/usr/bin/env bash
# Прогон продуктовых оракулов по порядку. Выходит 1 на первом падении и печатает,
# что именно упало: «сьют красный» без имени оракула бесполезен на приёмке.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1

FAILED=0
run() {
  local id="$1" description="$2"
  shift 2
  printf '%-4s %s… ' "$id" "$description"
  if output=$("$@" 2>&1); then
    echo "OK"
  else
    echo "FAIL"
    printf '%s\n' "$output" | tail -5 | sed 's/^/       /'
    FAILED=1
  fi
}

run S1 "контур поставки" python3 scripts/delivery_check.py
run S2 "active/.gitkeep в гите" bash -c '[ -n "$(git ls-files delivery/active/.gitkeep)" ]'
run S3 "секретов в дереве нет" bash -c '! git ls-files | grep -qE "credentials\.json|token\.json|^\.env$"'
run S4 "settings.json — валидный JSON" python3 -c "import json; json.load(open('.claude/settings.json'))"
run S5 "тесты" npx vitest run
run S6 "типы" npx tsc --noEmit
run S7 "все гейты подключены" bash scripts/lint/check_gate_coverage.sh
run S9 "шов с googleapis один" env LINT_TS_SRC=src bash scripts/lint/check_grep_gate_ts.sh --rule core-no-library

[ "$FAILED" = "0" ] && echo "smoke: все оракулы зелёные" || echo "smoke: есть красные — см. выше" >&2
exit "$FAILED"
