#!/usr/bin/env bash
# TS-половина мутационного гейта: Stryker вместо mutmut, вопрос тот же.
#
# Часть `check_mutation_gate.sh` (`cqg@1.86`) — гейт разрезан по планке 300 строк
# (Delivery §9.1a п.5). Половина вынесена целиком, потому что это ПОДСТАНОВКА
# инструмента в ту же строку каталога §3: своего снимка и порога у неё нет, и
# бюджет §9.1a она не трогает.
#
# Подключается через `source`; `FE_DIR`, `TS_SRC`, `MIN_KILLED`, `TIMEOUT_BIN` и
# палитру задаёт вход. Самостоятельно не запускается — гейт это `check_*`.

# --- TS-половина: тот же вопрос, другой инструмент ---------------------------
# Роль «тесты хоть что-то утверждают» на TS закрывает Stryker. Это ПОДСТАНОВКА
# инструмента в существующую строку каталога §3, а не новый гейт: снимка у роли
# нет вовсе, порог один (`MIN_KILLED`) и сообщение одно — значит строка таблицы
# остаётся одна, и бюджет §9.1a не трогается (единица счёта — строка, §3).
#
# Замер, ради которого ветка и написана (Stryker 9.6.1 + vitest 4.1, 24 мутанта):
#   утверждения на месте → убито 20 из 24 (83%)
#   утверждения ВЫРЕЗАНЫ → убито 0 из 24, и `vitest run` при этом ЗЕЛЁНЫЙ (7 passed)
# Обе строки — с кодом возврата Stryker РАВНЫМ НУЛЮ.
#
# ⚠ Отсюда несущее правило ветки: код возврата Stryker вердиктом НЕ является.
# Он ноль и при 0% убитых, потому что `thresholds.break` по умолчанию не задан.
# Судить можно только по отчёту — ровно как python-половина судит по счётчикам
# mutmut, а не по его коду возврата.
FE_DIR=${LINT_FE_DIR:-frontend}
TS_SRC=${LINT_TS_SRC:-$FE_DIR/src}

# Есть ли чем и что мутировать. Наружу уходят три имени — `STRYKER`, `changed`,
# `n`; они локальны у `ts_mutation`, и помощник видит их динамической областью
# bash — тем же приёмом, которым `undecided` в `mutation_verdict.sh` читает `out`
# и `rc`.
#
# ⚠ Код возврата тут — РЕШЕНИЕ, а не вердикт гейта: 1 значит «честно судить
# нечего», и выход остаётся у вызывающего (`|| return 0`). Возврат нулём означал
# бы «продолжай», то есть прогон Stryker'а без Stryker'а. «Не смог судить» сюда
# не возвращается вовсе: это `not_judged`, красное (`cqg@2.64`, решение Anthony
# 18.10, симметрично python-половине с `cqg@2.46`).
#
# Порядок «сначала есть ли работа, потом чем её делать» — несущий: без него
# проект без Stryker краснел бы и на PR, где TS не тронут.
ts_stryker_setup() {
  if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
    printf '%s⚠ mutation: ref %s недоступен — TS-половина не судит%s\n' "$yellow" "$BASE" "$reset"
    not_judged
  fi
  # Тесты из населения исключаются: мутировать надо продуктовый код. Маска шире
  # дефолта Stryker намеренно — проекты зовут каталог и `test`, и `tests`, и `__tests__`.
  # Удалённые — мимо (`--diff-filter=d`): мутировать их нечего, а Stryker на пути без
  # файла падает, а не пропускает его.
  changed=$(git diff --name-only --diff-filter=d "$BASE"...HEAD -- "$TS_SRC" 2>/dev/null \
    | grep -E '\.(ts|tsx|js|jsx|mts|cts)$' \
    | grep -vE '(^|/)(test|tests|__tests__|spec|specs)/|(^|/)conftest\.py$|(^|/)test[_-]|[_-](test|spec)\.|(Test|Tests|Spec|Specs)\.|\.(test|spec)\.' || true)
  if [[ -z "$changed" ]]; then
    printf '%smutation: изменённых prod-файлов нет (BASE=%s, смотрел в %s)%s\n' \
      "$green" "$BASE" "$TS_SRC" "$reset"
    return 1
  fi
  STRYKER="$FE_DIR/node_modules/.bin/stryker"
  [[ -x "$STRYKER" ]] || STRYKER="node_modules/.bin/stryker"
  [[ -x "$STRYKER" ]] || STRYKER=$(command -v stryker 2>/dev/null || true)
  if [[ -z "$STRYKER" ]]; then
    printf '%s⚠ mutation: Stryker не найден — TS-половина не судит.\n' "$yellow"
    printf 'Установка: npm i -D @stryker-mutator/core @stryker-mutator/<runner>-runner%s\n' "$reset"
    not_judged
  fi
  return 0
}

