#!/usr/bin/env bash
# Прогон продуктовых оракулов по порядку. Выходит 1 на первом падении и печатает,
# что именно упало: «сьют красный» без имени оракула бесполезен на приёмке.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1

FAILED=0
EXECUTED=0
run() {
  local id="$1" description="$2"
  shift 2
  EXECUTED=$((EXECUTED + 1))
  printf '%-4s %s… ' "$id" "$description"
  if output=$("$@" 2>&1); then
    echo "OK"
  else
    echo "FAIL"
    printf '%s\n' "$output" | tail -5 | sed 's/^/       /'
    FAILED=1
  fi
}

# Артефакт-оракулы (S10, S11) судят СОБРАННЫЙ сервер, а в свежем дереве — worktree
# merge_guard, чистый клон CI — каталога dist нет вовсе: он в .gitignore. Поэтому сборка
# часть прогона, а не предусловие «человек не забыл собрать». Собираем ДВАЖДЫ намеренно:
# именно второй прогон однажды вложил policy в policy, и собранный сервер отдал 14 правил
# из 17 при «успешной» сборке (2026-09-02, из этого родился S10).
run S0 "сборка идемпотентна (два прогона подряд)" bash -c 'npm run build && npm run build'

run S1 "контур поставки" python3 scripts/delivery_check.py
run S2 "active/.gitkeep в гите" bash -c '[ -n "$(git ls-files delivery/active/.gitkeep)" ]'
run S3 "секретов в дереве нет" bash -c '! git ls-files | grep -qE "credentials\.json|token\.json|^\.env$"'
run S4 "settings.json — валидный JSON" python3 -c "import json; json.load(open('.claude/settings.json'))"
run S5 "тесты" npx vitest run
run S6 "типы" npx tsc --noEmit
run S7 "все гейты подключены" bash scripts/lint/check_gate_coverage.sh

# S10 родился из настоящей поломки: `cp -R src/policy dist/policy` на втором прогоне
# вкладывал папку в папку, старая копия оставалась, и собранный сервер отдавал 14 правил
# вместо 17. Сборка «прошла успешно», клиент получал устаревшую политику. Молча.
run S9 "шов с googleapis один" env LINT_TS_SRC=src bash scripts/lint/check_grep_gate_ts.sh --rule core-no-library

run S10 "политика в dist совпадает с src" bash -c '
  [ ! -d dist/policy/policy ] || { echo "dist/policy/policy: cp вложил папку в папку"; exit 1; }
  diff -q src/policy/rules.json dist/policy/rules.json || exit 1
  diff -q src/policy/rules.md dist/policy/rules.md || exit 1'

# S11 гоняет собранный сервер по протоколу: «библиотека компилируется» не значит «сервер
# отвечает клиенту». Живой режим (--live) требует профиля и в общий прогон не входит.
run S11 "сервер из dist говорит по протоколу" node scripts/probe_mcp.mjs

# Мета-оракул на класс дефекта, который этот файл однажды и породил: 2026-09-02 правка
# порядка затянула строки S9 и S11 внутрь многострочной кавычки S10 — оракулы остались в
# файле, перестали исполняться, а прогон печатал «все оракулы зелёные». Считаем объявленные
# и исполненные: расхождение значит, что часть проверок молча выпала.
#
# Что он НЕ ловит, названо честно: удаление или комментирование строки `run S…` уменьшает
# оба числа сразу. От этого защищает не счётчик, а обзор диффа: пропавший оракул виден
# строкой со знаком минус, а проглоченный кавычкой — нет, и ловить надо именно второе.
DECLARED=$(grep -c '^run S' "${BASH_SOURCE[0]}")
if [ "$EXECUTED" != "$DECLARED" ]; then
  printf 'META объявлено оракулов: %s, исполнено: %s — часть не запустилась\n' \
    "$DECLARED" "$EXECUTED" >&2
  FAILED=1
fi

[ "$FAILED" = "0" ] && echo "smoke: все оракулы зелёные ($EXECUTED)" || echo "smoke: есть красные — см. выше" >&2
exit "$FAILED"
