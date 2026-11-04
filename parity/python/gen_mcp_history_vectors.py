"""Actual Python history_metrics over invented imports and market data in a temporary profile DB."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import subprocess
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/mcp/src/tools/fixtures/investments-history.json"


def scenarios():
    def row(day, kind, quantity=None, price=None, fee="0", symbol=None, cash=None):
        gross = str(Decimal(quantity) * Decimal(price)) if quantity and price else "0"
        return {
            "tradeDate": day,
            "type": kind,
            "quantity": quantity,
            "price": price,
            "fee": fee,
            "symbol": symbol,
            "currency": "PLN",
            "grossAmount": gross,
            "cashAmount": cash
            if cash is not None
            else str((-Decimal(gross) if kind == "buy" else Decimal(gross)) - Decimal(fee)),
        }

    rows = [
        row("2025-12-01", "deposit", cash="5000"),
        row("2025-12-01", "buy", "5", "100", "1", "ABC"),
        row("2026-03-01", "sell", "2", "80", "1", "ABC"),
        row("2026-07-01", "buy", "2", "160", "2", "ABC"),
        row("2026-09-01", "sell", "2", "140", "2", "ABC"),
        row("2026-01-01", "withdrawal", cash="-100"),
    ]
    bars = []
    start, end = dt.date(2025, 8, 1), dt.date(2026, 11, 1)
    for n in range((end - start).days + 1):
        day = start + dt.timedelta(days=n)
        close = "100" if day < dt.date(2025, 11, 1) else "130"
        if day >= dt.date(2026, 3, 1):
            close = "80"
        if day >= dt.date(2026, 4, 1):
            close = "100"
        if day >= dt.date(2026, 5, 30):
            close = "120"
        if day >= dt.date(2026, 7, 1):
            close = "160"
        if day >= dt.date(2026, 9, 1):
            close = "140"
        bars.append({"date": day.isoformat(), "close": close, "symbol": "ABC"})
    return [
        {"label": "empty", "rows": [], "bars": [], "today": "2026-11-01"},
        {
            "label": "cash_only",
            "rows": [row("2026-01-01", "deposit", cash="1000")],
            "bars": [],
            "today": "2026-11-01",
        },
        {"label": "behavior", "rows": rows, "bars": bars, "today": "2026-11-01"},
        {"label": "quarter_end", "rows": rows, "bars": bars, "today": "2026-09-30"},
    ]


def generate(root):
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
    sys.path.insert(0, str(REPO / "parity/python/oracle/tests/investments/persistence"))
    from invp_support import HEADER, add_account, import_file, make_profile

    from cashu.core.db import get_session, init_db
    from cashu.core.mcp.redaction import Redactor, leak_check
    from cashu.core.mcp.registry import ToolContext
    from cashu.core.mcp.tools.investments import history_metrics
    from cashu.core.profiles import Profile
    from cashu.modules.investments.domain import Currency, PriceBar
    from cashu.modules.investments.store import convert, instruments, market, transactions

    init_db()
    out = []
    for case in scenarios():
        pid, _slug = make_profile(f"Synthetic {case['label']}")
        aid = add_account(pid)
        if case["rows"]:
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(HEADER.split(","))
            for n, t in enumerate(case["rows"]):
                symbol = t["symbol"]
                writer.writerow(
                    [
                        1,
                        "txn",
                        t["tradeDate"],
                        "",
                        t["type"],
                        f"R{n}",
                        symbol or "",
                        "PLABC0000016" if symbol else "",
                        "Synthetic Equity" if symbol else "",
                        "XWAR" if symbol else "",
                        t["quantity"] or "",
                        t["price"] or "",
                        t["currency"],
                        t["grossAmount"],
                        t["fee"],
                        "",
                        t["cashAmount"],
                        "PLN",
                        "",
                        "",
                        "generic_csv",
                    ]
                )
            import_file(pid, aid, buf.getvalue().encode())
        with get_session() as s:
            txns = transactions.transactions(s, pid)
            ids = {convert.pk(t.instrument_id) for t in txns if t.instrument_id}
            loaded = instruments.load(s, ids, profile_id=pid)
            by_symbol = {i.symbol: i for i in loaded.values()}
            now = dt.datetime(2026, 11, 1, 12, tzinfo=dt.UTC)
            market.upsert_bars(
                s,
                [
                    PriceBar(
                        instrument_id=by_symbol[b["symbol"]].id,
                        date=dt.date.fromisoformat(b["date"]),
                        close=Decimal(b["close"]),
                        source="yahoo",
                        currency=Currency.PLN,
                        fetched_at=now,
                    )
                    for b in case["bars"]
                ],
                now=now,
            )
        expected = {}
        for privacy in ("strict", "amounts"):
            with get_session() as s:
                profile = s.get(Profile, pid)
                assert profile is not None
                ctx = ToolContext(s, profile, privacy, dt.date.fromisoformat(case["today"]))
                tree = history_metrics(ctx)
                redactor = Redactor(privacy, ctx.guard)
                data = redactor.apply(tree)
                leak_check(
                    data, strict=redactor.strict, isins=redactor.isins, non_money=redactor.non_money
                )
                expected[privacy] = data
        out.append({**case, "expected": expected})
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-history-oracle-") as tmp:
        output = generate(Path(tmp))
    text = subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(TARGET)],
        input=json.dumps(output, sort_keys=True, indent=2) + "\n",
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO,
    ).stdout
    if args.check:
        if TARGET.read_text() != text:
            raise SystemExit("history oracle differs")
    else:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_text(text)
    print(f"history oracle: {len(output)} synthetic scenarios, two privacy modes")


if __name__ == "__main__":
    main()
