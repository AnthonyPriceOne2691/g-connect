#!/usr/bin/env bash
# Grep-гейты для конвенций TypeScript-ядра. Роль та же, что у канонического
# `check_grep_gate.sh` (CQG §3), но область и паттерны — под этот стек: канон прямо
# требует «сохраняй механику, меняй область и паттерн» (§Применимость).
#
# Механика сохранена дословно: per-file baseline-ratchet `<count>:<path>`, файл вне
# снимка обязан иметь 0 нарушений, `--generate` пере-снимает только вниз, `STRICT=0`
# делает гейт предупреждающим, число просмотренных файлов печатается всегда
# (иначе «зелёный, не глядя ни на что» — CQG §6).
#
# Правила (инварианты именно этого проекта, а не общие лозунги):
#   config-access    — process.env вне единственного типизированного модуля env.ts
#   di-indirection   — динамический import() в ядре: зависимости инжектируются, не добываются
#   core-no-library  — googleapis вне src/core/google/**: шов с библиотекой ровно один (DESIGN §2)
#   no-grab-bag-module — файлы-помойки utils/misc/common/helpers
#   blind-error      — new Error() в ядре вместо gcError: ошибка без кода и без действия (D-15)
#   unstructured-log — console.* в ядре: ядро возвращает данные, печатает фасад (§13.2)
#
# Настройка (env): LINT_TS_SRC — корень прод-TS от repo-root (дефолт: src)

set -uo pipefail

STRICT=${STRICT:-1}
TS_SRC=${LINT_TS_SRC:-src}
RULE=""
GENERATE=0
LIST_RULES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rule) RULE="${2:-}"; shift 2 ;;
    --generate) GENERATE=1; shift ;;
    --list-rules) LIST_RULES=1; shift ;;
    *) shift ;;
  esac
done

if [[ "$LIST_RULES" == "1" ]]; then
  printf '%s\n' config-access di-indirection core-no-library no-grab-bag-module \
    blind-error unstructured-log
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT" || exit 1

case "$RULE" in
  config-access)
    LABEL='process.env вне src/core/env.ts (настройки читаются типизированно, в одном месте)'
    PATTERN='process\.env'
    EXCLUDE='src/core/env\.ts'
    ;;
  di-indirection)
    LABEL='динамический import() в ядре (зависимости инжектируются, а не добываются на ходу)'
    PATTERN='(await[[:space:]]+import\(|require\()'
    EXCLUDE='^$'
    ;;
  core-no-library)
    LABEL="импорт googleapis вне src/core/google/** (шов с библиотекой ровно один)"
    PATTERN="from ['\"]googleapis['\"]"
    EXCLUDE='src/core/google/'
    ;;
  no-grab-bag-module)
    LABEL='модули-помойки без темы (utils/misc/common/helpers)'
    PATTERN='.'
    FILTER='/(utils|misc|common|helpers)\.ts$'
    EXCLUDE='^$'
    ;;
  blind-error)
    LABEL='new Error() в ядре вместо gcError (ошибка без кода, без причины и без действия)'
    PATTERN='new Error\('
    EXCLUDE='^$'
    ;;
  unstructured-log)
    # Область — ядро. Фасад (src/cli) печатает по построению: §13.2 разводит
    # «ядро возвращает данные» и «фасад показывает». Исключение названо, а не молча
    # достигнуто расширением снимка.
    LABEL='console.* в ядре (ядро возвращает данные; печатает фасад)'
    PATTERN='console\.(log|warn|error|info|debug)\('
    EXCLUDE='src/cli/'
    ;;
  *)
    echo "Правило не задано или неизвестно: --rule <config-access|di-indirection|core-no-library|no-grab-bag-module|blind-error|unstructured-log>" >&2
    exit 2
    ;;
esac

FILTER=${FILTER:-'.'}
BASELINE="$SCRIPT_DIR/ts_${RULE}_baseline.txt"

# Область: прод-TS. Тесты не судятся этими правилами — это настройка проекта,
# а не поблажка: в тестах и console, и динамический import законны.
# Без mapfile: в macOS штатный bash 3.2, и `mapfile: command not found` уронил бы
# гейт на машине владельца. Канон гоняется и там, и в CI — значит только POSIX-петля.
declare -a FILES=()
while IFS= read -r found; do
  [[ -n "$found" ]] && FILES+=("$found")
done < <(
  find "$TS_SRC" -type f -name '*.ts' 2>/dev/null | sort |
    grep -E "$FILTER" | grep -vE "$EXCLUDE"
)

count_in_file() {
  if [[ "$RULE" == "no-grab-bag-module" ]]; then
    echo 1
    return
  fi
  # `grep -c` при нуле совпадений печатает 0 И выходит с кодом 1; наивное
  # `|| echo 0` печатало вторую строку, и арифметика получала «0\n0».
  local n
  n=$(grep -cE "$PATTERN" "$1" 2>/dev/null) || n=0
  echo "${n:-0}"
}

declare -a CURRENT=()
for file in ${FILES[@]+"${FILES[@]}"}; do
  n=$(count_in_file "$file")
  [[ "$n" -gt 0 ]] && CURRENT+=("$n:$file")
done

if [[ "$GENERATE" == "1" ]]; then
  {
    echo "# baseline: $RULE — $LABEL"
    echo "# Формат: <нарушений>:<путь>. Файл ВНЕ снимка обязан иметь 0."
    echo "# Ратчет только вниз: снимать заново можно, увеличивать — нет."
    [[ ${#CURRENT[@]} -gt 0 ]] && printf '%s\n' "${CURRENT[@]}"
  } > "$BASELINE"
  echo "baseline $RULE обновлён: ${#CURRENT[@]} файл(ов) с нарушениями, просмотрено ${#FILES[@]} файл(ов)"
  exit 0
fi

# Ассоциативных массивов в bash 3.2 нет — снимок читается grep'ом по файлу.
# Механика та же: сравнение `<count>:<path>` построчно.
allowed_for() {
  local file="$1" line
  [[ -f "$BASELINE" ]] || { echo 0; return; }
  line=$(grep -E "^[0-9]+:${file//./\\.}$" "$BASELINE" 2>/dev/null | head -1) || line=""
  [[ -z "$line" ]] && { echo 0; return; }
  echo "${line%%:*}"
}

BASELINE_SIZE=0
if [[ -f "$BASELINE" ]]; then
  BASELINE_SIZE=$(grep -cE '^[0-9]+:' "$BASELINE" 2>/dev/null) || BASELINE_SIZE=0
fi

FAILED=0
for entry in ${CURRENT[@]+"${CURRENT[@]}"}; do
  file="${entry#*:}"
  n="${entry%%:*}"
  allowed=$(allowed_for "$file")
  if [[ "$n" -gt "$allowed" ]]; then
    echo "  $file: нарушений $n, в снимке $allowed"
    FAILED=1
  fi
done

echo "$RULE: просмотрено ${#FILES[@]} файл(ов), в снимке ${BASELINE_SIZE}"
if [[ "$FAILED" == "1" ]]; then
  echo "ГЕЙТ: $LABEL" >&2
  echo "Новый код обязан быть чистым. Если нарушение легитимно — правь код или проси" >&2
  echo "человека расширить снимок явным коммитом (ратчет только вниз, CQG §3)." >&2
  [[ "$STRICT" == "1" ]] && exit 1
  echo "STRICT=0 — предупреждение, не блокировка." >&2
fi
exit 0
