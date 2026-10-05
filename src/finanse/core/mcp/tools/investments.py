"""Investments MCP tools: thin adapters over ``modules.investments`` (JSON views, journal, strategy,
import preview). The views return absolute amounts; here every field gets its label, so strict mode
sends weights, percentages and dates only.

Read: ``portfolio_overview``, ``positions``, ``signals``, ``strategy_status``, ``history_metrics``,
``theses``, ``inspect_export``, ``validate_import``. Write: ``record_decision``, ``upsert_thesis``,
``propose_strategy``, ``propose_custom_rule``, ``propose_import`` (proposals are approved in the app).
"""

from __future__ import annotations

import datetime as dt
import logging
import math

from sqlmodel import func, select

from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec

# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #


def _views():
    from finanse.modules.investments.service import views

    return views


def _date(value: str | None):
    if not value:
        return None
    try:
        return (
            dt.datetime.fromisoformat(value).date()
            if "T" in value
            else dt.date.fromisoformat(value)
        )
    except ValueError:
        return None


PRIVATE_CLASSES = ("claim", "other")


def owner_named(
    asset_class: str | None, valuation_mode: str | None, isin: str | None = None
) -> bool:
    """An instrument the owner named (a claim, a private loan, a manually valued asset without an
    ISIN): its name and symbol may carry a person's name, so they are identifiers."""
    return asset_class in PRIVATE_CLASSES or (valuation_mode == "manual" and not isin)


def _instrument_fields(inst: dict | None) -> dict:
    if not inst:
        return {"symbol": L.symbol(None), "name": L.text(None)}
    private = owner_named(inst.get("asset_class"), inst.get("valuation_mode"), inst.get("isin"))
    return {
        "instrument_id": L.ref(inst["id"]) if isinstance(inst.get("id"), int) else L.ref(None),
        "symbol": L.identifier(inst.get("symbol")) if private else L.symbol(inst.get("symbol")),
        "isin": L.symbol(inst.get("isin")),
        "name": L.identifier(inst.get("name")) if private else L.text(inst.get("name")),
        "owner_named": L.flag(private),
        "asset_class": L.category(inst.get("asset_class")),
        "currency": L.category(inst.get("currency")),
        "region": L.category(inst.get("region")),
        "tags": [L.category(t) for t in inst.get("tags") or []],
        "valuation_mode": L.category(inst.get("valuation_mode")),
        "needs_classification": L.flag(inst.get("needs_classification")),
    }


def _run(run: dict | None) -> dict | None:
    if not run:
        return None
    return {
        "status": L.category(run.get("status")),
        "trigger": L.category(run.get("trigger")),
        "as_of": L.date(run.get("as_of")),
        "finished_at": L.date(run.get("finished_at")),
        "new_signals": L.count(len(run.get("new_signal_ids") or [])),
        "escalated_signals": L.count(len(run.get("escalated_signal_ids") or [])),
        "errors": L.count(len(run.get("errors") or [])),
    }


def _account_rows(ctx: ToolContext, accounts: list[dict]) -> list[dict]:
    labels = ctx.account_labels
    return [
        {
            "account": L.account(labels.get(a["id"])),
            "name": L.identifier(a.get("name")),
            "broker": L.category(a.get("broker")),
            "wrapper": L.category(a.get("wrapper")),
            "currency": L.category(a.get("currency")),
            "share": L.pct(a.get("share")),
            "value": L.amount(a.get("value")),
            "snapshot_date": L.date(a.get("snapshot_date")),
            "last_import": L.date((a.get("last_import") or {}).get("at")),
            "last_import_file": L.identifier((a.get("last_import") or {}).get("file_name")),
        }
        for a in accounts
    ]


