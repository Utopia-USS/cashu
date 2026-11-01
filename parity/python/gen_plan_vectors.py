"""Synthetic differential vectors for the pure plan checks. Never opens a dataset."""

from __future__ import annotations

import argparse
import dataclasses
import itertools
import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/domain/src/investments/plan/fixtures/plan-checks.json"


def formatted(text: str, path: Path) -> str:
    """Use the repository formatter for identical generation and --check bytes."""
    return subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(path)],
        input=text,
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO,
    ).stdout


def generate(root: Path) -> list[dict]:
    os.environ.update(
        CASHU_DATA_DIR=str(root / "data"),
        HOME=str(root),
        CASHU_TESTING="1",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_AUTO_DAILY="0",
    )
    from cashu.core.i18n import use_language
    from cashu.modules.investments.plan import PlanFacts, evaluate

    changes = []
    for plan, health, held in itertools.product(
        (None, "buy", "buy_asap", "hold", "reduce", "exit_asap"),
        ("current", "fulfilled", "weakened", "invalidated"),
        (True, False),
    ):
        changes.append({"plan": plan, "health": health, "held": held})
    for value, stale, exit_plan in itertools.product(
        (None, -1.0, 0.999999999, 1.0, 1.005, 1.015, 2.675), (True, False), (True, False)
    ):
        changes.append({"unrealized": value, "price_stale": stale, "has_exit_plan": exit_plan})
    changes.extend(
        [
            {"health": "fulfilled", "unrealized": None, "price_stale": True},
            {"health": "fulfilled", "unrealized": 2.0},
            {"symbol": "SYN"},
        ]
    )
    out = []
    for lang in ("pl", "en"):
        for change in changes:
            facts = {
                "instrument_id": 1,
                "label": "Synthetic instrument",
                "plan": "buy",
                "health": "current",
                "has_exit_plan": False,
                "unrealized": 1.25,
                "held": True,
                "price_stale": False,
                "symbol": None,
                **change,
            }
            with use_language(lang):
                outcomes = evaluate([PlanFacts(**facts)])
            out.append(
                {
                    "lang": lang,
                    "facts": facts,
                    "expected": [
                        {"type": type(o).__name__, "value": dataclasses.asdict(o)} for o in outcomes
                    ],
                }
            )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-plan-vectors-") as tmp:
        value = generate(Path(tmp))
        text = formatted(
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
            TARGET,
        )
    if args.check:
        ok = TARGET.exists() and TARGET.read_text() == text
        print(f"plan-checks: {'pass' if ok else 'stale'}; cases={len(value)}")
        return 0 if ok else 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text)
    print(f"plan-checks: generated; cases={len(value)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
