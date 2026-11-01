"""Actual Python alerts_view over invented in-memory rows and bars. No dataset access."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/parity/src/producers/investments/fixtures/alerts-view.json"


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


def generate(root: Path) -> dict:
    os.environ.update(
        CASHU_DATA_DIR=str(root / "data"),
        HOME=str(root),
        CASHU_TESTING="1",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_AUTO_DAILY="0",
        TZ="Europe/Warsaw",
    )
    import canon
    import frozen
    import golden
    from sqlmodel import Session, SQLModel, create_engine, select

    golden.import_all()
    frozen.install("2026-10-01T12:00:00")
    from cashu.core.models import Profile, ProfileModule
    from cashu.modules.investments.models import (
        InvAlert,
        InvInstrument,
        InvPriceBar,
        InvProfileInstrument,
        InvSignal,
    )
    from cashu.modules.investments.service.views import alert_kinds, alerts_view

    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    fixed = dt.datetime(2026, 9, 1, 10, tzinfo=dt.UTC)
    cases = [
        ("price_above", {"level": 90.0}),
        ("price_below", {"level": 90.0}),
        ("change_pct", {"window_days": 5, "threshold": 0.05, "direction": "any"}),
        ("drawdown_from_high", {"window_days": 5, "threshold": 0.1}),
        ("new_high", {"window_days": 5}),
        ("sma_cross", {"window_days": 5, "direction": "above"}),
        ("weight_above", {"threshold": 0.3}),
        ("weight_below", {"threshold": 0.3}),
        ("custom", {"expression": "weight > 10%"}),
        ("range_breakout", {"window_days": 10, "max_range_pct": 0.08, "direction": "any"}),
        ("volume_spike", {"window_days": 5, "multiple": 2.5}),
    ]
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
        session.add_all(
            [
                InvInstrument(
                    id=i,
                    name=f"Synthetic asset {i}",
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
        for i, (kind, params) in enumerate(cases, 1):
            session.add(
                InvAlert(
                    id=i,
                    profile_id=1,
                    instrument_id=1,
                    kind=kind,
                    scope="instrument",
                    params=params,
                    title=f"Synthetic {kind}",
                    note=None if i % 2 else "Synthetic note",
                    tag="cena" if i == 1 else None,
                    status={1: "triggered", 2: "muted", 3: "snoozed", 4: "expired"}.get(
                        i, "active"
                    ),
                    source="agent" if i == 1 else "user",
                    created_by="mcp" if i == 1 else "app",
                    cooldown_days=3 if i == 1 else None,
                    expires_at=fixed if i == 5 else None,
                    snoozed_until=dt.datetime(2026, 10, 2, 10, tzinfo=dt.UTC) if i == 3 else None,
                    last_value="not-a-decimal" if i == 4 else "112.50" if i == 1 else None,
                    last_checked_at=fixed if i == 1 else None,
                    last_triggered_at=fixed if i == 1 else None,
                    created_at=fixed,
                    updated_at=fixed,
                )
            )
        session.add_all(
            [
                InvAlert(
                    id=12,
                    profile_id=2,
                    instrument_id=2,
                    kind="volume_spike",
                    scope="instrument",
                    params={"window_days": 5, "multiple": 2.5},
                    title="No bars",
                    created_at=fixed,
                    updated_at=fixed,
                ),
                InvAlert(
                    id=13,
                    profile_id=1,
                    instrument_id=1,
                    kind="price_above",
                    scope="instrument",
                    params={"level": 1.0},
                    title="Deleted",
                    deleted_at=fixed,
                    created_at=fixed,
                    updated_at=fixed,
                ),
                InvAlert(
                    id=14,
                    profile_id=3,
                    instrument_id=2,
                    kind="price_above",
                    scope="instrument",
                    params={"level": 1.0},
                    title="Disabled profile",
                    created_at=fixed,
                    updated_at=fixed,
                ),
            ]
        )
        for day in range(12):
            session.add(
                InvPriceBar(
                    instrument_id=1,
                    date=dt.date(2026, 9, 20) + dt.timedelta(days=day),
                    close="112" if day == 11 else "100",
                    volume=400 if day == 11 else 100,
                    currency="PLN",
                    source="synthetic",
                )
            )
        # A future bar must not change the range or average at the frozen as-of date.
        session.add(
            InvPriceBar(
                instrument_id=1,
                date=dt.date(2026, 10, 2),
                close="999",
                volume=999,
                currency="PLN",
                source="synthetic",
            )
        )
        session.add(
            InvSignal(
                id=1,
                profile_id=1,
                rule_id="alert:1",
                dedup_key="alert:1",
                kind="alert:price_above",
                severity="info",
                status="acknowledged",
                message="Synthetic price: detail",
                instrument_id=1,
                payload={
                    "title": "Synthetic price",
                    "close": "112.5",
                    "level": "90",
                    "currency": "PLN",
                    "price_date": "2026-10-01",
                },
                first_seen_at=fixed,
                last_seen_at=fixed,
            )
        )
        session.commit()
        ids = canon.IdMap(session)
        expected = {
            ids.key("profiles", p.id): {"alerts": alerts_view(session, p)}
            for p in session.exec(select(Profile).where(Profile.id.in_([1, 2]))).all()
        }
        expected["alert_kinds"] = {"kinds": alert_kinds()}
        expected = canon.Canon(ids, {"id": "alerts"}).value(expected)
        tables = {
            "profiles",
            "profile_modules",
            "accounts",
            "inv_instruments",
            "inv_profile_instruments",
            "inv_instrument_aliases",
            "inv_price_bars",
            "inv_signals",
            "alerts",
        }
        sql = ["PRAGMA foreign_keys = OFF;"]
        sql.extend(f'DROP TABLE IF EXISTS "{name}";' for name in sorted(tables))
        connection = engine.raw_connection()
        try:
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
    return {"sql": "\n".join(sql), "expected": expected}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-alert-view-") as tmp:
        result = generate(Path(tmp))
        text = formatted(
            json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
            TARGET,
        )
    if args.check:
        ok = TARGET.exists() and TARGET.read_text() == text
        print(f"alerts-view: {'pass' if ok else 'stale'}")
        return 0 if ok else 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text)
    print("alerts-view: generated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
