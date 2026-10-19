#!/usr/bin/env python3
"""Delivery harness checker.

Usage:
  python scripts/delivery_check.py
  python scripts/delivery_check.py --require-spec

Exit 0 = OK (warnings allowed). Exit 1 = errors.
"""


from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

from delivery_base import (ACTIVE, ARCHIVE, DELIVERY, ROOT,
                           field,
                           is_placeholder, read)
from delivery_decisions import check_permissions
from delivery_diff import archived_in_diff
from delivery_evidence import check_evidence
from delivery_journals import check_journals
from delivery_limits import check_limits
from delivery_status import check_status_shape

def check_archive_index(args, errors: list[str], warnings: list[str]) -> None:
    """Индекс архива: полнота и просроченное наблюдение (§2.2a, §13.1).

    Шов `main` (`delivery@1.59`). Границы заданы ТЕКСТОМ первой и следующей
    строки, а не маркером: в `main` маркеры стоят на разных отступах и
    внутри веток, поэтому «до следующего маркера» здесь неверно.
    """
    # --- §2.2a: архив без индекса не читается, а отставший индекс врёт о полноте.
    # Обе проверки не зависят от фазы и от наличия diff-base: они про сам архив.
    if ARCHIVE.is_dir():
        # Каталог-ШАБЛОН пропускается, и это не поблажка: канон сам
        # поставляет `archive/<slug>/observed.md` как образец записи
        # наблюдения (§13). Без пропуска `delivery_check` краснеет сразу
        # после развёртывания на ЧИСТОМ проекте — гейт объявляет
        # неиндексированной поставкой файл, который положил сам канон.
        # Найдено развёртыванием в пустой проект (2026-08-17): тот же
        # класс, что `cqg@2.16` — канон не попадает в раскладку, которую
        # сам предписывает.
        shipments = sorted(d.name for d in ARCHIVE.iterdir()
                           if d.is_dir() and not d.name.startswith("<"))
        idx_text = read(ARCHIVE / "INDEX.md")
        if shipments and not idx_text:
            errors.append(
                f"delivery/archive/ содержит {len(shipments)} поставок, а "
                "INDEX.md нет (§2.2a / A.13) — неиндексированный архив никем "
                "не читается"
            )
        elif idx_text:
            unlisted = [s for s in shipments if s not in idx_text]
            if unlisted:
                errors.append(
                    "archive/INDEX.md отстал от архива: не упомянуты "
                    f"{', '.join(unlisted)} (§2.2a) — индекс, который врёт о "
                    "своей полноте, хуже отсутствующего"
                )

        check_overdue_observation(shipments, errors)


def check_preconditions(args, errors: list[str], warnings: list[str]) -> bool:
    """Каркас на месте — иначе проверять дальше нечего.

    ⚠ Возвращает ПРОДОЛЖАТЬ ЛИ, а не данные, и это не стиль. Из блока убегало не
    имя, а ПОТОК УПРАВЛЕНИЯ: внутри стоял `return 1` — досрочный выход из `main`.
    Механический вырез унёс его в помощника, где он значил «проверка прошла», и
    75 тестов упали (`delivery@1.59`). Новый класс к процедуре резки: смотреть
    надо не только на имена, но и на `return`/`break`/`continue`, пересекающие
    границу шва.
    """
    if not (DELIVERY / "CONSTITUTION.md").is_file():
        errors.append("missing delivery/CONSTITUTION.md")
    if not ACTIVE.is_dir():
        errors.append("missing delivery/active/")
        for w in warnings:
            print(f"WARNING: {w}")
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"delivery_check: {len(errors)} error(s), {len(warnings)} warning(s)")
        return False

    status = read(ACTIVE / "STATUS.md")
    if not status:
        # Пустой active/ — ШТАТНОЕ состояние (§2.3a): предыдущая поставка
        # заархивирована, следующая не начата. Ошибкой это быть не может, иначе
        # контур красный между поставками — причём §13.1 сам загоняет проект в
        # это состояние, требуя архивации на handoff (полевая находка F12).
        # Проверки уровня архива ниже продолжают работать: именно в idle всплывает
        # просроченное наблюдение.
        warnings.append(
            "idle: нет delivery/active/STATUS.md — активной поставки нет (§2.3a). "
            "Начинаешь работу? Создай STATUS по шаблону A.2"
        )
    # §2.3a: поставку, которую архивирует ЭТОТ дифф, судят те же разделы.
    archived = archived_in_diff(getattr(args, "diff_base", None))
    for home in ([ACTIVE] if status else []) + archived:
        judge_delivery(home, args, errors, warnings)
    return True