def profile_instrument(ctx: ToolContext, instrument: str) -> int:
    """An instrument the profile references, by id, symbol or ISIN (case-insensitive)."""
    from finanse.modules.investments.models import InvInstrument
    from finanse.modules.investments.store.instruments import profile_instrument_ids

    ids = profile_instrument_ids(ctx.session, ctx.profile_id)
    text = (instrument or "").strip()
    if text.isdigit() and int(text) in ids:
        return int(text)
    rows = (
        ctx.session.exec(select(InvInstrument).where(InvInstrument.id.in_(ids))).all()
        if ids
        else []
    )
    wanted = text.upper()
    matches = [
        r.id for r in rows if (r.symbol or "").upper() == wanted or (r.isin or "").upper() == wanted
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ToolError("several instruments match; pass the instrument_id from positions")
    raise ToolError("no such instrument in this profile (see positions)", "not_found")


def name_sources(session, profile_id: int) -> tuple[set[str], set[str]]:
    """Names the redaction masks in free text: the owner-given names and symbols of the profile's
    claims and manually valued instruments (a private loan is often named after a person, and rule
    messages embed instrument labels)."""
    from sqlalchemy import inspect as sa_inspect

    if "inv_instruments" not in sa_inspect(session.get_bind()).get_table_names():
        return set(), set()
    from finanse.modules.investments.models import InvInstrument
    from finanse.modules.investments.store.instruments import profile_instrument_ids, profile_rows

    ids = profile_instrument_ids(session, profile_id)
    if not ids:
        return set(), set()
    # The profile's own view decides (its overrides, F5 R2); the shared name / symbol of such an
    # instrument is masked too.
    rows = [
        r
        for r in profile_rows(session, profile_id, ids)
        if owner_named(r.asset_class, r.valuation_mode, r.isin)
    ]
    shared = {
        r.id: r
        for r in session.exec(
            select(InvInstrument).where(InvInstrument.id.in_([r.id for r in rows]))
        ).all()
    }
    rows += [shared[r.id] for r in rows if r.id in shared]
    return {r.name for r in rows if r.name} | {r.symbol for r in rows if r.symbol}, set()


def owner_named_ids(ctx: ToolContext) -> set[int]:
    from finanse.modules.investments.store.instruments import profile_instrument_ids, profile_rows

    ids = profile_instrument_ids(ctx.session, ctx.profile_id)
    if not ids:
        return set()
    rows = profile_rows(ctx.session, ctx.profile_id, ids)  # the profile's view (F5 R2)
    return {r.id for r in rows if owner_named(r.asset_class, r.valuation_mode, r.isin)}


def _instrument_label(owned: set[int], instrument_id, label) -> L.Labelled:
    """An instrument label (symbol or name): an identifier for owner-named instruments."""
    return L.identifier(label) if instrument_id in owned else L.text(label)


def strong_names(session, profile_id: int) -> set[str]:
    """Owner-named instruments' names and symbols, masked word by word in free text (a one-word
    name like "KOWALSKI" is still masked)."""
    return name_sources(session, profile_id)[0]


# --------------------------------------------------------------------------- #
# Freshness / review stats (used by core tools)
# --------------------------------------------------------------------------- #


def freshness(ctx: ToolContext) -> dict:
    from finanse.modules.investments.models import InvTransaction
    from finanse.modules.investments.service import strategy as strategy_files
    from finanse.modules.investments.store import market, signals
    from finanse.modules.investments.store.instruments import profile_instrument_ids
    from finanse.modules.investments.store.transactions import brokerage_accounts

    s, pid = ctx.session, ctx.profile_id
    accounts = [a.id for a in brokerage_accounts(s, pid)]
    count = (
        s.exec(
            select(func.count(InvTransaction.id)).where(InvTransaction.account_id.in_(accounts))
        ).one()
        if accounts
        else 0
    )
    bars = market.last_bar_dates(s, profile_instrument_ids(s, pid))
    st = strategy_files.load(s, ctx.profile)
    return {
        "transactions": L.count(int(count)),
        "prices_newest": L.date(max(bars.values(), default=None)),
        "fx_newest": L.date(market.newest_rate_date(s)),
        "strategy": L.category(st.state),
        "last_run": _run(_views().run_dict(signals.last_run(s, pid))),
    }


def review_stats(ctx: ToolContext) -> dict[str, int]:
    return investments_review_stats(ctx.session, ctx.profile_id)


def investments_review_stats(session, profile_id: int) -> dict[str, int]:
    """Counts stored with an investments review: open / action signals, decisions since the last
    review (also used by ``POST /api/p/{slug}/reviews``)."""
    from finanse.core import reviews
    from finanse.modules.investments.models import InvDecision
    from finanse.modules.investments.store import signals

    rows = signals.open_signal_rows(session, profile_id)
    previous = reviews.last(session, profile_id, "investments")
    query = select(func.count(InvDecision.id)).where(InvDecision.profile_id == profile_id)
    if previous is not None:
        query = query.where(InvDecision.created_at > previous.done_at)
    return {
        "open_signals": len(rows),
        "action_signals": sum(r.severity == "action" for r in rows),
        "decisions_since_last_review": int(session.exec(query).one()),
    }


# --------------------------------------------------------------------------- #
# Read tools
# --------------------------------------------------------------------------- #


def portfolio_overview(ctx: ToolContext) -> dict:
    ov = _views().overview(ctx.session, ctx.profile)
    owned = owner_named_ids(ctx)
    k, alloc, fresh = ov["kpis"], ov["allocation"], ov["freshness"]
    total = k["value"]["total"]
    unclassified = alloc.get("unclassified") or {}
    band = alloc.get("band") or {}
    max_drift = k.get("max_drift")
    strategy = fresh["strategy"]
    return {
        "as_of": L.date(ov["as_of"]),
        "base_currency": L.category(ov["base_currency"]),
        "has_strategy": L.flag(alloc.get("has_strategy")),
        "total": L.amount(total),
        "holdings_weight": L.share(k["value"]["holdings"], total),
        "cash_weight": L.pct(k["cash"]["weight"]),
        "cash_accounts": L.count(k["cash"]["accounts"]),
        "unrealized_pct": L.pct(k["unrealized"]["pct"]),
        "unrealized": L.amount(k["unrealized"]["amount"]),
        "realized": L.amount(k.get("realized")),
        "buckets": [
            {
                "bucket": L.category(b["bucket_id"]),
                "weight": L.pct(b["weight"]),
                "target": L.pct(b["target"]),
                "drift_pp": L.pct(b["drift_pp"], 4),
                "out_of_band": L.flag(b["out_of_band"]),
                "band_note": L.text(b.get("band_note")),
                "instruments": L.count(len(b.get("instrument_ids") or [])),
                "cash_history_gap": L.flag(bool(b.get("cash_history_gap"))),
                "value": L.amount(b.get("value")),
                "to_target": L.amount(b.get("to_target")),
            }
            for b in alloc.get("buckets") or []
        ],
        "unclassified": {
            "weight": L.pct(unclassified.get("weight")),
            "instruments": [
                _instrument_label(owned, i.get("id"), i.get("label"))
                for i in unclassified.get("instruments") or []
            ],
            "value": L.amount(unclassified.get("value")),
        },
        "by_asset_class": [
            {
                "key": L.category(r["key"]),
                "weight": L.pct(r["weight"]),
                "value": L.amount(r["value"]),
            }
            for r in alloc.get("by_asset_class") or []
        ],
        "by_region": [
            {
                "key": L.category(r["key"]),
                "weight": L.pct(r["weight"]),
                "value": L.amount(r["value"]),
            }
            for r in alloc.get("by_region") or []
        ],
        "band": {
            "absolute_band_pp": L.pct(band.get("absolute_band_pp"), 4),
            "relative_band": L.pct(band.get("relative_band")),
            "min_trade_value": L.amount(band.get("min_trade_value")),
        },
        "signals": {
            "action": L.count(k["signals"]["action"]),
            "info": L.count(k["signals"]["info"]),
            "new": L.count(k["signals"]["new"]),
        },
        "max_drift": None
        if not max_drift
        else {
            "bucket": L.category(max_drift["bucket_id"]),
            "drift_pp": L.pct(max_drift["drift_pp"], 4),
            "out_of_band": L.flag(max_drift["out_of_band"]),
        },
        "out_of_band": L.count(k["out_of_band"]),
        "last_run": _run(k.get("last_run")),
        "freshness": {
            "newest_bar": L.date(fresh["prices"]["newest_bar"]),
            "stale_count": L.count(fresh["prices"]["stale_count"]),
            "stale_weight": L.pct(fresh["prices"]["stale_weight"]),
            "stale": [
                {
                    "label": _instrument_label(owned, x.get("instrument_id"), x.get("label")),
                    "price_date": L.date(x.get("price_date")),
                }
                for x in fresh["prices"]["stale"]
            ],
            "fx_newest": L.date(fresh["fx"]["newest_rate"]),
            "fx_missing": [L.category(c) for c in fresh["fx"]["missing"]],
            "strategy": {
                "state": L.category(strategy["state"]),
                "version": L.count(strategy["version"]),
                "changed": L.flag(strategy["changed"]),
                "errors": L.count(strategy["errors"]),
                "warnings": L.count(strategy["warnings"]),
                "inactive_rules": L.count(strategy["inactive_rules"]),
            },
        },
        "warnings": [
            {"kind": L.category(w.get("kind")), "message": L.text(w.get("message"))}
            for w in ov.get("warnings") or []
        ],
        "accounts": _account_rows(ctx, ov.get("accounts") or []),
    }


def positions(ctx: ToolContext) -> dict:
    view = _views().positions(ctx.session, ctx.profile)
    total = view["total"]
    labels = ctx.account_labels
    today = ctx.today
    rows = []
    for p in view["positions"]:
        lots = p.get("lots") or []
        open_dates = [d for d in (_date(lot.get("open_date")) for lot in lots) if d is not None]
        weighted_days = None
        quantities = [(lot.get("quantity") or 0, _date(lot.get("open_date"))) for lot in lots]
        total_q = sum(q for q, d in quantities if d is not None)
        if total_q:
            weighted_days = round(
                sum(q * (today - d).days for q, d in quantities if d is not None) / total_q
            )
        rows.append(
            _instrument_fields(p["instrument"])
            | {
                "bucket": L.category(p.get("bucket")),
                "weight": L.pct(p.get("weight")),
                "unrealized_pct": L.pct(p.get("unrealized_pct")),
                "price_date": L.date(p.get("price_date")),
                "is_stale": L.flag(p.get("is_stale")),
                "holding_days_oldest": L.count(
                    (today - min(open_dates)).days if open_dates else None
                ),
                "holding_days_avg": L.count(weighted_days),
                "lots": L.count(len(lots)),
                "open_signals": L.count(p.get("open_signals")),
                "has_thesis": L.flag(p.get("has_thesis")),
                "accounts": [
                    {
                        "account": L.account(labels.get(a.get("account_id"))),
                        "weight": L.pct(a.get("weight")),
                        "unrealized_pct": L.pct(a.get("unrealized_pct")),
                        "quantity": L.amount(a.get("quantity")),
                        "value": L.amount(a.get("value")),
                    }
                    for a in p.get("accounts") or []
                ],
                "quantity": L.amount(p.get("quantity")),
                "price": L.amount(p.get("price")),
                "value": L.amount(p.get("value")),
                "cost": L.amount(p.get("cost")),
                "realized": L.amount(p.get("realized")),
            }
        )
    return {
        "as_of": L.date(view["as_of"]),
        "base_currency": L.category(view["base_currency"]),
        "base_note": L.text(
            "weight: share of the portfolio total (holdings + cash) in base currency"
        ),
        "positions": rows,
        "cash": [
            {
                "account": L.account(labels.get(c.get("account_id"))),
                "currency": L.category(c.get("currency")),
                "weight": L.share(c.get("amount_base"), total),
                "amount": L.amount(c.get("amount")),
            }
            for c in view["cash"]
        ],
        "total": L.amount(total),
    }


_MEASURES: dict[str, tuple[str, str, str]] = {
    # kind: (measured key, threshold key, unit)
    "allocation_drift": ("drift_pp", "absolute_band_pp", "pp"),
    "position_concentration": ("weight", "max_weight", "ratio"),
    "loss_from_cost": ("unrealized_pct", "threshold", "ratio"),
    "gain_from_cost": ("unrealized_pct", "threshold", "ratio"),
    "drawdown_from_high": ("drawdown", "threshold", "ratio"),
    "tagged_weight": ("weight", "max_weight", "ratio"),
}


def _measure(kind: str, payload: dict) -> dict:
    if kind in _MEASURES:
        measured, threshold, unit = _MEASURES[kind]
        return {
            "measured": L.pct(payload.get(measured)),
            "threshold": L.pct(payload.get(threshold)),
            "unit": L.category(unit),
        }
    if kind == "cash_level":
        direction = payload.get("direction")
        limit = payload.get("min_weight") if direction == "below_min" else payload.get("max_weight")
        return {
            "measured": L.pct(payload.get("cash_weight")),
            "threshold": L.pct(limit),
            "unit": L.category("ratio"),
        }
    if kind == "contribution_gap":
        allowed = (payload.get("period_days") or 0) + (payload.get("grace_days") or 0)
        days = payload.get("days_since_last_deposit")
        return {
            "measured": L.count(days if isinstance(days, int) else None),
            "threshold": L.count(allowed or None),
            "unit": L.category("days"),
        }
    if kind == "custom":
        from finanse.modules.investments.rules.expr.catalog import METRICS, Unit

        values = []
        for label, value in (payload.get("values") or {}).items():
            metric = METRICS.get(label.split("(", 1)[0])
            unit = metric.unit if metric else None
            if unit in (Unit.RATIO, Unit.PP) and isinstance(value, (int, float)):
                values.append(
                    {
                        "metric": L.text(label),
                        "measured": L.pct(value),
                        "unit": L.category(unit.value),
                    }
                )
            elif unit in (Unit.DAYS, Unit.COUNT) and isinstance(value, int):
                values.append(
                    {
                        "metric": L.text(label),
                        "measured": L.count(value),
                        "unit": L.category(unit.value),
                    }
                )
            elif isinstance(value, bool):
                values.append(
                    {"metric": L.text(label), "measured": L.flag(value), "unit": L.category("flag")}
                )
        return {"condition": L.text(payload.get("when")), "values": values}
    return {}


def signals(ctx: ToolContext, status: str = "open") -> dict:
    owned = owner_named_ids(ctx)
    rows = _views().signals_view(ctx.session, ctx.profile, status if status != "all" else "all")
    out = []
    for r in rows:
        payload = r.get("payload") or {}
        first = _date(r.get("first_seen_at"))
        if r.get("instrument_id"):
            private = r.get("instrument_id") in owned
            scope = {
                "type": L.category("instrument"),
                "instrument_id": L.ref(r.get("instrument_id")),
                "symbol": L.identifier(payload.get("symbol"))
                if private
                else L.symbol(payload.get("symbol")),
                "label": L.identifier(r.get("instrument_label"))
                if private
                else L.text(r.get("instrument_label")),
            }
        elif payload.get("bucket_id"):
            scope = {"type": L.category("bucket"), "bucket": L.category(payload.get("bucket_id"))}
        else:
            scope = {"type": L.category("portfolio")}
        out.append(
            {
                "signal_id": L.ref(r["id"]),
                "rule": L.text(r["rule_id"]),
                "kind": L.category(r["kind"]),
                "severity": L.category(r["severity"]),
                "status": L.category(r["status"]),
                "scope": scope,
                **_measure(r["kind"], payload),
                "direction": L.category(payload.get("direction")),
                "message": L.text(r.get("message")),
                "first_seen": L.date(r.get("first_seen_at")),
                "last_seen": L.date(r.get("last_seen_at")),
                "age_days": L.count((ctx.today - first).days if first else None),
                "acknowledged": L.date(r.get("acknowledged_at")),
                "closed": L.date(r.get("closed_at")),
                "decisions": [
                    {
                        "action": L.category(d.get("action")),
                        "reason": L.text(d.get("reason")),
                        "created_at": L.date(d.get("created_at")),
                    }
                    for d in r.get("decisions") or []
                ],
            }
        )
    return {"status": L.category(status), "signals": out}


def strategy_status(ctx: ToolContext) -> dict:
    st = _views().strategy_status(ctx.session, ctx.profile)
    facts = st.get("facts") or {}

    def issue(i: dict) -> dict:
        return {
            "severity": L.category(i.get("severity")),
            "path": L.text(i.get("path")),
            "message": L.text(i.get("message")),
            "line": L.count(i.get("line")),
            "column": L.count(i.get("column")),
        }

    contributions = facts.get("contributions") or {}
    notifications = facts.get("notifications") or {}
    return {
        "state": L.category(st["state"]),
        "version": L.count(st.get("version")),
        "changed": L.flag(st.get("changed")),
        "errors": L.count(st.get("errors")),
        "warnings": L.count(st.get("warnings")),
        "files_present": {
            "yaml": L.flag(st["files"]["yaml_exists"]),
            "md": L.flag(st["files"]["md_exists"]),
            "yaml_path": L.identifier(st["files"]["yaml"]),
        },
        "read_error": L.flag(bool(st.get("read_error"))),
        "issues": [issue(i) for i in st.get("issues") or []],
        "inactive_rules": [
            {
                "index": L.count(r.get("index")),
                "rule": L.text(r.get("rule_id")),
                "kind": L.category(r.get("kind")),
                "line": L.count(r.get("line")),
                "issues": [issue(i) for i in r.get("issues") or []],
            }
            for r in st.get("inactive_rules") or []
        ],
        "facts": None
        if not facts
        else {
            "base_currency": L.category(facts.get("base_currency")),
            "buckets": [L.category(b) for b in facts.get("buckets") or []],
            "targets": [
                {"bucket": L.category(str(k)), "target": L.pct(v)}
                for k, v in (facts.get("targets") or {}).items()
            ],
            "rules": [
                {
                    "rule": L.text(r.get("id")),
                    "kind": L.category(r.get("kind")),
                    "severity": L.category(r.get("severity")),
                    "cooldown_days": L.count(r.get("cooldown_days")),
                }
                for r in facts.get("rules") or []
            ],
            "horizon_years": L.count(facts.get("horizon_years")),
            "contributions": {
                "day_of_month": L.count(contributions.get("day_of_month")),
                "monthly_amount": L.amount(contributions.get("monthly_amount")),
            }
            if contributions
            else None,
            "notifications": {
                "immediate": [L.category(x) for x in notifications.get("immediate") or []],
                "digest_weekday": L.category(notifications.get("digest_weekday")),
            },
        },
        "base_currency_note": L.text(st.get("base_currency_note")),
        "versions": [
            {
                "version": L.count(v.get("version")),
                "state": L.category(v.get("state")),
                "created_at": L.date(v.get("created_at")),
                "issues": L.count(v.get("issues")),
            }
            for v in st.get("versions") or []
        ],
    }


def theses(ctx: ToolContext, instrument: str | None = None) -> dict:
    from finanse.modules.investments.store import instruments as instrument_store
    from finanse.modules.investments.store import journal

    iid = profile_instrument(ctx, instrument) if instrument else None
    rows = journal.theses(ctx.session, ctx.profile_id, iid)
    insts = instrument_store.load(
        ctx.session, {r.instrument_id for r in rows}, profile_id=ctx.profile_id
    )
    return {
        "theses": [
            {
                "thesis_id": L.ref(r.id),
                "instrument_id": L.ref(r.instrument_id),
                **_thesis_instrument(insts.get(r.instrument_id)),
                "entry_type": L.category(r.entry_type),
                "thesis": L.text(r.thesis),
                "invalidation": L.text(r.invalidation),
                "exit_plan": L.text(r.exit_plan),
                "size_plan": L.text(r.size_plan),
                "reviewed_at": L.date(r.reviewed_at),
                "created_at": L.date(r.created_at),
                "updated_at": L.date(r.updated_at),
            }
            for r in rows
        ]
    }


def _thesis_instrument(inst) -> dict:
    if inst is None:
        return {"symbol": L.symbol(None), "name": L.text(None)}
    mode = inst.valuation_mode.value if inst.valuation_mode else None
    if owner_named(inst.asset_class.value, mode, inst.isin):
        return {"symbol": L.identifier(inst.symbol), "name": L.identifier(inst.name)}
    return {"symbol": L.symbol(inst.symbol), "name": L.text(inst.name)}


def history_metrics(ctx: ToolContext) -> dict:
    from .investments_history import history_metrics as compute

    out = compute(ctx)
    if "activity" in out:  # there is a history: add the performance metrics
        out.pop("not_measured", None)
        out["performance"] = _performance_metrics(ctx)
    return out


def _safe_pct(value) -> L.Labelled:
    """A fraction as a percent label; absurd or non-finite values (a short span annualized) are None."""
    if value is None:
        return L.pct(None)
    number = float(value)
    if not math.isfinite(number) or abs(number) > 100:
        return L.pct(None)
    return L.pct(number)


def _drawdown_fields(prefix: str, dd) -> dict:
    return {
        prefix: _safe_pct(None if dd is None else dd.depth),
        f"{prefix}_peak": L.date(None if dd is None else dd.peak),
        f"{prefix}_trough": L.date(None if dd is None else dd.trough),
        f"{prefix}_recovered": L.date(None if dd is None else dd.recovered),
    }


def _performance_metrics(ctx: ToolContext) -> dict:
    """Return vs the benchmark, max drawdowns, profit concentration and rolling relative performance
    over the whole history (``modules.investments.performance``), as fractions, dates and counts only:
    no amount leaves in either privacy mode."""
    from finanse.modules.investments.performance import service as perf

    try:
        data = perf.mcp_summary(ctx.session, ctx.profile, as_of=ctx.today)
    except Exception:  # the other history metrics still answer
        logging.getLogger("finanse.mcp").exception("performance metrics failed")
        return {"note": L.text("performance metrics could not be computed")}
    if data is None:
        return {"note": L.text("no investments history yet")}
    s, b, meta, conc = (
        data["summary"],
        data["benchmark"],
        data["benchmark_meta"],
        data["concentration"],
    )
    shares = dict(conc.top_shares)
    return {
        "since": L.date(data["since"]),
        "as_of": L.date(data["as_of"]),
        "base_currency": L.category(data["base_currency"]),
        "return": {
            "twr": _safe_pct(s["twr"]),
            "twr_annualized": _safe_pct(s["twr_annualized"]),
            "xirr": _safe_pct(s["xirr"]),
            "money_weighted": _safe_pct(s["mwr"]),
            "days": L.count(s["days"]),
        },
        "benchmark": {
            "id": L.category(meta["id"]),
            "proxy": L.symbol(meta["proxy"]),
            "status": L.category(meta["status"]),
            "covers_history": L.flag(b.get("covers_range")),
            "twr": _safe_pct(b.get("twr")),
            "twr_annualized": _safe_pct(b.get("twr_annualized")),
            "simulation_xirr": _safe_pct(b.get("simulation_xirr")),
            "simulation_money_weighted": _safe_pct(b.get("simulation_mwr")),
            "excess_twr": _safe_pct(b.get("excess_twr")),
            "excess_vs_simulation": _safe_pct(b.get("excess_vs_simulation")),
        },
        "max_drawdown": {
            **_drawdown_fields("portfolio", s["max_drawdown"]),
            **_drawdown_fields("benchmark", b.get("max_drawdown")),
        },
        "profit_concentration": {
            "instruments_positive": L.count(conc.positive),
            "instruments_negative": L.count(conc.negative),
            "top1_share": _safe_pct(shares.get(1)),
            "top2_share": _safe_pct(shares.get(2)),
            "top3_share": _safe_pct(shares.get(3)),
            "top5_share": _safe_pct(shares.get(5)),
            "pnl_pct_of_contributions": _safe_pct(data["pnl_pct_of_contributions"]),
            "without_top2_pct_of_contributions": _safe_pct(
                data["without_top2_pct_of_contributions"]
            ),
            "benchmark_pnl_pct_of_contributions": _safe_pct(
                data["benchmark_pnl_pct_of_contributions"]
            ),
        },
        "rolling_relative": [
            {
                "months": L.count(r["months"]),
                "windows": L.count(r["windows"]),
                "latest_date": L.date(None if r["latest"] is None else r["latest"].date),
                "latest_excess": _safe_pct(None if r["latest"] is None else r["latest"].excess),
                "min_excess": _safe_pct(r["min_excess"]),
                "max_excess": _safe_pct(r["max_excess"]),
                "share_outperforming": _safe_pct(r["share_outperforming"]),
            }
            for r in data["rolling"]
        ],
        "per_year": [
            {
                "year": L.count(y.year),
                "portfolio_twr": _safe_pct(y.portfolio),
                "benchmark": _safe_pct(y.benchmark),
                "partial_year": L.flag(y.partial),
            }
            for y in data["per_year"]
        ],
        "data_quality": {
            "incomplete_days": L.count(s["incomplete_days"]),
            "implied_funding": L.flag(bool(s["implied_funding"])),
        },
        "note": L.text(
            "values are fractions, not percent; twr is contributions-neutral, money_weighted and "
            "xirr follow the deposits; the benchmark simulation puts the same deposits on the same "
            "days into the proxy; excess = portfolio minus benchmark; rolling windows are "
            "cumulative, not annualized"
        ),
    }


def inspect_export(ctx: ToolContext, path: str, max_samples: int = 5) -> dict:
    from .exports import inspect

    return inspect(path, max_samples=max_samples, slug=ctx.profile.slug)


def validate_import(ctx: ToolContext, path: str, mapping: str | None = None) -> dict:
    from .investments_proposals import validate_file

    return validate_file(ctx, path, mapping=mapping)


# --------------------------------------------------------------------------- #
# Write tools
# --------------------------------------------------------------------------- #


def record_decision(
    ctx: ToolContext, signal_id: int, action: str, reason: str | None = None
) -> dict:
    from finanse.modules.investments.store import journal

    row = journal.signal(ctx.session, ctx.profile_id, signal_id)
    if row is None:
        raise ToolError("no such signal in this profile (see signals)", "not_found")
    try:
        decision = journal.record_decision(
            ctx.session, ctx.profile_id, action=action, signal_row=row, reason=reason
        )
    except journal.JournalError as e:
        raise ToolError(str(e)) from None
    return {
        "decision_id": L.ref(decision.id),
        "signal_id": L.ref(row.id),
        "action": L.category(decision.action),
        "signal_status": L.category(row.status),
        "note": L.text("recorded in the decision journal; no transaction was booked"),
    }


def upsert_thesis(
    ctx: ToolContext,
    instrument: str,
    entry_type: str,
    thesis: str,
    invalidation: str | None = None,
    exit_plan: str | None = None,
    size_plan: str | None = None,
) -> dict:
    from finanse.modules.investments.store import journal

    iid = profile_instrument(ctx, instrument)
    values = {"entry_type": entry_type, "thesis": thesis}
    # Optional fields only when given: an update never wipes the owner's plans.
    for key, value in (
        ("invalidation", invalidation),
        ("exit_plan", exit_plan),
        ("size_plan", size_plan),
    ):
        if value is not None:
            values[key] = value
    existing = journal.theses(ctx.session, ctx.profile_id, iid)
    try:
        if existing:
            row = journal.update_thesis(ctx.session, existing[0], values)
            created = False
        else:
            row = journal.create_thesis(ctx.session, ctx.profile_id, iid, values)
            created = True
    except journal.JournalError as e:
        raise ToolError(str(e)) from None
    return {
        "thesis_id": L.ref(row.id),
        "instrument_id": L.ref(iid),
        "created": L.flag(created),
        "entry_type": L.category(row.entry_type),
    }


def propose_strategy(
    ctx: ToolContext,
    yaml: str,
    md: str | None = None,
    reason: str | None = None,
    dry_run: bool = False,
) -> dict:
    from .investments_proposals import propose_strategy as propose

    return propose(ctx, yaml, md, reason, dry_run=dry_run)


def propose_custom_rule(
    ctx: ToolContext,
    kind_or_expression: str,
    params: dict | None = None,
    reason: str | None = None,
    dry_run: bool = False,
) -> dict:
    from .investments_proposals import propose_custom_rule as propose

    return propose(ctx, kind_or_expression, params or {}, reason, dry_run=dry_run)


def propose_import(
    ctx: ToolContext,
    path: str,
    account: str,
    mapping: str | None = None,
    importer: str = "auto",
    reason: str | None = None,
) -> dict:
    from .investments_proposals import propose_import as propose

    return propose(ctx, path, account, mapping=mapping, importer=importer, reason=reason)


def accounts_hint(ctx: ToolContext) -> list[dict]:
    """Brokerage accounts as the agent may name them (``propose_import(account=...)``)."""
    from finanse.modules.investments.service.accounts import account_dict
    from finanse.modules.investments.store.transactions import brokerage_accounts

    labels = ctx.account_labels
    return [
        {
            "account": L.account(labels.get(a.id)),
            "account_id": L.ref(a.id),
            "wrapper": L.category(account_dict(ctx.session, a).get("wrapper")),
        }
        for a in brokerage_accounts(ctx.session, ctx.profile_id)
    ]


_PATH = {"type": "string", "maxLength": 1024, "description": "local file path"}
_MAPPING = {
    "type": "string",
    "maxLength": 64_000,
    "description": "generic CSV mapping: YAML text or a path to a .yaml/.yml file",
}
# The app never runs agent-written code (F5 R1): a converter is run by the agent itself, under
# its own permission prompts, and the finanse-format file it writes is what these tools take.
_NO_SCRIPTS = {
    "converter": "the app never runs scripts: run your converter yourself (python3 <script> "
    "<export> <output.csv>) and pass the finanse-format output file as path"
}
_TEXT = {"type": "string", "maxLength": 4000}

TOOLS = (
    ToolSpec(
        "portfolio_overview",
        "investments",
        "Portfolio: bucket weights vs targets, drift in pp and band flags, unrealized %, cash weight, "
        "data freshness, last rule run, warnings, accounts (generated labels).",
        portfolio_overview,
    ),
    ToolSpec(
        "positions",
        "investments",
        "Per instrument: symbol, name, weight, unrealized %, tags, bucket, valuation mode, holding "
        "days, open signals, thesis flag; cash weights per account.",
        positions,
    ),
    ToolSpec(
        "signals",
        "investments",
        "Rule signals: rule, scope, measured vs threshold (as ratio / pp / days), severity, age, "
        "decisions. status: open (default), history or all.",
        signals,
        properties={
            "status": {"type": "string", "enum": ["open", "history", "all"], "default": "open"}
        },
    ),
    ToolSpec(
        "strategy_status",
        "investments",
        "Strategy validation issues (line / column), rules, inactive rules, version history.",
        strategy_status,
    ),
    ToolSpec(
        "history_metrics",
        "investments",
        "Retrospective metrics computed locally from the transaction history: activity gaps, "
        "deposits per year, sells after drawdowns, buys after run-ups, price change after sales, "
        "holding days of winners vs losers, fees as % of turnover, concentration over time.",
        history_metrics,
    ),
    ToolSpec(
        "theses",
        "investments",
        "Position theses (entry type, thesis, invalidation, exit and size plans), optionally of "
        "one instrument (id, symbol or ISIN).",
        theses,
        properties={"instrument": {"type": "string", "maxLength": 40}},
    ),
    ToolSpec(
        "inspect_export",
        "investments",
        "Structure of a broker export file (CSV, TSV, JSON, XLSX): sheets, columns, inferred types, "
        "row counts and masked sample rows (amounts, identifiers and names never shown).",
        inspect_export,
        properties={
            "path": _PATH,
            "max_samples": {"type": "integer", "minimum": 0, "maximum": 20, "default": 5},
        },
        required=("path",),
    ),
    ToolSpec(
        "validate_import",
        "investments",
        "Validate a finanse-format file (or a CSV with a mapping): counts and errors by kind with "
        "row numbers, no values. The app never runs scripts: convert other exports yourself first.",
        validate_import,
        properties={"path": _PATH, "mapping": _MAPPING},
        required=("path",),
        refused=_NO_SCRIPTS,
    ),
    ToolSpec(
        "record_decision",
        "investments",
        "Record what the owner decided about a signal (bought, sold, held, ignored, other) with a "
        "reason; acknowledges the signal. Never books a trade.",
        record_decision,
        properties={
            "signal_id": {"type": "integer", "minimum": 1},
            "action": {"type": "string", "enum": ["bought", "sold", "held", "ignored", "other"]},
            "reason": _TEXT,
        },
        required=("signal_id", "action"),
        write=True,
    ),
    ToolSpec(
        "upsert_thesis",
        "investments",
        "Create or update the thesis of a held instrument (id, symbol or ISIN).",
        upsert_thesis,
        properties={
            "instrument": {"type": "string", "maxLength": 40},
            "entry_type": {
                "type": "string",
                "enum": ["sentiment_correction", "trend", "special_situation"],
            },
            "thesis": _TEXT,
            "invalidation": _TEXT,
            "exit_plan": _TEXT,
            "size_plan": _TEXT,
        },
        required=("instrument", "entry_type", "thesis"),
        write=True,
    ),
    ToolSpec(
        "propose_strategy",
        "investments",
        "Propose a new strategy (strategy.yaml + strategy.md). Validated locally; stored as a "
        "proposal the owner approves in the app (then it becomes a new version). dry_run: validate "
        "only.",
        propose_strategy,
        properties={
            "yaml": {"type": "string", "maxLength": 200_000},
            "md": {"type": "string", "maxLength": 200_000},
            "reason": _TEXT,
            "dry_run": {"type": "boolean", "default": False},
        },
        required=("yaml",),
        write=True,
    ),
    ToolSpec(
        "propose_custom_rule",
        "investments",
        "Propose a rule: a built-in kind (e.g. drawdown_from_high) with params, or a custom "
        "expression (params: scope, message, id, severity, cooldown_days, filters). Validated with "
        "the expression compiler and backtested on the profile's history (how often it would have "
        "fired). dry_run: validate and backtest only, store nothing.",
        propose_custom_rule,
        properties={
            "kind_or_expression": {"type": "string", "maxLength": 2000},
            "params": {"type": "object"},
            "reason": _TEXT,
            "dry_run": {"type": "boolean", "default": False},
        },
        required=("kind_or_expression",),
        write=True,
    ),
    ToolSpec(
        "propose_import",
        "investments",
        "Propose importing a file into a brokerage account (account: the generated label or id from "
        "portfolio_overview). path: a finanse-format file or a CSV with a mapping (the app never "
        "runs scripts). Runs the preview and stores a pending import the owner commits in the app.",
        propose_import,
        properties={
            "path": _PATH,
            "account": {"type": "string", "maxLength": 80},
            "mapping": _MAPPING,
            "importer": {
                "type": "string",
                "enum": ["auto", "finanse", "generic_csv"],
                "default": "auto",
            },
            "reason": _TEXT,
        },
        required=("path", "account"),
        write=True,
        refused=_NO_SCRIPTS,
    ),
)
