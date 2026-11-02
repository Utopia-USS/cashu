#!/usr/bin/env python3
"""Pure projection oracles captured from actual Python views over a shared invented household."""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import functools
import json
import math
import os
import re
import sqlite3
import tempfile
from decimal import Decimal
from enum import Enum
from pathlib import Path

from gen_alert_view_vectors import formatted

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages/domain/src/investments/views/fixtures/portfolio-views.json"


def camel(key):
    return re.sub(r"_([a-z])", lambda match: match[1].upper(), key)


def pack(value):
    if isinstance(value, Decimal):
        return {"$decimal": str(value)}
    if isinstance(value, dt.datetime):
        return {"$datetime": value.isoformat()}
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if dataclasses.is_dataclass(value):
        out = {camel(f.name): pack(getattr(value, f.name)) for f in dataclasses.fields(value)}
        if type(value).__name__ == "ScoredNote":
            for key in ("observedAt", "createdAt", "expiresAt", "dismissedAt"):
                if out.get(key) is not None:
                    out[key] = {"$instant": out[key]["$datetime"]}
        if hasattr(value, "kind"):
            out["kind"] = str(value.kind)
        if type(value).__name__ == "ValuedPortfolio":
            out.update(
                cashBase=pack(value.cash_base),
                totalBase=pack(value.total_base),
                staleWeight=value.stale_weight,
            )
        return out
    if isinstance(value, dict):
        return {"$map": [[pack(k), pack(v)] for k, v in value.items()]}
    if isinstance(value, (set, frozenset)):
        return {"$set": [pack(v) for v in sorted(value)]}
    if isinstance(value, (list, tuple)):
        return [pack(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": repr(value)}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(type(value).__name__)


def plain(value, key=None):
    if isinstance(value, dict):
        return {k: plain(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        if key in ("signal_ids", "instrument_ids", "new_signal_ids", "escalated_signal_ids"):
            return [str(v) for v in value]
        return [plain(v) for v in value]
    if (
        key
        in (
            "id",
            "account_id",
            "instrument_id",
            "watch_item_id",
            "open_txn_id",
            "signal_id",
            "alert_id",
            "note_id",
        )
        and isinstance(value, int)
        and not isinstance(value, bool)
    ):
        return str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": repr(value)}
    return value


def generate(root):
    os.environ.update(
        HOME=str(root),
        CASHU_DATA_DIR=str(root / "data"),
        CASHU_TESTING="1",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_AUTO_DAILY="0",
        TZ="Europe/Warsaw",
    )
    from gen_review_view_vectors import generate as household
    from sqlmodel import Session, create_engine

    from cashu.core.i18n import lang, use_language
    from cashu.core.models import Profile, utcnow
    from cashu.modules.investments import models as m
    from cashu.modules.investments.domain import effective_plan, opened_on
    from cashu.modules.investments.research import service as research_service
    from cashu.modules.investments.research import views as research_views
    from cashu.modules.investments.service import files, hints, portfolio, strategy, views
    from cashu.modules.investments.store import (
        alerts,
        convert,
        instruments,
        journal,
        market,
        signals,
        transactions,
    )

    captured, current = [], {}
    label = "household"
    originals = {
        name: getattr(views, name)
        for name in (
            "positions",
            "position_detail",
            "position_chart",
            "allocation_view",
            "overview",
            "accounts_view",
            "watchlist_view",
        )
    }
    original_build = portfolio.build

    def build(session, profile, **kwargs):
        state = original_build(session, profile, **kwargs)
        current[profile.id] = (session, profile, state)
        return state

    def inputs(session, profile, state, focus=None):
        now = convert.aware(utcnow())
        open_rows, alert_rows, watch_rows = (
            signals.open_signal_rows(session, profile.id),
            alerts.alerts(session, profile.id),
            alerts.watchlist(session, profile.id),
        )
        ids = (
            {convert.pk(key) for key in state.instruments}
            | {w.instrument_id for w in watch_rows}
            | {r.instrument_id for r in open_rows if r.instrument_id is not None}
        )
        if focus is not None:
            ids.add(focus)
        loaded = instruments.load(session, ids, profile_id=profile.id)
        held = {}
        for value in state.valued.valued:
            held.setdefault(convert.pk(value.instrument_id), []).append(value)
        watched = {w.instrument_id for w in watch_rows}
        subject_map = {}
        for iid, inst in loaded.items():
            opened = opened_on((v.holding for v in held.get(iid, ())), state.snapshot.realized)
            plan = effective_plan(inst.plan, held=iid in held, plan_at=inst.plan_at, opened=opened)
            weights = [v.weight for v in held.get(iid, ())]
            weight = (
                views.ratio_pct(sum(weights))
                if weights and all(v is not None for v in weights)
                else None
            )
            subject_map[iid] = hints.Subject(
                inst, iid in held, plan, weight, iid in held or iid in watched
            )
        health = research_views.health_by_instrument(session, profile.id, set(loaded), now)
        notes = hints._notes_after_plans(session, profile.id, subject_map, now)

        def signal(row):
            return {
                "id": str(row.id),
                "ruleId": row.rule_id,
                "kind": row.kind,
                "dedupKey": row.dedup_key,
                "severity": row.severity,
                "polarity": row.polarity,
                "status": row.status,
                "message": row.message,
                "instrumentId": None if row.instrument_id is None else str(row.instrument_id),
                "accountId": None if row.account_id is None else str(row.account_id),
                "payload": plain(row.payload or {}),
                "firstSeenAt": pack(convert.aware(row.first_seen_at)),
                "lastSeenAt": pack(convert.aware(row.last_seen_at)),
                "snoozedUntil": None
                if row.snoozed_until is None
                else pack(convert.aware(row.snoozed_until)),
                "acknowledgedAt": None
                if row.acknowledged_at is None
                else pack(convert.aware(row.acknowledged_at)),
                "closedAt": None if row.closed_at is None else pack(convert.aware(row.closed_at)),
                "createdRun": None if row.created_run_id is None else str(row.created_run_id),
                "lastRun": None if row.last_run_id is None else str(row.last_run_id),
                "rank": {"gid": str(row.id), "hlc": "synthetic-source-order", "eid": str(row.id)},
            }

        def alert(row):
            return {
                "id": str(row.id),
                "instrumentId": None if row.instrument_id is None else str(row.instrument_id),
                "kind": row.kind,
                "title": row.title,
                "source": row.source,
                "status": row.status,
                "severity": row.severity,
                "polarity": row.polarity,
                "params": row.params or {},
                **{
                    camel(key): None
                    if getattr(row, key) is None
                    else pack(convert.aware(getattr(row, key)))
                    for key in (
                        "last_triggered_at",
                        "expires_at",
                        "snoozed_until",
                        "created_at",
                        "updated_at",
                    )
                },
            }

        signal_facts, alert_facts = [signal(r) for r in open_rows], [alert(a) for a in alert_rows]
        subjects = []
        for iid, subject in subject_map.items():
            result, thesis = health[iid]
            subjects.append(
                {
                    "instrument": pack(subject.instrument),
                    "held": subject.held,
                    "hintsWanted": subject.hints,
                    "weight": subject.weight,
                    "health": pack(result),
                    "hasThesis": thesis is not None,
                    "hasExitPlan": bool(thesis is not None and (thesis.exit_plan or "").strip()),
                    "thesisTracked": research_service.researchable(subject.instrument),
                    "plan": subject.plan,
                    "planAt": pack(subject.plan_at),
                    "coreChangedAt": None
                    if thesis is None
                    else pack(research_views.core_changed_at(thesis)),
                    "notes": [{"id": str(n.id), "scored": pack(n)} for n in notes.get(iid, ())],
                    "allOpenSignals": [r for r in signal_facts if r["instrumentId"] == str(iid)],
                    "hintTriggeredAlerts": [
                        a
                        for a in alert_facts
                        if a["instrumentId"] == str(iid) and a["status"] == "triggered"
                    ],
                    "freshnessTriggeredAlerts": [
                        a
                        for a in alert_facts
                        if a["instrumentId"] == str(iid) and a["lastTriggeredAt"] is not None
                    ],
                }
            )
        metadata = originals["accounts_view"](session, profile)
        account_facts = [
            {
                "id": str(a["id"]),
                "name": a["name"],
                "broker": a["broker"],
                "brokerName": a["broker_name"],
                "wrapper": a["wrapper"],
                "currency": a["currency"],
                "importer": a["importer"],
                "hasMapping": a["has_mapping"],
                "active": a["active"],
                "snapshotDate": a["snapshot_date"],
                "lastImport": None
                if a["last_import"] is None
                else {
                    "batchId": str(a["last_import"]["batch_id"]),
                    "at": {"$datetime": a["last_import"]["at"]},
                    "fileName": a["last_import"]["file_name"],
                },
            }
            for a in metadata
        ]
        all_bars = market.bars(session, ids, until=state.as_of)
        run = signals.last_run(session, profile.id)
        run_fact = (
            None
            if run is None
            else {
                "id": str(run.id),
                "trigger": run.trigger,
                "asOf": run.as_of.isoformat(),
                "status": run.status,
                "startedAt": pack(convert.aware(run.started_at)),
                "finishedAt": None
                if run.finished_at is None
                else pack(convert.aware(run.finished_at)),
                "errors": run.errors or [],
                "stats": run.stats or {},
                "newSignalIds": [str(i) for i in (run.report or {}).get("new", [])],
                "escalatedSignalIds": [str(i) for i in (run.report or {}).get("escalated", [])],
            }
        )
        good = signals.last_good_run_id(session, profile.id)
        loaded_strategy = strategy.load(session, profile, record=False)
        yaml_path, md_path = (
            files.strategy_yaml_path(profile.slug),
            files.strategy_md_path(profile.slug),
        )
        raw = {
            "state": {
                "vault": str(profile.id),
                "asOf": state.as_of.isoformat(),
                "base": str(state.base),
                "accounts": account_facts,
                "accountFilter": None if state.account_ids is None else sorted(state.account_ids),
                "txns": pack(state.txns),
                "snapshot": pack(state.snapshot),
                "market": pack(state.market),
                "valued": pack(state.valued),
                "allocation": pack(state.allocation),
                "instruments": pack({str(i): inst for i, inst in loaded.items()}),
                "historyBars": pack(all_bars),
            },
            "facts": {
                "clock": {
                    "now": pack(now),
                    "today": state.as_of.isoformat(),
                    "timeZone": "Europe/Warsaw",
                },
                "subjects": subjects,
                "signals": signal_facts,
                "alerts": alert_facts,
                "watched": [
                    {
                        "id": str(w.id),
                        "instrumentId": str(w.instrument_id),
                        "note": w.note,
                        "tags": w.tags or [],
                        "source": w.source,
                        "addedAt": pack(convert.aware(w.added_at)),
                    }
                    for w in watch_rows
                ],
                "unread": pack(
                    {
                        str(k): v
                        for k, v in research_service.unread_by_instrument(
                            session, profile.id
                        ).items()
                    }
                ),
                "lastRun": run_fact,
                "lastGoodRunId": None if good is None else str(good),
            },
            "strategyFiles": {
                "yaml": yaml_path.read_text() if yaml_path.exists() else None,
                "md": md_path.read_text() if md_path.exists() else None,
                "readError": loaded_strategy.read_error,
            },
            "strategyLatest": None
            if loaded_strategy.version is None
            else {
                "version": loaded_strategy.version.version,
                "sha256": loaded_strategy.version.sha256,
            },
            "options": {
                "lang": lang(),
                "forOwner": True,
                "accounts": None if state.account_ids is None else sorted(state.account_ids),
            },
            "newestRateDate": views.iso(market.newest_rate_date(session)),
            "newestBarDate": views.iso(
                max(market.last_bar_dates(session, set(held)).values(), default=None)
            ),
        }
        if focus is not None:
            raw["instrument"] = pack(loaded[focus])
            raw["chartBars"] = pack(all_bars.get(convert.sid(focus), ()))
            raw["detailBars"] = pack(
                market.bars(
                    session, [focus], until=state.as_of, since=state.as_of - dt.timedelta(days=730)
                ).get(convert.sid(focus), ())
            )
            thesis_rows, decision_rows = (
                journal.theses(session, profile.id, focus),
                journal.decisions(session, profile.id, instrument_id=focus),
            )
            links = journal.decision_signal_ids(session, decision_rows)
            raw["historyWire"] = {
                "theses": plain([views.thesis_dict(t) for t in thesis_rows]),
                "decisions": plain(
                    [views.decision_dict(d, links.get(d.id)) for d in decision_rows]
                ),
                "manual": plain(
                    [
                        views.manual_valuation_dict(v)
                        for v in transactions.manual_valuation_rows(session, profile.id, [focus])
                    ]
                ),
            }
        return raw

    def wrap(name):
        original = originals[name]

        @functools.wraps(original)
        def wrapped(*args, **kwargs):
            result = original(*args, **kwargs)
            if name == "allocation_view":
                state = args[0]
                if state.profile_id not in current:
                    return result
                session, profile, _ = current[state.profile_id]
            else:
                session, profile = args[:2]
                state = args[2] if name == "accounts_view" and len(args) > 2 else None
                if state is None and name == "watchlist_view":
                    state = original_build(
                        session,
                        profile,
                        as_of=kwargs.get("as_of"),
                        strategy=strategy.load(session, profile).config,
                    )
                if state is None:
                    entry = current.get(profile.id)
                    state = entry[2] if entry is not None else original_build(session, profile)
            focus = args[2] if name in ("position_detail", "position_chart") else None
            given = inputs(session, profile, state, focus)
            if name == "accounts_view":
                given["withoutState"] = len(args) < 3 or args[2] is None
            if name == "overview":
                given["options"]["forOwner"] = kwargs.get("for_owner", True)
            captured.append(
                {"label": label, "view": name, "input": given, "expected": plain(result)}
            )
            return result

        return wrapped

    portfolio.build = build
    for name in originals:
        setattr(views, name, wrap(name))
    try:
        fixture = household(root)
        conn = sqlite3.connect(":memory:")
        conn.executescript(fixture["sql"])
        engine = create_engine("sqlite://", creator=lambda: conn)
        with Session(engine) as session, use_language("en"):
            profile = session.get(Profile, 1)
            label = "wire_float_tie"
            for iid, close in ((1, "900719925474099.2"), (2, "4503599627370496.5")):
                session.add(
                    m.InvPriceBar(
                        instrument_id=iid,
                        date=dt.date(2026, 10, 1),
                        close=Decimal(close),
                        currency="PLN",
                        source="synthetic_raw",
                        fetched_at=dt.datetime(2026, 10, 1, 12, tzinfo=dt.UTC),
                    )
                )
            session.commit()
            views.positions(session, profile)
            label = "future_price_metadata"
            session.add(
                m.InvPriceBar(
                    instrument_id=1,
                    date=dt.date(2026, 10, 5),
                    close=Decimal(777),
                    currency="PLN",
                    source="synthetic_raw",
                )
            )
            session.add(
                m.InvPriceBar(
                    instrument_id=3,
                    date=dt.date(2026, 10, 6),
                    close=Decimal(888),
                    currency="PLN",
                    source="synthetic_raw",
                )
            )
            session.commit()
            views.overview(session, profile)
            views.overview(session, profile, for_owner=False)
            label = "sparse_chart_history"
            session.exec(m.InvPriceBar.__table__.delete().where(m.InvPriceBar.instrument_id == 3))
            session.add(
                m.InvPriceBar(
                    instrument_id=3,
                    date=dt.date(2022, 1, 1),
                    close=Decimal(9),
                    currency="PLN",
                    source="synthetic_raw",
                )
            )
            session.commit()
            views.position_detail(session, profile, 3)
            views.position_chart(session, profile, 3)
            label = "future_and_nullable_history"
            session.add(
                m.InvManualValuation(
                    id=1,
                    profile_id=1,
                    instrument_id=1,
                    as_of=dt.date(2026, 10, 8),
                    unit_value=Decimal(99),
                    currency="PLN",
                    note=None,
                )
            )
            session.add(
                m.InvThesis(
                    id=1,
                    profile_id=1,
                    instrument_id=1,
                    entry_type="trend",
                    thesis="Synthetic thesis",
                    invalidation=None,
                    created_at=dt.datetime(2026, 9, 1, tzinfo=dt.UTC),
                    updated_at=dt.datetime(2026, 9, 1, tzinfo=dt.UTC),
                )
            )
            decision = session.get(m.InvDecision, 1)
            decision.reason = None
            session.add(decision)
            session.commit()
            views.position_detail(session, profile, 1)
        # Nested source views repeat identical reads. Keep every distinct input/output, once.
        distinct = {}
        for case in captured:
            distinct.setdefault(
                json.dumps(case, sort_keys=True, ensure_ascii=False, allow_nan=False), case
            )
        return {"cases": list(distinct.values())}
    finally:
        portfolio.build = original_build
        for name, original in originals.items():
            setattr(views, name, original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-portfolio-view-") as root:
        value = generate(Path(root))
        text = formatted(json.dumps(value, ensure_ascii=False, allow_nan=False), TARGET)
        if args.check:
            if not TARGET.exists() or TARGET.read_text() != text:
                raise SystemExit("portfolio-views: stale synthetic vectors")
            print(f"portfolio-views: pass; cases={len(value['cases'])}")
        else:
            TARGET.parent.mkdir(parents=True, exist_ok=True)
            TARGET.write_text(text)
            print(f"portfolio-views: generated; cases={len(value['cases'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
