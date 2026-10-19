#!/usr/bin/env bash
# Дайджест УТВЕРЖДЕНИЙ для человеческого ревью.
#
# Зачем. Главный потолок контура (Delivery §3.1d): гейты проверяют соответствие
# объявленному, но не верность объявленного. `assert f(2) == 5` пройдёт всё — тест
# есть, исполняется, что-то утверждает, мутанта убивает. Отличить верное ожидание
# от неверного может только человек.
#
# Значит задача контура — не заменить это чтение, а сделать его ДЕШЁВЫМ. Утверждения
# — это 2-3% диффа, но именно в них живёт ошибка ожидания. Читать 15 утверждений
# вместо 400 строк кода реально; читать 400 строк никто не будет.
#
# Это НЕ гейт: он ничего не запрещает, exit всегда 0. Его продукт — текст в
# verify-report.md, под которым человек ставит подпись (DoD §3.2 для M/L).
#
# Настройка (env): BASE (origin/main), LINT_TEST_GLOB — маски тест-файлов через
# пробел (дефолт ниже; обещана шапкой с первой редакции, подключена с `cqg@2.68`).
#
# Использование:
#   bash scripts/lint/assert_digest.sh                    # в stdout
#   bash scripts/lint/assert_digest.sh >> delivery/active/verify-report.md

set -uo pipefail

BASE=${BASE:-origin/main}
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT" || exit 1

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "assert_digest: ref '$BASE' недоступен" >&2
  exit 0
fi

# Только ДОБАВЛЕННЫЕ строки в тестах: изменённое утверждение — это новое ожидание.
# `+` НЕ экранируем: у ugrep в BRE `\+` — оператор повторения, и `^\+` даёт
# «repetition-operator operand invalid», молча роняя пайплайн (внутри Claude Code
# `grep` — обёртка над ugrep, см. §3.1a; на /usr/bin/grep то же выражение проходит,
# поэтому проверка «у меня работает» тут ничего не значит). Незаэкранированный `+`
# в BRE — обычный символ, и это работает во всех трёх реализациях.
read -r -a TEST_GLOBS <<< "${LINT_TEST_GLOB:-*test*.py *test*.ts *test*.tsx *_test.go *Tests.swift *Test.swift}"
added=$(git diff "$BASE"...HEAD -- "${TEST_GLOBS[@]}" 2>/dev/null \
  | grep '^+' | grep -v '^+++' | sed 's/^+//')

# «Не видел» обязано отличаться от «утверждений нет» (`cqg@2.68`). Поле Smart Friend
# Ally 18.10: в диффе 12 `XCTAssert`, а сводка — «Новых утверждений нет» и 0
# непривязанных, то есть `asserts_reviewed_by: n/a` проходил на пустоте: маска не
# знала Swift. Тест-файл опознаётся ПРИНЦИПОМ — именем (`test_*`, `*_test.*`,
# `*_spec.*`, `*.test.*`, `*Tests.*`, `*Spec.*`) или каталогом `__tests__/`, где имена
# не помечены, — а не списком языков. Каталог `tests/` сам по себе признаком не
# служит: на том же поле он дал бы `unknown` генератору фикстур
# `Tests/…/Fixtures/make_fixtures.py`. Файл мимо масок выше разобран не был, и
# маркер тогда `unknown`, а не число.
unseen=$(comm -23 \
  <(git diff --name-only --diff-filter=d "$BASE"...HEAD 2>/dev/null \
      | grep -E '\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|swift|kt|kts|java|rb|php|cs|rs|scala|dart|m|mm|c|cc|cpp|h)$' \
      | grep -E '(^|/)__tests__/|(^|/)(test_[^/]*|[^/]*_(test|spec)\.[^/]*|[^/]*\.(test|spec)\.[^/]*|[^/]*(Tests?|Spec)\.[^/]*)$' \
      | sort -u) \
  <(git diff --name-only --diff-filter=d "$BASE"...HEAD -- "${TEST_GLOBS[@]}" 2>/dev/null | sort -u))

# Маркер — последней строкой: его дописывают в verify-report, и его же читает
# delivery_check. Неразобранный тест-файл делает число непроверенным — `unknown`.
marker() {
  if [[ -n "$unseen" ]]; then
    echo "⚠ **Тест-файлы, которых дайджест не разбирал** (маски — \`LINT_TEST_GLOB\`):"
    printf '%s\n' "$unseen" | sed 's/^/- `/; s/$/`/'
    echo "Их утверждений здесь нет, поэтому число непривязанных неизвестно, и"
    echo "\`asserts_reviewed_by: n/a\` недоступно: подпись human:… at=… либо маски проекта."
    echo
    echo "asserts_without_example: unknown"
  else
    echo "asserts_without_example: $1"
  fi
}