def judge_delivery(home: Path, args, errors: list[str], warnings: list[str]) -> None:
    """Все разделы гейта над ОДНОЙ поставкой — на её фазе; у архивной путь в каждой строке."""
    status = read(home / "STATUS.md")
    tag = "" if home == ACTIVE else f"{home.relative_to(ROOT).as_posix()}: "
    if tag:
        print(f"судится поставка, которую архивирует этот дифф: {tag[:-2]} "
              f"(phase={field(status, 'phase') or '?'})")
    errs: list[str] = []
    warns: list[str] = []
    ctx = check_status_shape(status, args, errs, warns, home)
    check_evidence(status, args, errs, warns, ctx)
    check_journals(status, args, errs, warns, ctx)
    check_limits(status, args, errs, warns, ctx)
    errors.extend(tag + e for e in errs)
    warnings.extend(tag + w for w in warns)


def parse_args():
    """Разбор аргументов — отдельно, чтобы `main` остался диспетчером."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--require-spec", action="store_true")
    ap.add_argument("--require-verify", action="store_true")
    ap.add_argument(
        "--require-ci",
        action="store_true",
        help="fail unless ci-oracles: deployed (§10.4)",
    )
    ap.add_argument(
        "--diff-base",
        metavar="REF",
        help="check circuit breakers §3.4 against REF (e.g. origin/main)",
    )
    return ap.parse_args()


def check_overdue_observation(shipments, errors: list[str]) -> None:
    """Просроченное наблюдение по индексу архива (§13.1).

    Шов по сложности (`delivery@1.59`): `check_archive_index` давала cx 14.
    """
    # --- §13.1: просроченное наблюдение. Лаг в одну поставку — проверка
    # срабатывает тогда, когда человек всё равно смотрит в PR. Дыра названа
    # в каноне: если следующей поставки не будет, никто не проверит; на это
    # тот же периодический прогон, что okf_sync_gate --check-stale.
    today = date.today().isoformat()
    for name in shipments:
        arch_status = read(ARCHIVE / name / "STATUS.md")
        if not arch_status:
            continue
        until = field(arch_status, "observe_until")
        if is_placeholder(until):
            continue
        due = re.match(r"(\d{4}-\d{2}-\d{2})", until)
        if not due or due.group(1) > today:
            continue
        if not (ARCHIVE / name / "observed.md").is_file():
            errors.append(
                f"наблюдение просрочено: {name} — observe_until={due.group(1)} "
                f"(сегодня {today}), а observed.md нет (§13.1 / A.17). "
                "Проверь сигнал в проде и закрой наблюдение, либо сдвинь срок "
                "с причиной"
            )


def check_layer_pointers(warnings: list[str]) -> None:
    """Соседние слои развёрнуты — CONSTITUTION обязан на них указывать."""
    if (ROOT / "CODE_QUALITY_GATES.md").is_file():
        cons = read(DELIVERY / "CONSTITUTION.md")
        if "CODE_QUALITY_GATES" not in cons:
            warnings.append("CQG present but CONSTITUTION.md has no pointer")
    if (ROOT / "OKF_KNOWLEDGE_BUNDLE.md").is_file() or (ROOT / "knowledge").is_dir():
        cons = read(DELIVERY / "CONSTITUTION.md")
        if "OKF" not in cons and "knowledge/" not in cons:
            warnings.append("OKF/knowledge present but CONSTITUTION.md has no pointer")


def main() -> int:
    args = parse_args()

    errors: list[str] = []
    warnings: list[str] = []

    if not check_preconditions(args, errors, warnings):
        return 1

    check_archive_index(args, errors, warnings)

    if args.require_spec and not (ACTIVE / "spec.md").is_file():
        errors.append("--require-spec: active/spec.md missing")
    if args.require_verify and not (ACTIVE / "verify-report.md").is_file():
        errors.append("--require-verify: verify-report.md missing")

    check_permissions(errors, warnings)

    check_layer_pointers(warnings)

    for w in warnings:
        print(f"WARNING: {w}")
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    print(f"delivery_check: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
