"""Actual offline Python investment views and review deck over invented in-memory SQL rows."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import tempfile
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

from gen_alert_view_vectors import formatted

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/parity/src/producers/investments/fixtures/review-views.json"


def generate(root: Path) -> dict:
    root = root.resolve()
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
    from sqlmodel import Session, create_engine

    golden.import_all()
    frozen.install("2026-10-01T12:00:00")
    from checks import Ctx
    from checks.investments import CHECKS

    from cashu.core.agent_models import Review
    from cashu.core.i18n import use_language
    from cashu.core.mcp.labels import Labelled, Sensitivity
    from cashu.core.mcp.redaction import Redactor
    from cashu.core.mcp.tools.investments import review_context
    from cashu.core.models import Account, Profile, ProfileModule
    from cashu.modules.investments import models as m
    from cashu.modules.investments.market import calendar
    from cashu.modules.investments.service import files
    from cashu.modules.investments.store import journal

    fixed = dt.datetime(2026, 9, 1, 8, tzinfo=dt.UTC)
    recent = dt.datetime(2026, 9, 30, 10, tzinfo=dt.UTC)
    engine = create_engine("sqlite://")
    from cashu.core import migrations

    migrations.upgrade_to_head(engine)
    side_files = {}
    yaml = """version: 1
base_currency: PLN
buckets:
  - id: equity.eu
    match: {asset_class: equity}
  - id: cash
    match: {asset_class: cash}
allocation:
  targets: {equity.eu: 0.8, cash: 0.2}
rules:
  - id: synthetic_loss
    kind: loss_from_cost
    params: {threshold: 0.1, instrument_ids: ['1']}
