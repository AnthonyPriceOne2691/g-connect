#!/usr/bin/env python3
"""Что изменилось: дифф, идентификаторы правки, уроки из архива.

Часть `delivery_check.py` (`delivery@1.53`). Ответ на вопрос «на что вообще
смотреть»: объём диффа, какие имена в нём появились, какие строки архива к нему
применимы и какие поставки он архивирует. Суждения здесь нет — оно в разделах,
которые этим пользуются.
"""

from __future__ import annotations

import re
from pathlib import Path

from delivery_base import ROOT, git, merge_base_of, out_of_blast_radius
from delivery_decisions import DECISION_STOPWORDS

#: STATUS поставки в архиве — тот же образец, что `ARCHIVED_STATUS` у `okf_sync_gate`
#: (каноны друг друга не импортируют: проект вправе развернуть один без другого).
ARCHIVED_STATUS = re.compile(r"^delivery/archive/[^/]+/STATUS\.md$")


def archived_in_diff(base: str | None) -> list[Path]:
    """Каталоги поставок, которые архивирует ЭТОТ дифф: их STATUS ДОБАВЛЕН в окне.

    Поле Smart Friend Ally 17.10: handoff и перенос в `archive/` — один коммит, и
    гейт, смотревший только в `active/`, видел пустоту — «idle», 0 ошибок при
    неподписанной спеке (§2.3a). Окно — общее у всех потребителей базы. Только
    ДОБАВЛЕННЫЕ: правка давнего архива поставкой не является (как у `okf@1.20`).
    `--no-renames` — иначе перенос `active/` → `archive/` пришёл бы переименованием;
    `-z` — кириллический slug git отдал бы в кавычках, и образец его не узнал бы.
    """
    merge_base = merge_base_of(base)
    if not merge_base:
        return []
    out = git("-C", str(ROOT), "diff", "--name-only", "-z", "--diff-filter=A",
              "--no-renames", f"{merge_base}..HEAD")
    return [ROOT / Path(f).parent for f in out.split("\0") if ARCHIVED_STATUS.match(f)]


def numstat(rng: str) -> list[tuple[str, str, str]]:
    """(путь, добавлено, удалено) из `git diff --numstat -z` — пути как есть.

    `-z` (`delivery@2.05`): без него git отдаёт кириллический путь в кавычках и
    восьмеричных кодах (замер 17.10), `delivery/заметка.md` не узнавался как
    `delivery/`, и документ поставки шёл в breaker'ы кодом. Переименование при `-z`
    — запись «добавлено, удалено, пусто» и два пути следом; берётся новый, а не
    строка «старый => новый», которую разбор без `-z` принимал за путь.
    """
    parts = git("diff", "--numstat", "-z", rng).split("\0")
    out: list[tuple[str, str, str]] = []
    i = 0
    while i < len(parts):
        fields = parts[i].split("\t")
        if len(fields) != 3:
            i += 1
            continue
        a, d, path = fields
        if path:
            i += 1
        else:
            path, i = (parts[i + 2] if i + 2 < len(parts) else ""), i + 3
        if path:
            out.append((path, a, d))
    return out


def diff_stats(base: str) -> tuple[int, int, int, int, list[str]] | None:
    """(files, added, deleted, excluded, paths) для base..HEAD; None если ref недоступен.

    `paths` — только код: процессные артефакты отфильтрованы тем же
    `out_of_blast_radius`, потому что оба потребителя (breaker'ы §3.4 и
    сопоставление уроков §2.2a) спрашивают про изменения в коде, а не в его
    описании. Сгенерированное (lock-файлы) не код в том же смысле: его никто не
    пишет и не читает построчно.
    """
    if not git("rev-parse", "--verify", "--quiet", base).strip():
        return None
    merge_base = merge_base_of(base) or base
    files = added = deleted = excluded = 0
    paths: list[str] = []
    for path, a, d in numstat(f"{merge_base}..HEAD"):
        if out_of_blast_radius(path):
            excluded += 1
            continue
        files += 1
        paths.append(path)
        added += int(a) if a.isdigit() else 0      # "-" у бинарников
        deleted += int(d) if d.isdigit() else 0
    return files, added, deleted, excluded, paths


def archive_index_rows(text: str) -> list[tuple[list[str], list[str]]]:
    """[(префиксы путей, id уроков)] из таблицы A.13.

    Разбор построчный по markdown-таблице: строка шапки и разделитель отсеиваются
    сами — в них нет backtick'ов, а значит и путей. Формат жёсток ровно в двух
    колонках (пути в backticks, id вида L<N>), чтобы правило §2.2a было
    исполнимым, а не пожеланием.
    """
    rows: list[tuple[list[str], list[str]]] = []
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4:
            continue
        prefixes = [p for p in re.findall(r"`([^`]+)`", cells[2]) if "/" in p]
        if prefixes:
            rows.append((prefixes, re.findall(r"\bL\d+\b", cells[3])))
    return rows


def applicable_lessons(index_text: str, changed: list[str]) -> list[str]:
    """id уроков из строк, чьи пути пересекаются с диффом (порядок сохранён)."""
    out: list[str] = []
    for prefixes, ids in archive_index_rows(index_text):
        if any(c.startswith(p) for p in prefixes for c in changed):
            out.extend(ids)
    return list(dict.fromkeys(out))



def diff_identifiers(paths: list[str], base: str) -> set[str]:
    """Токены, которые есть в диффе: базовые имена файлов + идентификаторы кода.

    Берём и пути, и содержимое изменённых строк: решение может ссылаться и на файл
    («вынес в sentences.py»), и на функцию («`_cut_points` считает границы»).

    ⚠ `base` — ПАРАМЕТР, и это несущее (`delivery@1.72`, поле). Здесь стояла
    константа `HEAD~1..HEAD`, пока вызывающие уже брали базу из `--diff-base`:
    пути приезжали от диффа всей поставки, а тела строк — от последнего коммита.
    У поставки из двух коммитов (код, потом артефакты) порог §12.5 «≥2 цитаты из
    диффа» становился невыполнимым АРИФМЕТИЧЕСКИ — в последнем коммите кода нет.
    Это `cqg@2.05` («база порога — цель мержа») во втором скрипте: ту правку
    внесли в порог и не провели в извлекатель, который тот же порог и кормит.
    Правило к классу: база сравнения — всегда параметр, и у одной проверки она
    ОДНА; половина, взявшая базу сама, отменяет вторую молча.
    """
    ids: set[str] = set()
    for path in paths:
        for part in re.split(r"[/\\.]", path):
            if len(part) >= 4 and part.lower() not in DECISION_STOPWORDS:
                ids.add(part.lower())
    rng = f"{merge_base_of(base) or base}..HEAD"
    body = git("diff", "--unified=0", rng, "--", *paths) if paths else ""
    for tok in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", body):
        low = tok.lower()
        if low not in DECISION_STOPWORDS:
            ids.add(low)
    return ids


