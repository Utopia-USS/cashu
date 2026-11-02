"""Synthetic actual daily service oracle. All database and workspace paths are temporary."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/store/src/investments/services/fixtures/daily.json"
YAML = """version: 1
base_currency: PLN
data: {max_stale_weight: 1}
rules:
  - {id: concentration, kind: position_concentration, severity: action, params: {max_weight: 0.3}}
"""


def generate(root: Path) -> dict:
    os.environ.update(
        HOME=str(root / "home"),
        CASHU_DATA_DIR=str(root / "data"),
        CASHU_TESTING="1",
        CASHU_AUTO_DAILY="0",
        CASHU_PRICE_REFRESH="0",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_LEGACY_DATA_DIR=str(root / "legacy"),
        CASHU_LAUNCH_AGENTS_DIR=str(root / "LaunchAgents"),
        CASHU_APP_BUNDLE="none",
        PYTHON_KEYRING_BACKEND="keyring.backends.fail.Keyring",
        CASHU_LANG="en",
    )
    os.environ.pop("CASHU_DATABASE_URL", None)
    sys.path.insert(0, str(REPO / "tests/investments/persistence"))
    from invp_support import (
        HEADER,
        FakeFx,
        FakePrices,
        add_account,
        import_file,
        make_profile,
        sources,
    )
    from sqlmodel import select

    from cashu.core.db import get_session, init_db
    from cashu.modules.investments.models import InvSignal
    from cashu.modules.investments.service import daily, files, plans

    init_db()
    now = dt.datetime(2026, 10, 31, 12, tzinfo=dt.UTC)
    history = (
        f"{HEADER}\n"
        "1,txn,2026-10-30,,deposit,A,,,,,,,PLN,,,,100,,,,generic_csv\n"
        "1,txn,2026-10-30,,buy,B,AAA,PL0000000001,Synthetic,XWAR,10,10,PLN,100,,,-100,,,,\n"
    ).encode()
    out = {}
    for label, yaml, failing in (
        ("valid", YAML, False),
        ("missing", None, False),
        ("invalid", "version: [", False),
        ("plan_failed", YAML, True),
    ):
        pid, slug = make_profile(f"Synthetic {label}")
        aid = add_account(pid)
        import_file(pid, aid, history)
        if yaml is not None:
            files.write_text_private(files.strategy_yaml_path(slug), yaml)

        def run(pid=pid):
            return daily.run_daily_check(
                "worker",
                profile_ids=[pid],
                as_of=now.date(),
                clock=lambda: now,
                sources=sources(FakePrices({"AAA.WA": Decimal(12)}), FakeFx()),
            ).profiles[0]

        def shape(result):
            stats = dict(result.stats)
            # Exact Decimal exponent is a valuation oracle concern; this composition checks value.
            stats["total_base"] = str(Decimal(stats["total_base"]).normalize())
            return {
                "status": result.status,
                "stats": stats,
                "errors": len(result.errors),
                "new": len(result.new_signals),
                "escalated": len(result.escalated_signals),
            }

        if failing:
            with patch.object(plans, "evaluate_profile", side_effect=RuntimeError("synthetic")):
                out[label] = shape(run())
        else:
            out[label] = shape(run())
        if label == "valid":
            out["second"] = shape(run())
            with get_session() as session:
                row = session.exec(select(InvSignal).where(InvSignal.profile_id == pid)).first()
                assert row is not None
                row.status = "acknowledged"
                row.snoozed_until = now - dt.timedelta(hours=1)
                session.add(row)
            out["wake"] = shape(run())
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-daily-oracle-") as tmp:
        result = generate(Path(tmp))
    text = subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(TARGET)],
        input=json.dumps(result, sort_keys=True, indent=2) + "\n",
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO,
    ).stdout
    if args.check:
        passed = TARGET.exists() and TARGET.read_text() == text
        print(f"daily oracle: {'pass' if passed else 'stale'}; cases={len(result)}")
        return 0 if passed else 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text)
    print(f"daily oracle: generated; cases={len(result)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