review: {every: 2weeks, day: thursday, cards: [world, positions, events, calendar, decide]}
"""

    def unlabel(value):
        if isinstance(value, Labelled):
            # T21 keeps labels/privacy outside the projector but shares the actual DATE wire rule.
            if value.label is Sensitivity.DATE:
                return Redactor("amounts").apply(value)
            return unlabel(value.value)
        if isinstance(value, dict):
            return {key: unlabel(item) for key, item in value.items()}
        if isinstance(value, (tuple, list)):
            return [unlabel(item) for item in value]
        return value

    with Session(engine) as session:
        profiles = [
            Profile(id=i, slug=f"synthetic-view-{i}", name=f"Synthetic {i}", created_at=fixed)
            for i in (1, 2, 3)
        ]
        session.add_all(profiles)
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
                Account(
                    id=i,
                    profile_id=1 if i < 3 else 2,
                    bank="xtb",
                    name=f"Synthetic account {i}",
                    currency="PLN",
                    type="brokerage",
                    external_id=f"synthetic-{i}",
                    created_at=fixed,
                )
                for i in (1, 2, 3)
            ]
        )
        session.add_all(
            [
                m.InvInstrument(
                    id=i,
                    name=f"Synthetic instrument {i}",
                    symbol=f"SYN{i}",
                    isin=f"PLSYN000000{i}",
                    currency="PLN",
                    asset_class="equity",
                    valuation_mode="market",
                    status="active",
                )
                for i in (1, 2, 3)
            ]
        )
        session.flush()
        session.add(
            m.InvProfileInstrument(
                profile_id=1,
                instrument_id=1,
                name="Synthetic owner name",
                plan="hold",
                plan_at=fixed,
                created_at=fixed,
                updated_at=fixed,
            )
        )
        session.add(
            m.InvProfileInstrument(
                profile_id=2,
                instrument_id=1,
                name="Synthetic other name",
                created_at=fixed,
                updated_at=fixed,
            )
        )
        session.add_all(
            [
                m.InvWatchlistItem(
                    id=i,
                    profile_id=i,
                    instrument_id=3 if i == 1 else 1,
                    note="Synthetic watch note",
                    added_at=fixed,
                )
                for i in (1, 2)
            ]
        )
        txns = [
            (1, 1, "deposit", "2026-09-01", None, None, None, "1000", fixed),
            (2, 1, "buy", "2026-09-02", 1, "10", "10", "-100", fixed + dt.timedelta(seconds=1)),
            (3, 1, "deposit", "2026-09-29", None, None, None, "20", recent),
            (4, 1, "dividend", "2026-09-28", 1, None, None, "2", recent),
            # Future trade created now remains in created-count and the source dividend loop.
            (5, 1, "dividend", "2026-10-05", 1, None, None, "3", recent),
            (6, 2, "buy", "2026-09-03", 2, "2", "10", "-20", fixed + dt.timedelta(seconds=2)),
            (7, 3, "deposit", "2026-09-01", None, None, None, "40", fixed),
        ]
        for ident, account, kind, day, instrument, quantity, price, cash, created in txns:
            session.add(
                m.InvTransaction(
                    id=ident,
                    account_id=account,
                    type=kind,
                    trade_date=dt.date.fromisoformat(day),
                    instrument_id=instrument,
                    quantity=None if quantity is None else Decimal(quantity),
                    price=None if price is None else Decimal(price),
                    currency="PLN",
                    gross_amount=Decimal(0),
                    fee=Decimal(0),
                    tax=Decimal(0),
                    cash_amount=Decimal(cash),
                    cash_currency="PLN",
                    source="manual",
                    dedup_hash=f"synthetic-txn-{ident}",
                    created_at=created,
                )
            )
        for iid in (1, 2, 3):
            for step in range(1000):
                day = dt.date(2024, 1, 1) + dt.timedelta(days=step)
                if day > dt.date(2026, 10, 1) or day.weekday() >= 5:
                    continue
                session.add(
                    m.InvPriceBar(
                        instrument_id=iid,
                        date=day,
                        close=Decimal(10) + Decimal(step % 13) / 10,
                        currency="PLN",
                        source="synthetic_raw",
                        fetched_at=recent,
                    )
                )
        session.add(
            m.InvFxRate(
                base="PLN",
                quote="EUR",
                date=dt.date(2026, 10, 3),
                rate=Decimal("4.2"),
                source="synthetic_raw",
                fetched_at=recent,
            )
        )
        session.add_all(
            [
                m.InvRuleRun(
                    id=i,
                    profile_id=1,
                    trigger="api",
                    as_of=dt.date(2026, 10, 1),
                    status="partial" if i == 2 else "ok",
                    errors=["Synthetic warning"] if i == 2 else [],
                    report={"escalated": [1]} if i == 2 else {},
                    started_at=fixed if i == 1 else recent,
                    finished_at=fixed if i == 1 else recent,
                )
                for i in (1, 2)
            ]
        )
        session.flush()
        for ident, rule, kind, status, first, closed, payload in [
            (
                1,
                "synthetic_drawdown",
                "drawdown_from_high",
                "active",
                fixed,
                None,
                {"drawdown": 0.15, "threshold": 0.1, "window_days": 20},
            ),
            (
                2,
                "alert:1",
                "alert:price_above",
                "active",
                recent,
                None,
                {"level": 1.0, "close": 12.0, "counter": 1},
            ),
            (
                3,
                "synthetic_owner",
                "allocation_drift",
                "active",
                recent,
                None,
                {"bucket_id": "private", "bucket_generic": False},
            ),
            (4, "synthetic_resolved", "custom", "resolved", fixed, recent, {}),
        ]:
            session.add(
                m.InvSignal(
                    id=ident,
                    profile_id=1,
                    rule_id=rule,
                    kind=kind,
                    status=status,
                    dedup_key=f"{rule}|i:1" if not rule.startswith("alert:") else rule,
                    severity="action",
                    polarity="negative",
                    message="Synthetic finding",
                    instrument_id=1,
                    account_id=1,
                    payload=payload,
                    first_seen_at=first,
                    last_seen_at=recent,
                    closed_at=closed,
                    last_run_id=2,
                    created_run_id=1,
                    snoozed_until=dt.datetime(2026, 10, 2, tzinfo=dt.UTC) if ident == 2 else None,
                )
            )
        session.add(
            m.InvAlert(
                id=1,
                profile_id=1,
                instrument_id=1,
                scope="instrument",
                kind="price_above",
                params={"level": 11},
                title="Synthetic alert",
                polarity="positive",
                severity="action",
                status="triggered",
                source="user",
                created_by="user",
                created_at=fixed,
                updated_at=recent,
                last_triggered_at=recent,
                expires_at=dt.datetime(2026, 9, 29, tzinfo=dt.UTC),
            )
        )
        session.flush()
        journal.record_decision(
            session,
            1,
            action="held",
            signal_row=session.get(m.InvSignal, 1),
            instrument_id=1,
            reason="Synthetic decision",
            now=recent,
        )
        session.add(
            Review(
                id=1,
                profile_id=1,
                module="investments",
                done_at=dt.datetime(2026, 9, 25, 23, 30, tzinfo=dt.UTC),
                notes="Synthetic review",
                stats={
                    "count": 1,
                    "share": 1.0,
                    "deck": {
                        "agenda": [
                            {"card": "events", "note": "Synthetic agenda"},
                            None,
                            {"card": None},
                        ]
                    },
                },
            )
        )
        session.add(
            m.InvResearchRun(
                id=1,
                profile_id=1,
                started_at=recent,
                finished_at=recent,
                status="done",
                scope={},
                counts={},
            )
        )
        session.flush()
        session.add(
            m.InvResearchNote(
                id=1,
                profile_id=1,
                run_id=1,
                instrument_id=1,
                kind="news",
                polarity="negative",
                strength=3,
                thesis_relation="weakens",
                title="Synthetic research",
                summary="Synthetic research summary",
                sources=[],
                observed_at=recent,
                expires_at=recent + dt.timedelta(days=30),
                created_at=recent,
                updated_at=recent,
            )
        )
        session.commit()
        for profile in profiles[:2]:
            text = yaml if profile.id == 1 else "version: 1\nbase_currency: PLN\nrules: []\n"
            files.write_text_private(files.strategy_yaml_path(profile.slug), text)
            side_files[f"profiles/{profile.slug}/strategy.yaml"] = text
        canon.PATH_ALIASES[:] = [(str(root / "data"), "$DATA_DIR")]
        ids = canon.IdMap(session)
        ctx = Ctx(
            dataset="demo", as_of=dt.date(2026, 10, 1), session=session, ids=ids, profiles=profiles
        )
        wanted = {
            f"investments.{name}"
            for name in (
                "overview",
                "positions",
                "position_detail",
                "allocation_view",
                "watchlist",
                "accounts",
                "review_digest",
                "strategy_status",
            )
        }
        with use_language("en"):
            expected = {check.name: check.run(ctx)[0] for check in CHECKS if check.name in wanted}
            expected_bytes = {name: canon.dumps(value) for name, value in expected.items()}
        feed = {
            "stale": False,
            "events": [
                {
                    "date": "2026-10-05",
                    "time": "14:00",
                    "kind": "macro",
                    "title": "Synthetic release",
                    "country": "PL",
                    "country_label": "Poland",
                    "instrument_id": None,
                    "label": None,
                    "held": False,
                }
            ],
        }
        old_calendar = calendar.calendar_view
        contexts = []
        try:
            calendar.calendar_view = lambda *_args, **_kwargs: feed
            for lang in ("en", "pl"):
                with use_language(lang):
                    for profile in profiles[:2]:
                        tool = SimpleNamespace(
                            session=session, profile=profile, profile_id=profile.id, today=ctx.as_of
                        )
                        contexts.append(
                            {
                                "profile": profile.id,
                                "lang": lang,
                                "calendar": feed,
                                "expected": canon.Canon(ids).value(unlabel(review_context(tool))),
                            }
                        )
        finally:
            calendar.calendar_view = old_calendar
        connection = engine.raw_connection()
        try:
            dump = list(connection.iterdump())
            tables = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
                if not row[0].startswith("sqlite_")
            ]
        finally:
            connection.close()
        sql = [
            "PRAGMA foreign_keys = OFF;",
            *[f'DROP TABLE IF EXISTS "{table}";' for table in sorted(tables)],
            *dump,
            "PRAGMA foreign_keys = ON;",
        ]
    return {
        "sql": "\n".join(sql),
        "files": side_files,
        "expected": expected,
        "expected_bytes": expected_bytes,
        "contexts": contexts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-review-views-") as temporary:
        result = generate(Path(temporary))
        output = formatted(
            json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
            + "\n",
            TARGET,
        )
    if args.check:
        ok = TARGET.exists() and TARGET.read_text() == output
        print(f"review-views: {'pass' if ok else 'stale'}")
        return 0 if ok else 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(output)
    print("review-views: generated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