# Классификация каждого утверждения: привязано к примеру спеки или нет.
#
# Привязка считается ПО ТЕСТ-БЛОКУ, а не по строке утверждения: id пишут в имени
# или комментарии теста (`def test_empty_robots():  # A1`), а сам assert его не
# содержит. Классификация по строке давала бы «непривязано» на каждом честном
# тесте — ложное срабатывание, после которого инструмент перестают запускать
# (Delivery §4.3b).
#
# Границы id — вручную через `[^A-Za-z0-9_]`, а НЕ `\b`: BSD-grep/awk на macOS
# `\b` в ERE не поддерживают, и выражение молча не находит ничего (тот же класс
# бага, что `^\+` выше). Побочно это отсеивает `MD5`/`UTF8`: там перед цифрой
# стоит буква внутри слова, то есть границы нет.
classified=$(printf '%s\n' "$added" | awk '
  /(^|[^a-zA-Z_])(def[ \t]+test|it\(|test\(|func[ \t]+[Tt]est)|@Test/ { cur = "" }
  {
    if (match($0, /(^|[^A-Za-z0-9_])[A-Z][0-9]+([^A-Za-z0-9_]|$)/)) {
      tok = substr($0, RSTART, RLENGTH)
      gsub(/[^A-Z0-9]/, "", tok)
      cur = tok
    }
  }
  /(^|[^a-zA-Z_])(assert[a-zA-Z_]*|XCTAssert[a-zA-Z]*|XCTFail|expect|require|should)[ (]/ {
    line = $0
    sub(/^[ \t]+/, "", line)
    printf "%s\t%s\n", (cur == "" ? "-" : cur), line
  }
')

echo "## Assertion digest (ревью ожиданий, не кода)"
echo
echo "База: \`$BASE\` · сгенерировано \`assert_digest.sh\`"
echo

if [[ -z "$classified" ]]; then
  # `asserts_without_example: N` — не отчёт, а ВХОД В РЕШЕНИЕ: `delivery_check`
  # разрешает `asserts_reviewed_by: n/a` только при N = 0 (§3.1d уровень 3). Значит
  # «утверждений нет» из-за незакоммиченного теста = разрешение подписать пустоту.
  # Класс уже закрыт у `check_diff_coverage.sh` и `check_grep_gate.sh`; здесь его
  # не было, и приёмочное развёртывание поймало это staged-тестом с `assert 2+2==5`.
  staged=$(git status --porcelain -- "${TEST_GLOBS[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${staged:-0}" -gt 0 ]]; then
    echo
    echo "⚠ **Внимание: $staged незакоммиченных тест-файл(ов).** Дайджест считает"
    echo "ЗАКОММИЧЕННЫЙ дифф, поэтому их утверждений здесь нет. Закоммить и повторить"
    echo "до того, как ставить \`asserts_reviewed_by: n/a\` — иначе n/a подписывает пустоту."
    echo
  fi
  echo "**Новых утверждений нет.**"
  echo
  echo "Это либо тесты не добавлялись (тогда чем закрыт DoD?), либо изменения"
  echo "только в реализации. Второе законно; первое — повод спросить."
  echo
  # Маркер печатается ВСЕГДА, в том числе здесь: delivery_check требует его
  # наличия, а «утверждений нет» — законный ноль непривязанных.
  marker 0
  exit 0
fi

n=$(printf '%s\n' "$classified" | wc -l | tr -d ' ')
bare=$(printf '%s\n' "$classified" | grep -c '^-	' || true)
bare=${bare:-0}

echo "Новых/изменённых утверждений: **$n**, из них без ссылки на пример спеки:"
echo "**$bare**. Вопрос к каждому непривязанному один: **откуда взято ожидаемое"
echo "значение — из спеки или придумано под реализацию?**"
echo
echo '```'
printf '%s\n' "$classified" | cut -c1-160
echo '```'
echo
ids=$(printf '%s\n' "$classified" | cut -f1 | grep -v '^-$' | sort -u | paste -sd' ' -)
if [[ "$bare" -eq 0 && -n "$unseen" ]]; then
  # Совет «пиши n/a» тут был бы ложью: часть тест-файлов не разобрана (ниже).
  echo "Разобранные утверждения ведут к примерам спеки ($ids), но разобраны НЕ все"
  echo "тест-файлы — список ниже, и до него \`n/a\` не заслужен."
elif [[ "$bare" -eq 0 ]]; then
  echo "✅ **Каждое утверждение ведёт к примеру спеки** ($ids), а примеры человек"
  echo "подписал до кода (\`human_ok_spec\`). Подпись под дайджестом здесь"
  echo "**не требуется**: она уже стоит, заранее и на числах. Пиши в verify-report"
  echo "\`asserts_reviewed_by: n/a (все утверждения ведут к одобренным примерам)\`."
else
  if [[ -n "$ids" ]]; then
    echo "Привязаны к примерам: **$ids**. Остальные $bare — нет."
  else
    echo "⚠ **Ни одно утверждение не ссылается на пример из спеки.** Значит все"
    echo "ожидания придумал исполнитель — это ровно тот круг, о котором §3.1d."
  fi
  echo
  echo "Читать нужно **только строки с \`-\` в первой колонке**: их ожидание"
  echo "ничем не подписано. Подпись: \`asserts_reviewed_by: human:… at=…\`."
fi
echo
# Машинно-читаемый маркер: по нему delivery_check решает, заслужен ли `n/a`
# (Delivery §3.1d уровень 3). Держать последней строкой — её дописывают в
# verify-report, и она должна быть видна глазами тоже.
marker "$bare"
exit 0
