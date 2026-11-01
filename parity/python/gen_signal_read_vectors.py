"""Generate synthetic Python read-helper and stored signals_view differential fixtures.

Never reads a dataset. cashU imports run only after HOME/data are redirected into a temporary dir.
The output includes synthetic SQL and actual Python view output, not hand-built expected views.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HELPERS = REPO / "packages/domain/src/investments/alerts/fixtures/signal-read-vectors.json"
VIEWS = REPO / "packages/parity/src/producers/investments/fixtures/signals-view.json"


def generate(root: Path) -> tuple[dict, dict]:
    os.environ.update(
        CASHU_DATA_DIR=str(root / "data"),
        HOME=str(root),
        CASHU_TESTING="1",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_AUTO_DAILY="0",
        CASHU_PRICE_REFRESH="0",
        TZ="Europe/Warsaw",
    )
    import canon
    import frozen
    import golden
    from sqlmodel import Session, SQLModel, create_engine, select

    golden.import_all()
    frozen.install("2026-10-01T12:00:00")
    from cashu.core.models import Account, Profile, ProfileModule
    from cashu.modules.investments.alerts.messages import _KEYS, alert_message
    from cashu.modules.investments.models import (
        InvDecision,
        InvDecisionSignal,
        InvInstrument,
        InvProfileInstrument,
        InvRuleRun,
        InvSignal,
    )
    from cashu.modules.investments.rules.kinds.allocation_drift import (
        drift_bucket_generic,
        with_bucket_generic,
    )
    from cashu.modules.investments.service.views import signals_view

    cases = []
    facts = {
        "title": "Synthetic alert",
        "symbol": "SYN",
        "close": "12.50",
        "level": "12",
        "currency": "PLN",
        "price_date": "2026-09-30",
        "window_days": 20,
        "from_close": "13",
        "from_date": "2026-09-01",
        "threshold": 0.05,
        "drawdown": 0.1,
        "high": "14",
        "high_date": "2026-09-20",
        "previous_high": "12",
        "direction": "above",
        "sma": "11.25",
        "range_low": "11",
        "range_high": "12",
        "range_pct": 0.03,
        "max_range_pct": 0.05,
        "breakout_pct": 0.01,
        "ratio": 2.0,
        "multiple": 1.5,
        "weight": 0.2,
        "bucket_id": "stocks",
        "held": True,
    }
    for kind in [*_KEYS, "custom", "future_kind"]:
        for payload in (None, {}, facts):
            item = {
                "kind": f"alert:{kind}",
                "payload": payload,
                "message": "Synthetic alert: detail",
                "label": None,
            }
            cases.append(
                {**item, "expected": alert_message(item["kind"], payload, item["message"])}
            )
    for change in (-0.2, -0.0, 0, 0.2, True, False, "0.2", None):
        payload = {"title": "Change", "change": change, "symbol": ""}
        cases.append(
            {
                "kind": "alert:change_pct",
                "payload": payload,
                "message": "Change: detail",
                "label": "OVERRIDE",
                "expected": alert_message(
                    "alert:change_pct", payload, "Change: detail", "OVERRIDE"
                ),
            }
        )
    cases.append(
        {
            "kind": "rule",
            "payload": facts,
            "message": "Unchanged",
            "label": None,
            "expected": [None, None],
        }
    )
    for title in (1, 1.0, -0.0, 1e-7, [1, 1.0, -0.0], {"nested": [1, 1.0, 1e-7]}):
        payload = {"title": title}
        message = f"{title}: synthetic detail"
        # JSON text preserves Python int/float types; tests decode with exact integer hooks.
        cases.append(
            {
                "kind": "alert:custom",
                "payload_json": json.dumps(payload),
                "message": message,
                "label": None,
                "expected": alert_message("alert:custom", payload, message),
            }
        )
    buckets = []
    for kind in ("allocation_drift", "other"):
        for payload in (
            None,
            {},
            {"bucket_id": "stocks"},
            {"bucket_id": "private"},
            {"bucket_id": None},
            {"bucket_id": 7},
            {"bucket_generic": False},
            {"bucket_generic": "bad"},
            {"bucket_id": "private", "bucket_generic": True},
        ):
            buckets.append(
                {
                    "kind": kind,
                    "payload": payload,
                    "generic": drift_bucket_generic(payload),
                    "expected": with_bucket_generic(kind, payload),
                }
            )
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    fixed = dt.datetime(2026, 9, 1, 10, 0, tzinfo=dt.UTC)
    with Session(engine) as session:
        session.add_all(
            [
                Profile(id=i, slug=f"synthetic-{i}", name=f"Synthetic {i}", created_at=fixed)
                for i in (1, 2, 3)
            ]
        )
        session.flush()
        session.add_all(
            [
                ProfileModule(
                    profile_id=i, module_id="investments", enabled=i != 3, enabled_at=fixed
                )
                for i in (1, 2, 3)
            ]
        )
        session.add(
            Account(
                id=1,
                profile_id=1,
                bank="manual",
                name="Synthetic account",
                type="brokerage",
                created_at=fixed,
            )
        )
        session.add_all(
            [
                InvInstrument(
                    id=i,
                    name=f"Synthetic instrument {i}",
                    symbol=None,
                    currency="PLN",
                    asset_class="equity",
                    valuation_mode="market",
                    status="active",
                )
                for i in (1, 2)
            ]
        )
        session.flush()
        session.add(InvProfileInstrument(profile_id=1, instrument_id=1, name="Synthetic override"))
        session.add(InvProfileInstrument(profile_id=2, instrument_id=1, name=""))
        session.add_all(
            [
                InvRuleRun(
                    id=i,
                    profile_id=1,
                    trigger="cli",
                    as_of=dt.date(2026, 10, 1),
                    status=status,
                    started_at=fixed + dt.timedelta(days=i),
                )
                for i, status in ((1, "ok"), (2, "partial"), (3, "failed"))
            ]
        )
        for i, status in enumerate(
            ("active", "active", "acknowledged", "resolved", "expired", "active", "active"), 1
        ):
            rule = {
                1: "rule",
                2: "alert:7",
                3: "research:test",
                4: "plan:test",
                5: "rule",
                6: "rule",
                7: "rule",
            }[i]
            payload = (
                {"title": "Synthetic alert", "change": -0.2, "note_id": 5}
                if i in (2, 3)
                else {"bucket_id": "private"}
            )
            session.add(
                InvSignal(
                    id=i,
                    profile_id=2 if i == 7 else 1,
                    rule_id=rule,
                    kind="alert:change_pct" if i == 2 else "allocation_drift",
                    dedup_key=f"{rule}|scope:{i}",
                    severity="action" if i in (1, 3) else "info",
                    status=status,
                    message="Synthetic alert: detail",
                    instrument_id=1 if i % 2 else 2,
                    account_id=1 if i == 1 else None,
                    payload=payload,
                    first_seen_at=fixed,
                    last_seen_at=fixed,
                    last_run_id=1 if i == 1 else 2 if i == 2 else None,
                    snoozed_until=dt.datetime(2026, 10, 1, 10, 0, 0, 1, tzinfo=dt.UTC)
                    if i == 6
                    else None,
                    closed_at=fixed if status in ("resolved", "expired") else None,
                )
            )
        session.flush()
        session.add_all(
            [
                InvDecision(
                    id=i,
                    profile_id=1,
                    signal_id=1 if i == 1 else None,
                    instrument_id=1,
                    action="hold",
                    quantity="1.25",
                    price="20.50",
                    currency="PLN",
                    reason="Synthetic reason",
                    created_at=fixed,
                )
                for i in (1, 2)
            ]
        )
        session.flush()
        session.add_all(
            [
                InvDecisionSignal(decision_id=1, signal_id=2),
                InvDecisionSignal(decision_id=1, signal_id=1),
                InvDecisionSignal(decision_id=2, signal_id=2),
            ]
        )
        session.commit()
        ids = canon.IdMap(session)
        canonical = canon.Canon(ids, {"id": "inv_signals"})
        expected = {
            ids.key("profiles", p.id): {
                status: signals_view(session, p, status) for status in ("open", "history", "all")
            }
            for p in session.exec(select(Profile).where(Profile.id.in_([1, 2]))).all()
        }
        expected = canonical.value(expected)
        tables = {
            "profiles",
            "profile_modules",
            "accounts",
            "inv_instruments",
            "inv_profile_instruments",
            "inv_instrument_aliases",
            "inv_rule_runs",
            "inv_signals",
            "inv_decisions",
            "inv_decision_signals",
            "alerts",
            "research_notes",
        }
        # Rebuild the synthetic snapshot in arbitrary dump table order, including deliberate
        # dangling alert/note references used to pin Canon's dangling-reference contract.
        sql = ["PRAGMA foreign_keys = OFF;"]
        connection = engine.raw_connection()
        try:
            for name in sorted(tables):
                sql.append(f'DROP TABLE IF EXISTS "{name}";')
            for statement in connection.iterdump():
                if any(
                    statement.startswith(
                        (
                            f"CREATE TABLE {name} ",
                            f'CREATE TABLE "{name}" ',
                            f'INSERT INTO "{name}" ',
                        )
                    )
                    for name in tables
                ):
                    sql.append(statement)
        finally:
            connection.close()
        sql.append("PRAGMA foreign_keys = ON;")
    return {"messages": cases, "buckets": buckets}, {"sql": "\n".join(sql), "expected": expected}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-signal-vectors-") as tmp:
        helpers, views = generate(Path(tmp))
    ok = True
    for target, value in ((HELPERS, helpers), (VIEWS, views)):
        text = (
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
        )
        # Keep generated fixture bytes in the same format the package lint gate requires.
        text = subprocess.run(
            ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(target)],
            input=text,
            text=True,
            capture_output=True,
            check=True,
            cwd=REPO,
        ).stdout
        if args.check:
            match = target.exists() and target.read_text() == text
            print(f"{target.name}: {'pass' if match else 'stale'}")
            ok &= match
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            print(f"{target.name}: generated")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