# Чем запускать Stryker: конфиг проекта либо единственный установленный раннер.
# Наружу уходят два имени — `cfg` и `runner`; `runners` за границу не выходит и
# потому объявлен здесь.
#
# Конфиг проекта, если он есть, Stryker находит сам — тогда гейт добавляет только
# область и репортёр. Если конфига нет, нужен раннер, и угадывать его нельзя:
# берём тот, что реально установлен, и только когда он ОДИН. Два раннера — выбор
# проекта, ноль — нечем запускать; оба исхода «не судит», то есть `not_judged`.
ts_stryker_config() {
  local runners
  cfg=""
  for c in stryker.config.json stryker.config.mjs stryker.config.cjs stryker.config.js \
           .stryker.conf.json .stryker.conf.js "$FE_DIR/stryker.config.json"; do
    [[ -f "$c" ]] && { cfg="$c"; break; }
  done
  runner=""
  if [[ -n "$cfg" ]]; then
    return 0
  fi
  runners=$(ls -d "$FE_DIR"/node_modules/@stryker-mutator/*-runner node_modules/@stryker-mutator/*-runner \
              2>/dev/null | sed -E 's#.*/([a-z0-9]+)-runner$#\1#' | sort -u)
  if [[ -z "$runners" ]]; then
    printf '%s⚠ mutation: ни конфига Stryker, ни раннера — TS-половина не судит.\n' "$yellow"
    printf 'Поставь раннер под свой сьют: npm i -D @stryker-mutator/vitest-runner%s\n' "$reset"
    not_judged
  fi
  if [[ $(printf '%s\n' "$runners" | wc -l | tr -d ' ') -gt 1 ]]; then
    printf '%s⚠ mutation: раннеров несколько (%s) — какой брать, решает ПРОЕКТ.\n' \
      "$yellow" "$(printf '%s' "$runners" | tr '\n' ',')"
    printf 'Заведи stryker.config.json с полем testRunner — гейт его подхватит.%s\n' "$reset"
    not_judged
  fi
  runner="$runners"
  return 0
}

# Маска проекта (поле G connect 17.10). `--mutate` из командной строки ЗАМЕНЯЕТ
# `mutate` конфига, а не сужает его. Замер Stryker 9 (`--dryRunOnly`): `--mutate
# src/core/env.ts,src/core/ops.ts` — «Found 2 of 276», хотя в конфиге стоит
# `!src/core/env.ts`. Исключения проекта терялись молча, а у G connect одно из них
# защитное: мутант `env.ts` 2026-09-02 записал фикстуры тестов в настоящий
# `~/.gconnect`. Поэтому изменённые файлы сначала проходят маску конфига — тем же
# порядком, что у Stryker: совпадение позже перекрывает раньше, `!` вычитает.
# Конфиг не JSON (`.mjs`/`.js`) прочесть нечем — область не сужена, и это сказано.
# Маска не разобралась — Stryker не запускается: мутировать защищённое хуже, чем
# не судить.
ts_scope_filter() {
  local kept dropped
  if [[ "$cfg" != *.json ]]; then
    [[ -n "$cfg" ]] && printf '%s⚠ mutation: маска %s не читается (не JSON) — область не сужена%s\n' \
      "$yellow" "$cfg" "$reset"
    return 0
  fi
  kept=$(printf '%s\n' "$changed" | python3 -c '
import json, os, re, sys

def rx(glob):
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
            continue
        if glob.startswith("**", i):
            out, i = out + ".*", i + 2
            continue
        c = glob[i]
        if c == "{" and "}" in glob[i:]:
            j = glob.index("}", i)
            out += "(?:" + "|".join(re.escape(x) for x in glob[i + 1:j].split(",")) + ")"
            i = j + 1
            continue
        out += "[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c)
        i += 1
    return re.compile(out + r"\Z")

masks = json.load(open(sys.argv[1], encoding="utf-8")).get("mutate")
rules = [(m.startswith("!"), rx(m.lstrip("!").split(":")[0])) for m in masks] if isinstance(masks, list) else []
for path in sys.stdin.read().split():
    keep = not rules
    for negated, pattern in rules:
        if pattern.match(path):
            keep = not negated
    if keep and os.path.isfile(path):
        print(path)
' "$cfg") || { printf '%s⚠ mutation: маска %s не разобрана — TS-половина не судит, Stryker не запущен%s\n' \
      "$yellow" "$cfg" "$reset"; not_judged; }
  dropped=$(comm -23 <(printf '%s\n' "$changed" | sort) <(printf '%s\n' "$kept" | sort) | tr '\n' ' ')
  [[ -n "${dropped// /}" ]] && printf 'mutation/ts: вне маски %s — %s\n' "$cfg" "$dropped"
  changed="$kept"
  if [[ -z "$changed" ]]; then
    printf '%smutation: изменённые файлы вне маски мутаций %s — судить нечего%s\n' "$green" "$cfg" "$reset"
    return 1
  fi
  return 0
}

# Запуск Stryker'а и путь к отчёту (шов по §2.1: `ts_mutation` вырос до 89 строк).
# Наружу — `report`. Честный ноль — возврат 1 со счётом «0 0»; «не смог» — `not_judged`.
ts_run() {
  local out rc
  out=$(mktemp)
  # Бюджет держим тем же способом, что python-половина: 124 от timeout — это
  # НЕПОЛНЫЕ данные, а не «зелено».
  if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" "$BUDGET_SEC" "$STRYKER" run ${cfg:+"$cfg"} ${runner:+--testRunner "$runner"} \
      --mutate "$(printf '%s' "$changed" | tr '\n' ',')" --reporters json >"$out" 2>&1
  else
    "$STRYKER" run ${cfg:+"$cfg"} ${runner:+--testRunner "$runner"} \
      --mutate "$(printf '%s' "$changed" | tr '\n' ',')" --reporters json >"$out" 2>&1
  fi
  rc=$?
  # Честное «судить нечего» узнаётся по словам Stryker'а, а не по отчёту. Замер
  # Stryker 9.6 (`cqg@2.64`): дифф из одних типов — «Instrumented 1 source file(s)
  # with 0 mutant(s)», дальше vitest-раннер не находит связанных тестов и падает
  # `ConfigError` с rc=1 и БЕЗ отчёта; а файлы без мутантов в отчёт не попадают
  # вовсе. Без этой ветки правка одних типов краснела бы «не просудил».
  if grep -qE 'Instrumented [0-9]+ source file\(s\) with 0 mutant\(s\)' "$out"; then
    printf '%smutation/ts: изменённые файлы не дали мутантов (только типы?) — судить нечего%s\n' \
      "$green" "$reset"
    rm -f "$out"; ts_counts 0 0; return 1
  fi
  if (( rc == 124 )); then
    printf '%s⚠ mutation: бюджет %ss исчерпан — данные НЕПОЛНЫЕ, гейт не судит.\n' "$yellow" "$BUDGET_SEC"
    printf 'Это не «зелено»: часть мутантов не проверена. Сузь дифф, подними BUDGET_SEC\n'
    printf 'или раздели прогон на доли (MUTATION_SHARD, CQG §3.7).%s\n' "$reset"
    rm -f "$out"; not_judged
  fi

  # Путь к отчёту берём из СЛОВ САМОГО Stryker'а, а не из своего представления о
  # дефолте: замер дал `reports/mutation/mutation.json`, а конфиг проекта волен
  # положить его куда угодно. Зашитый путь молча читал бы вчерашний отчёт.
  report=$(grep -oE 'file://[^ ]*\.json' "$out" | tail -1 | sed 's#^file://##')
  [[ -n "$report" && -f "$report" ]] || report="${MUTATION_TS_REPORT:-reports/mutation/mutation.json}"
  if [[ ! -f "$report" ]]; then
    printf '%s⚠ mutation: Stryker отработал, но отчёт не найден — гейт НЕ судит.%s\n' "$yellow" "$reset"
    tail -5 "$out" >&2; rm -f "$out"; not_judged
  fi

  rm -f "$out"
  return 0
}

ts_mutation() {
  local STRYKER changed n cfg runner report score src
  # Неприменима ПОЛОВИНА, а не роль (`cqg@2.64`): ключ `имя:правило`, как у правил
  # AST- и grep-гейтов. Python-половина и карта ролей им не задеваются.
  if [[ -f "$NA" ]] && grep -q '"check_mutation_gate.sh:ts"' "$NA"; then
    printf '%s⚠ mutation: TS-половина объявлена неприменимой в %s — пропуск НАЗВАН.%s\n' \
      "$yellow" "$NA" "$reset"
    return 0
  fi
  ts_stryker_setup || { ts_counts 0 0; return 0; }
  ts_stryker_config
  ts_scope_filter || { ts_counts 0 0; return 0; }
  ts_shard || { ts_counts 0 0; return 0; }
  n=$(printf '%s\n' "$changed" | wc -l | tr -d ' ')
  printf 'mutation/ts: %s файл(ов)%s, бюджет %ss, цель ≥%s%% убитых\n' \
    "$n" "${MUTATION_SHARD:+, доля $MUTATION_SHARD}" "$BUDGET_SEC" "$MIN_KILLED"

  ts_run || return 0

  score=$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.stderr.write("отчёт Stryker не разобран\n"); raise SystemExit(3)
det = und = 0
for info in d.get("files", {}).values():
    for m in info.get("mutants", []):
        s = m.get("status")
        if s in ("Killed", "Timeout"):
            det += 1
        elif s in ("Survived", "NoCoverage"):
            und += 1
sys.stdout.write("%d %d" % (det, det + und))
' "$report" 2>&1)
  src=$?
  if (( src != 0 )) || [[ ! "$score" =~ ^[0-9]+\ [0-9]+$ ]] || [[ "$score" == *" 0" ]]; then
    # Ноль засчитываемых при мутантах в отчёте — все CompileError/Ignored: это не
    # «нечего судить» (тот случай узнан выше по словам Stryker'а), а «не судил».
    printf '%s⚠ mutation: отчёт есть, а вердикта из него нет — гейт НЕ судит: %s%s\n' \
      "$yellow" "${score:-пусто}" "$reset"
    not_judged
  fi
  set -- $score
  if [[ -n "${MUTATION_SHARD:-}" ]]; then
    ts_counts "$1" "$2"
    printf 'mutation/ts: доля %s — убито %s из %s; порог судит сумма долей (MUTATION_SUM)\n' \
      "$MUTATION_SHARD" "$1" "$2"
    return 0
  fi
  ts_verdict "$1" "$2" "прогон" "$report"
}
