#!/usr/bin/env bash
# Доли мутационного прогона и общий порог (`cqg@2.64`).
#
# Часть `check_mutation_gate.sh`, вынесена из `mutation_ts.sh` по планке 300 строк
# (Delivery §9.1a п.5): доли, счёт доли, сумма долей и порог — одна тема, «сколько
# убито и кто это судит», отдельно от запуска Stryker'а. Подключается через
# `source`; `MIN_KILLED`, `STRICT`, палитру и `not_judged` задаёт вход, `changed` —
# вызывающий `ts_mutation`.

# Доли прогона (`cqg@2.64`, решение Anthony 18.10). `MUTATION_SHARD=k/N` оставляет
# каждый N-й файл отсортированного списка, начиная с k-го, — деление G connect. Доля
# только СЧИТАЕТ, порог судит сумма (`ts_sum`): порог на доле делает вердикт функцией
# разбиения — у G connect доля упала на 59% при общих 70% (их урок L31).
ts_shard() {
  [[ -n "${MUTATION_SHARD:-}" ]] || return 0
  if [[ ! "$MUTATION_SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] \
     || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
    printf '%s⚠ mutation: MUTATION_SHARD=%s — ждал k/N, 1 ≤ k ≤ N%s\n' "$yellow" "$MUTATION_SHARD" "$reset"
    not_judged
  fi
  changed=$(printf '%s\n' "$changed" | sort \
    | awk -v k="${BASH_REMATCH[1]}" -v n="${BASH_REMATCH[2]}" '(NR - 1) % n == k - 1')
  [[ -n "$changed" ]] && return 0
  printf '%smutation: доля %s — файлов на неё не пришлось%s\n' "$green" "$MUTATION_SHARD" "$reset"
  return 1
}

# Счёт доли — файл `shard-k-of-N.counts` («убито всего»). Пишется и тогда, когда
# доле честно нечего судить: сумма, не нашедшая файла, не отличила бы «нечего» от
# «не отчиталась». Вне долей не пишет ничего.
ts_counts() {
  [[ -n "${MUTATION_SHARD:-}" ]] || return 0
  local dir=${MUTATION_COUNTS_DIR:-reports/mutation/shards}
  mkdir -p "$dir" \
    && printf '%s %s\n' "$1" "$2" > "$dir/shard-${MUTATION_SHARD%/*}-of-${MUTATION_SHARD#*/}.counts"
}

# Порог — одно место на прогон и на сумму долей. $1 убито, $2 всего, $3 что судим,
# $4 — отчёт с выжившими, если он есть.
ts_verdict() {
  local pct
  if (( $2 == 0 )); then
    printf '%smutation/ts: %s — мутантов нет, судить нечего%s\n' "$green" "$3" "$reset"
    return 0
  fi
  pct=$(( $1 * 100 / $2 ))
  printf 'mutation/ts: %s — убито %s из %s (%s%%), порог %s%%\n' "$3" "$1" "$2" "$pct" "$MIN_KILLED"
  if (( pct < MIN_KILLED )); then
    printf '\n%sERROR%s: тесты не убивают мутантов изменённого кода — они его не проверяют.\n' \
      "$red" "$reset" >&2
    printf 'Выживший мутант = поведение, которое сьют пропустил бы в проде.\n' >&2
    [[ -n "${4:-}" ]] && printf 'Кто выжил: %s\n' "$4" >&2
    [[ "$STRICT" == "0" ]] && { printf '%sWARNING (STRICT=0)%s\n' "$yellow" "$reset" >&2; return 0; }
    return 1
  fi
  printf '%smutation/ts: OK%s\n' "$green" "$reset"
  return 0
}

# Сумма долей (`MUTATION_SUM=N`) — отдельный шаг после всех долей, Stryker ему не
# нужен. Доля без счёта — «не просудил»: сумма без неё врала бы о полноте.
ts_sum() {
  local dir=${MUTATION_COUNTS_DIR:-reports/mutation/shards} k line det=0 total=0 missing=""
  if [[ ! "$MUTATION_SUM" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s⚠ mutation: MUTATION_SUM=%s — ждал число долей N%s\n' "$yellow" "$MUTATION_SUM" "$reset"
    not_judged
  fi
  for (( k = 1; k <= MUTATION_SUM; k++ )); do
    line=$(cat "$dir/shard-$k-of-$MUTATION_SUM.counts" 2>/dev/null)
    if [[ ! "$line" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
      missing="$missing $k"
      continue
    fi
    det=$(( det + BASH_REMATCH[1] )); total=$(( total + BASH_REMATCH[2] ))
  done
  if [[ -n "$missing" ]]; then
    printf '%s⚠ mutation: нет счёта долей%s в %s — сумма неполная, гейт не судит%s\n' \
      "$yellow" "$missing" "$dir" "$reset"
    not_judged
  fi
  ts_verdict "$det" "$total" "сумма $MUTATION_SUM долей"
}
