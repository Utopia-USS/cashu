#!/usr/bin/env python3
"""Actual Python P2/P3 oracles from the synthetic test tables and explicit boundary facts."""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import datetime as dt
import io
import json
import math
import os
import subprocess
import tempfile
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/domain/src/investments/plan/fixtures"


def serial(value, key=None):
    if key in ("note_id", "signal_id", "alert_id") and isinstance(value, int):
        return f"{key[:-3]}:{value}"
    if isinstance(value, Decimal):
        return {"decimal": str(value)}
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if dataclasses.is_dataclass(value):
        return serial(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {k: serial(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serial(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return {"float": repr(value)}
    return value


def formatted(value, target):
    return subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(target)],
        input=json.dumps(value, ensure_ascii=False, allow_nan=False),
        text=True,
        capture_output=True,
        check=True,
        cwd=ROOT,
    ).stdout


def generate():
    with tempfile.TemporaryDirectory(prefix="cashu-plan-annotation-") as tmp:
        os.environ.update(HOME=tmp, CASHU_DATA_DIR=str(Path(tmp) / "data"), CASHU_TESTING="1")
        import pytest

        from cashu.modules.investments import plan
        from cashu.modules.investments.plan import freshness, hints

        hint_cases, freshness_cases = [], []
        original_hint = hints.instrument_hints
        original_freshness = freshness.plan_freshness

        def record_hints(facts):
            result = original_hint(facts)
            given = serial(facts)
            for row, original in zip(given["alerts"], facts.alerts, strict=True):
                row["order"] = original.alert_id
            hint_cases.append([given, serial([h.to_dict() for h in result])])
            return result

        def record_freshness(facts, now):
            result = original_freshness(facts, now)
            expected = (
                None
                if result is None
                else result.to_dict(
                    lambda value: None if value is None else value.astimezone(dt.UTC).isoformat()
                )
            )
            given = serial(facts)
            for row, original in zip(given["signals"], facts.signals, strict=True):
                row["order"] = original.signal_id
            for row, original in zip(given["alerts"], facts.alerts, strict=True):
                row["order"] = original.alert_id
            freshness_cases.append([{"facts": given, "now": serial(now)}, serial(expected)])
            return result

        plan.instrument_hints = hints.instrument_hints = record_hints
        plan.plan_freshness = freshness.plan_freshness = record_freshness
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = pytest.main(
                [
                    str(ROOT / "parity/python/oracle/tests/investments/plan/test_plan_hints.py"),
                    str(ROOT / "parity/python/oracle/tests/investments/plan/test_plan_freshness.py"),
                    "-q",
                    "-p",
                    "no:cacheprovider",
                ]
            )
        if code != 0:
            raise RuntimeError("synthetic Python annotation oracle tests failed")

        # float conversion and strongest-selection use rounded values, retaining the first tie.
        for value in (
            None,
            True,
            False,
            "bad",
            "",
            "0x10",
            " .1 ",
            "1_0",
            "٠.١",
            Decimal("0.10004"),
            "nan",
            "inf",
            "-Infinity",
        ):
            record_hints(
                hints.HintFacts(
                    held=True,
                    health="current",
                    has_thesis=True,
                    signals=(
                        hints.OpenSignal(
                            "gain_from_cost", {"threshold": value, "unrealized_pct": "0.25001"}
                        ),
                    ),
                )
            )
        for thresholds in ((0.10004001, 0.10004999), (0.10004999, 0.10004001), (0.2, 0.1)):
            record_hints(
                hints.HintFacts(
                    held=True,
                    health="current",
                    has_thesis=True,
                    signals=tuple(
                        hints.OpenSignal(
                            "gain_from_cost", {"threshold": value, "unrealized_pct": index + 1}
                        )
                        for index, value in enumerate(thresholds)
                    ),
                )
            )
        plan_at = dt.datetime(2026, 10, 1, 0, tzinfo=dt.UTC)
        for now in (
            plan_at,
            plan_at + dt.timedelta(days=30),
            plan_at + dt.timedelta(days=30, microseconds=1),
        ):
            record_freshness(freshness.FreshnessFacts(plan="buy", plan_at=plan_at), now)
        # Different offsets represent the same instant; an exact microsecond after still matters.
        shifted = plan_at.astimezone(dt.timezone(dt.timedelta(hours=2)))
        for after in (0, 1):
            record_freshness(
                freshness.FreshnessFacts(
                    plan="buy",
                    plan_at=shifted,
                    signals=(
                        freshness.PlanSignal(
                            1, "gain_from_cost", plan_at + dt.timedelta(microseconds=after)
                        ),
                    ),
                ),
                plan_at + dt.timedelta(days=1),
            )
        return {
            OUT / "hints.json": formatted({"cases": hint_cases}, OUT / "hints.json"),
            OUT / "freshness.json": formatted({"cases": freshness_cases}, OUT / "freshness.json"),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for target, text in generate().items():
        if args.check:
            if not target.exists() or target.read_text() != text:
                raise SystemExit(f"{target.name}: stale synthetic vectors")
            print(f"{target.name}: pass")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            print(f"{target.name}: generated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
