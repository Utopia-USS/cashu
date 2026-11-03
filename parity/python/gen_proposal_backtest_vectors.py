"""Actual proposal backtest/portfolio/rules over isolated invented histories, never source DBs."""

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages/store/src/investments/services/fixtures/proposalBacktest.json"
TODAY = dt.date(2026, 10, 31)
CASES = [
    {"name": "empty", "days": None, "kind": "cash_level"},
    {"name": "end_anchored", "days": 15, "kind": "cash_level"},
    {"name": "divisor_260_yields_261", "days": 1820, "kind": "cash_level"},
    {"name": "future_history", "days": -7, "kind": "cash_level"},
    {"name": "raw_episodes", "days": 28, "kind": "cash_level", "trades": [7, 14, 21, 28]},
    {"name": "public_instrument", "days": 14, "kind": "position_concentration", "trades": [0]},
    {
        "name": "private_instrument",
        "days": 14,
        "kind": "position_concentration",
        "trades": [0],
        "private": True,
    },
    {"name": "missing_bars", "days": 14, "kind": "drawdown_from_high", "trades": [0]},
]


def yaml_for(case):
    params = (
        "{threshold: 0.2, window_days: 30}"
        if case["kind"] == "drawdown_from_high"
        else "{max_weight: 0.5}"
    )
    return (
        "version: 1\nbase_currency: PLN\n"
        "data: {max_price_age_days: 100000, max_stale_weight: 1, max_unclassified_weight: 1}\n"
        "buckets:\n  - {id: holdings, match: {asset_class: [equity, other]}}\n"
        "  - {id: cash, match: {asset_class: cash}}\n"
        "allocation: {targets: {holdings: 0.9, cash: 0.1}}\n"
        "rules:\n  - id: synthetic\n"
        f"    kind: {case['kind']}\n"
        "    severity: action\n    cooldown_days: 365\n"
        f"    params: {params}\n"
    )


def child():
    assert os.environ.get("CASHU_TESTING") == "1"
    home = Path(os.environ["HOME"]).resolve()
    assert home.name.startswith("cashu-backtest-oracle-")
    for key in (
        "CASHU_DATA_DIR",
        "CASHU_WORKSPACES_DIR",
        "CASHU_LEGACY_DATA_DIR",
        "CASHU_LAUNCH_AGENTS_DIR",
    ):
        assert Path(os.environ[key]).resolve().is_relative_to(home)
    from cashu.core.paths import data_dir

    assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()
    from cashu.core.db import get_session, init_db
    from cashu.core.mcp.redaction import Redactor
    from cashu.core.mcp.registry import ToolContext
    from cashu.core.mcp.tools.investments_proposals import (
        _backtest_json,
        _backtest_labelled,
        backtest,
    )
    from cashu.core.models import Account
    from cashu.core.profiles import create_profile
    from cashu.modules.investments.models import InvInstrument, InvPriceBar, InvTransaction
    from cashu.modules.investments.strategy.loader import load_strategy

    init_db()
    output = []
    for case in CASES:
        yaml = yaml_for(case)
        loaded = load_strategy(yaml)
        assert loaded.config is not None and loaded.config.rules, loaded.issues
        with get_session() as session:
            profile = create_profile(
                session,
                name=f"Synthetic {case['name']}",
                slug=case["name"].replace("_", "-"),
                modules_=["investments"],
            )
            account = Account(
                profile_id=profile.id,
                bank="dif",
                name="Synthetic brokerage",
                type="brokerage",
                currency="PLN",
            )
            session.add(account)
            session.flush()
            instrument = None
            if case.get("trades"):
                instrument = InvInstrument(
                    name="Synthetic private holding"
                    if case.get("private")
                    else "Synthetic quoted holding",
                    symbol="PRIVATE999" if case.get("private") else "SYNTH",
                    currency="PLN",
                    asset_class="other" if case.get("private") else "equity",
                    valuation_mode="market",
                    needs_classification=False,
                )
                session.add(instrument)
                session.flush()
                if case["kind"] == "position_concentration":
                    for offset in range(0, case["days"] + 1, 7):
                        session.add(
                            InvPriceBar(
                                instrument_id=instrument.id,
                                date=TODAY - dt.timedelta(days=case["days"] - offset),
                                close=Decimal(100),
                                currency="PLN",
                                source="yahoo",
                            )
                        )
            if case["days"] is not None:
                start = TODAY - dt.timedelta(days=case["days"])
                txns = [(start, "deposit", None, None, "1000")]
                for index, offset in enumerate(case.get("trades", [])):
                    buy = index % 2 == 0
                    txns.append(
                        (
                            start + dt.timedelta(days=offset),
                            "buy" if buy else "sell",
                            "10",
                            "100",
                            "-1000" if buy else "1000",
                        )
                    )
                for index, (day, kind, quantity, price, cash) in enumerate(txns):
                    session.add(
                        InvTransaction(
                            account_id=account.id,
                            instrument_id=instrument.id if quantity is not None else None,
                            type=kind,
                            trade_date=day,
                            quantity=Decimal(quantity) if quantity else None,
                            price=Decimal(price) if price else None,
                            currency="PLN",
                            gross_amount=Decimal(1000),
                            fee=Decimal(0),
                            tax=Decimal(0),
                            cash_amount=Decimal(cash),
                            cash_currency="PLN",
                            dedup_hash=f"synthetic-{index}",
                            created_at=dt.datetime(2026, 10, 31, tzinfo=dt.UTC)
                            + dt.timedelta(seconds=index),
                        )
                    )
            session.commit()
            ctx = ToolContext(session, profile, "strict", TODAY)
            report = backtest(ctx, loaded.config.rules[0], loaded.config)
            output.append(
                {
                    **case,
                    "today": TODAY.isoformat(),
                    "yaml": yaml,
                    "expected": _backtest_json(report),
                    "strict": Redactor("strict", ctx.guard).apply(_backtest_labelled(report)),
                    "amounts": Redactor("amounts", ctx.guard).apply(_backtest_labelled(report)),
                }
            )
    print(json.dumps(output, indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    if options.child:
        child()
        return
    with tempfile.TemporaryDirectory(prefix="cashu-backtest-oracle-") as folder:
        home = Path(folder).resolve()
        data = home / "data"
        data.mkdir()
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(home),
            "PYTHONPATH": str(ROOT / "src"),
            "PYTHONIOENCODING": "utf-8",
            "CASHU_TESTING": "1",
            "CASHU_LANG": "en",
            "CASHU_DATA_DIR": str(data),
            "CASHU_DATABASE_URL": f"sqlite:///{data / 'synthetic.db'}",
            "CASHU_WORKSPACES_DIR": str(home / "workspaces"),
            "CASHU_LEGACY_DATA_DIR": str(home / "legacy"),
            "CASHU_LAUNCH_AGENTS_DIR": str(home / "agents"),
        }
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--child"],
            env=env,
            cwd=home,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            # This process contains only invented fixtures; traceback helps diagnose source API drift.
            sys.stderr.write(result.stderr)
            raise SystemExit(result.returncode)
        rendered = json.dumps(json.loads(result.stdout), indent=2, ensure_ascii=False) + "\n"
        if options.check:
            assert json.loads(TARGET.read_text()) == json.loads(rendered), (
                "synthetic backtest fixture is stale"
            )
        else:
            TARGET.parent.mkdir(parents=True, exist_ok=True)
            TARGET.write_text(rendered)
        print(f"synthetic backtest cases: {len(CASES)}")


if __name__ == "__main__":
    main()
