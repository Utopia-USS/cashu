"""JSON views of the investments module (plain dicts), shared by the API, the CLI and later the MCP
tools. Numbers come from the pure core; this module only selects, groups and labels.

Money is a JSON number (like the rest of the API, ``core.api.f``) next to the currency it is in;
ids are the integer row keys.
"""

from __future__ import annotations

import calendar
import datetime as dt
import importlib
import logging
from collections import Counter, defaultdict
from collections.abc import Iterable
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core import institutions
from finanse.core.api import f
from finanse.core.models import Account, Profile, utcnow

from ..alerts import CATALOG, alert_id_of, catalog_dicts, is_alert_key
from ..alerts.messages import alert_message
from ..domain import (
    BucketDef,
    Instrument,
    InstrumentId,
    PortfolioWarning,
    SignalSeverity,
    TxnSource,
    TxnType,
    ValuationMode,
    ValuedHolding,
    divided_by,
    ratio,
)
from ..importing import ImportWarning
from ..models import (
    InvAlert,
    InvDecision,
    InvImportBatch,
    InvManualValuation,
    InvRuleRun,
    InvSignal,
    InvStrategyVersion,
    InvThesis,
    InvWatchlistItem,
)
from ..portfolio import build_snapshot, effective_valuation_mode
from ..portfolio.fx_lookup import convert as fx_convert
from ..research.keys import is_research_key
from ..research.views import research_digest
from ..rules import (
    AllocationDriftParams,
    AllocationDriftRule,
    DrawdownFromHighRule,
    Fired,
    GainFromCostRule,
    LossFromCostRule,
    NotFired,
    RuleContext,
    RuleSpec,
    polarity_rank,
)
from ..store import alerts as alert_store
from ..store import convert, journal, market, signals, transactions
from . import portfolio
from . import strategy as strategy_files
from .imports import ImportPreview


def iso(value: dt.date | dt.datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def ratio_pct(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


def _key(instrument_id: str | None) -> int | str | None:
    """Stored instruments by integer key; planned ones (``new-...``, import preview) by their id."""
    key = convert.maybe_pk(instrument_id)
    return instrument_id if key is None else key


def instrument_dict(inst: Instrument) -> dict:
    """``label`` is the symbol, else the name, for every instrument (imported, manual and watched
    alike: messages and lists use it); ``name`` is the display name (it falls back to the symbol when
    none was given)."""
    return {
        "id": _key(inst.id),
        "symbol": inst.symbol,
        "name": inst.name,
        "label": inst.label,
        "isin": inst.isin,
        "mic": inst.mic,
        "currency": str(inst.currency),
        "asset_class": inst.asset_class.value,
        "region": inst.region,
        "sector": inst.sector,
        "tags": list(inst.tags),
        "valuation_mode": inst.valuation_mode.value if inst.valuation_mode else None,
        "status": inst.status.value,
        "needs_classification": inst.needs_classification,
        "aliases": [
            {"namespace": a.namespace, "value": a.value, "guessed": a.guessed} for a in inst.aliases
        ],
    }


def warning_dict(w: PortfolioWarning) -> dict:
    instrument_id = getattr(w, "instrument_id", None)
    return {
        "kind": w.kind,
        "message": w.message,
        "account_id": convert.maybe_pk(w.account_id),
        "instrument_id": convert.maybe_pk(instrument_id),
    }


def import_warning_dict(w: ImportWarning) -> dict:
    """``code`` (``import.<kind>``) is the stable key of the UI's Polish label; ``message`` stays
    the English detail."""
    return {
        "message": w.message,
        "row": w.row,
        "kind": str(w.kind),
        "code": w.code,
        "blocking": w.blocking,
    }


def run_dict(run: InvRuleRun | None) -> dict | None:
    if run is None:
        return None
    return {
        "id": run.id,
        "trigger": run.trigger,
        "as_of": iso(run.as_of),
        "status": run.status,
        "started_at": iso(run.started_at),
        "finished_at": iso(run.finished_at),
        "errors": list(run.errors or []),
        "stats": dict(run.stats or {}),
        "new_signal_ids": list((run.report or {}).get("new", [])),
        "escalated_signal_ids": list((run.report or {}).get("escalated", [])),
    }


def account_filter(session: Session, profile: Profile, raw: str | None) -> list[int] | None:
    """``"1,2"`` -> brokerage account ids of the profile (unknown ids raise ``LookupError``)."""
    if not raw:
        return None
    ids: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            account_id = int(part)
        except ValueError:
            raise LookupError(f"Not an account id: {part!r}") from None
        if transactions.brokerage_account(session, profile.id, account_id) is None:
            raise LookupError(f"No brokerage account {account_id} in this profile")
        ids.append(account_id)
    return ids or None


# --------------------------------------------------------------------------- #
# Overview
# --------------------------------------------------------------------------- #


def _bands(state: portfolio.PortfolioState, config) -> dict[str, dict]:
    """Per bucket: is it outside the rebalance band? Evaluated by the allocation_drift rule itself
    with the strategy's ``allocation.rebalance`` (no band math here)."""
    if config is None or state.allocation is None:
        return {}
    ctx = RuleContext.build(
        profile_id=convert.sid(state.profile_id),
        as_of=state.as_of,
        portfolio=state.valued,
        market=state.market,
        allocation=state.allocation,
        data=config.data,
        contributions=config.contributions,
    )
    spec = RuleSpec("bands", AllocationDriftRule.KIND, AllocationDriftParams(config.rebalance, ()))
    out: dict[str, dict] = {}
    for outcome in AllocationDriftRule().evaluate(ctx, spec):
        if isinstance(outcome, Fired):
            out[outcome.candidate.payload.get("bucket_id")] = {"out_of_band": True, "reason": None}
        elif isinstance(outcome, NotFired) and outcome.dedup_key:
            out[outcome.dedup_key.split("|s:", 1)[-1]] = {"out_of_band": False, "reason": None}
        elif outcome.dedup_key is None:  # whole-rule skip: say why for every bucket
            return {"*": {"out_of_band": None, "reason": getattr(outcome, "reason", None)}}
        else:
            out[outcome.dedup_key.split("|s:", 1)[-1]] = {
                "out_of_band": None,
                "reason": getattr(outcome, "reason", None),
            }
    return out


def allocation_view(state: portfolio.PortfolioState, config) -> dict:
    valued = state.valued
    total = valued.total_base
    by_class: dict[str, Decimal] = defaultdict(Decimal)
    by_region: dict[str, Decimal] = defaultdict(Decimal)
    for v in valued.valued:
        if v.market_value_base is None:
            continue
        by_class[v.instrument.asset_class.value] += v.market_value_base
        by_region[v.instrument.region or "unknown"] += v.market_value_base
    if valued.cash_base:
        by_class["cash"] += valued.cash_base

    def shares(values: dict[str, Decimal]) -> list[dict]:
        return [
            {"key": k, "value": f(v), "weight": ratio_pct(float(v / total)) if total else None}
            for k, v in sorted(values.items(), key=lambda kv: -kv[1])
        ]

    out: dict = {
        "base_currency": str(state.base),
        "total": f(total),
        "has_strategy": config is not None,
        "buckets": [],
        "unclassified": None,
        "unallocated_cash": None,
        "by_asset_class": shares(by_class),
        "by_region": shares(by_region),
        "band": None,
    }
    if config is None or state.allocation is None:
        return out
    bands = _bands(state, config)
    whole = bands.get("*")
    alloc = state.allocation
    for b in alloc.allocations:
        band = whole or bands.get(b.bucket_id) or {"out_of_band": None, "reason": None}
        out["buckets"].append(
            {
                "bucket_id": b.bucket_id,
                "weight": ratio_pct(b.weight),
                "target": b.target,
                "drift_pp": round(b.drift_pp, 4),
                "value": f(b.value_base),
                "to_target": f(-b.drift_value_base),
                "out_of_band": band["out_of_band"],
                "band_note": band["reason"],
                "cash_history_gap": b.cash_history_gap,
                "instrument_ids": [
                    convert.maybe_pk(h.instrument_id)
                    for h in alloc.holdings_by_bucket.get(b.bucket_id, ())
                ],
            }
        )
    unclassified = {
        convert.maybe_pk(h.instrument_id): h.instrument.label for h in alloc.unclassified
    }
    out["unclassified"] = {
        "value": f(alloc.unclassified_value_base),
        "weight": ratio_pct(alloc.unclassified_weight),
        "instruments": [
            {"id": i, "label": label}
            for i, label in sorted(unclassified.items(), key=lambda kv: str(kv[1]))
        ],
    }
    out["unallocated_cash"] = f(alloc.unallocated_cash_base)
    rb = config.rebalance
    out["band"] = {
        "absolute_band_pp": rb.absolute_band_pp,
        "relative_band": rb.relative_band,
        "min_trade_value": f(rb.min_trade_value),
    }
    return out


def _unrealized(valued: Iterable[ValuedHolding]) -> tuple[Decimal, Decimal]:
    value = cost = Decimal(0)
    for v in valued:
        if v.market_value_base is not None and v.cost_basis_base is not None:
            value += v.market_value_base
            cost += v.cost_basis_base
    return value, cost


def overview(session: Session, profile: Profile, *, account_ids: list[int] | None = None) -> dict:
    st = strategy_files.load(session, profile)
    config = st.config
    state = portfolio.build(session, profile, strategy=config, account_ids=account_ids)
    valued = state.valued
    total = valued.total_base
    value, cost = _unrealized(valued.valued)
    holdings_value = sum(
        (v.market_value_base for v in valued.valued if v.market_value_base is not None), Decimal(0)
    )
    open_rows = signals.open_signal_rows(session, profile.id)
    allocation = allocation_view(state, config)
    out_of_band = [b for b in allocation["buckets"] if b["out_of_band"]]
    max_drift = max(allocation["buckets"], key=lambda b: abs(b["drift_pp"]), default=None)
    last = signals.last_run(session, profile.id)
    held_ids = [convert.pk(h.instrument_id) for h in valued.valued]
    stale = [
        {
            "instrument_id": convert.maybe_pk(v.instrument_id),
            "label": v.instrument.label,
            "price_date": iso(v.price_date),
            "account_id": convert.maybe_pk(v.account_id),
        }
        for v in valued.valued
        if v.is_stale
    ]
    bar_dates = market.last_bar_dates(session, held_ids)
    cash_accounts = {c.account_id for c in valued.cash if c.cash.amount != 0}
    return {
        "as_of": iso(state.as_of),
        "base_currency": str(state.base),
        "accounts_filter": account_ids,
        "kpis": {
            "value": {
                "total": f(total),
                "holdings": f(holdings_value),
                "cash": f(valued.cash_base),
            },
            "unrealized": {
                "amount": f(value - cost) if cost else None,
                "pct": ratio_pct(float((value - cost) / cost)) if cost else None,
                "cost": f(cost) if cost else None,
            },
            "cash": {
                "amount": f(valued.cash_base),
                "weight": ratio_pct(float(valued.cash_base / total)) if total else None,
                "accounts": len(cash_accounts),
            },
            "signals": {
                "action": sum(r.severity == SignalSeverity.ACTION.value for r in open_rows),
                "info": sum(r.severity == SignalSeverity.INFO.value for r in open_rows),
                "new": sum(r.status == "active" for r in open_rows),
            },
            "polarity": polarity_counts(open_rows),
            "alerts": alert_store.alert_counts(session, profile.id),
            "max_drift": None
            if max_drift is None
            else {
                "bucket_id": max_drift["bucket_id"],
                "drift_pp": max_drift["drift_pp"],
                "out_of_band": max_drift["out_of_band"],
            },
            "out_of_band": len(out_of_band),
            "last_run": run_dict(last),
            "realized": f(valued.realized_pnl_base),
        },
        "allocation": allocation,
        "freshness": {
            "prices": {
                "newest_bar": iso(max(bar_dates.values(), default=None)),
                "stale": stale,
                "stale_count": len(stale),
                "stale_weight": ratio_pct(valued.stale_weight),
            },
            "fx": {
                "newest_rate": iso(market.newest_rate_date(session)),
                "missing": sorted(str(c) for c in valued.missing_fx_currencies),
            },
            "strategy": strategy_brief(st),
        },
        "warnings": [warning_dict(w) for w in valued.all_warnings],
        "accounts": accounts_view(session, profile, state),
        **attention(
            session, profile, open_rows, {convert.pk(h.instrument_id) for h in valued.valued}
        ),
    }


def strategy_brief(st: strategy_files.StrategyState) -> dict:
    errors = [i for i in st.issues if i.is_error]
    return {
        "state": st.state,
        "version": st.version.version if st.version is not None else None,
        "changed": st.changed,
        "errors": len(errors) + (1 if st.read_error else 0),
        "warnings": len(st.issues) - len(errors),
        "inactive_rules": len(st.inactive_rules),
    }


def accounts_view(
    session: Session, profile: Profile, state: portfolio.PortfolioState | None = None
) -> list[dict]:
    """Every brokerage account: settings, value (base currency, when a portfolio state is given),
    share, newest broker snapshot and import."""
    from .accounts import account_dict

    values: dict[int, Decimal] = defaultdict(Decimal)
    total = Decimal(0)
    if state is not None:
        for v in state.valued.valued:
            if v.market_value_base is not None:
                values[convert.pk(v.account_id)] += v.market_value_base
        for c in state.valued.cash:
            values[convert.pk(c.account_id)] += c.counted_base
        total = state.valued.total_base
    out = []
    for acc in transactions.brokerage_accounts(session, profile.id):
        snapshot_date, _rows = transactions.latest_position_snapshot(session, acc.id)
        last_import = session.exec(
            select(InvImportBatch)
            .where(InvImportBatch.account_id == acc.id)
            .order_by(InvImportBatch.created_at.desc())
        ).first()
        row = account_dict(session, acc)
        value = values.get(acc.id) if state is not None else None
        in_scope = (
            state is None or state.account_ids is None or convert.sid(acc.id) in state.account_ids
        )
        row.update(
            {
                "value": f(value) if value is not None and in_scope else None,
                "share": ratio_pct(float(value / total))
                if value is not None and total and in_scope
                else None,
                "snapshot_date": iso(snapshot_date),
                "last_import": None
                if last_import is None
                else {
                    "batch_id": last_import.id,
                    "at": iso(last_import.created_at),
                    "file_name": last_import.file_name,
                },
            }
        )
        out.append(row)
    return out


# --------------------------------------------------------------------------- #
# Positions
# --------------------------------------------------------------------------- #


def _sum(values: Iterable[Decimal | None]) -> Decimal | None:
    total = Decimal(0)
    for v in values:
        if v is None:
            return None
        total += v
    return total


def positions(session: Session, profile: Profile, *, account_ids: list[int] | None = None) -> dict:
    st = strategy_files.load(session, profile)
    state = portfolio.build(session, profile, strategy=st.config, account_ids=account_ids)
    return {
        "as_of": iso(state.as_of),
        "base_currency": str(state.base),
        "positions": position_rows(session, profile, state),
        "cash": cash_rows(state),
        "total": f(state.valued.total_base),
    }


def cash_rows(state: portfolio.PortfolioState) -> list[dict]:
    rows = []
    for c in state.valued.cash:
        acc = state.account(c.account_id)
        rows.append(
            {
                "account_id": convert.maybe_pk(c.account_id),
                "account_name": acc.name if acc else None,
                "currency": str(c.currency),
                "amount": f(c.cash.amount),
                "amount_base": f(c.amount_base),
            }
        )
    return rows


def position_rows(
    session: Session, profile: Profile, state: portfolio.PortfolioState
) -> list[dict]:
    buckets: dict[tuple[str, str], str] = {}
    if state.allocation is not None:
        for bucket_id, held in state.allocation.holdings_by_bucket.items():
            for h in held:
                buckets[(h.account_id, h.instrument_id)] = bucket_id
    open_by_instrument: dict[int, int] = defaultdict(int)
    for row in signals.open_signal_rows(session, profile.id):
        if row.instrument_id is not None:
            open_by_instrument[row.instrument_id] += 1
    with_thesis = {t.instrument_id for t in journal.theses(session, profile.id)}
    dividends: dict[InstrumentId, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    scope = state.account_ids
    for t in state.txns:
        if (
            t.type == TxnType.DIVIDEND
            and t.instrument_id
            and (scope is None or t.account_id in scope)
        ):
            dividends[t.instrument_id][str(t.cash_currency)] += t.cash_amount
    realized_parts: dict[InstrumentId, list[Decimal | None]] = defaultdict(list)
    for r in state.valued.realized:
        realized_parts[r.trade.instrument_id].append(r.pnl_base)
    realized = {k: _sum(v) for k, v in realized_parts.items()}

    grouped: dict[InstrumentId, list[ValuedHolding]] = defaultdict(list)
    for v in state.valued.valued:
        grouped[v.instrument_id].append(v)
    rows = []
    for instrument_id, held in grouped.items():
        first = held[0]
        inst = first.instrument
        value = _sum(v.market_value_base for v in held)
        cost = _sum(v.cost_basis_base for v in held)
        weights = [v.weight for v in held]
        lots = []
        for v in held:
            for lot in v.holding.lots:
                result = None
                if (
                    first.price is not None
                    and lot.unit_cost is not None
                    and first.price_currency == lot.currency
                ):
                    result = f((first.price - lot.unit_cost) * lot.quantity)
                lots.append(
                    {
                        "account_id": convert.maybe_pk(lot.account_id),
                        "open_date": iso(lot.open_date),
                        "quantity": f(lot.quantity),
                        "unit_cost": f(lot.unit_cost),
                        "currency": str(lot.currency),
                        "open_txn_id": convert.maybe_pk(lot.open_txn_id),
                        "result": result,
                    }
                )
        bucket_ids = {buckets.get((v.account_id, v.instrument_id)) for v in held}
        rows.append(
            {
                "instrument": instrument_dict(inst),
                "bucket": next(iter(bucket_ids)) if len(bucket_ids) == 1 else None,
                "quantity": f(sum((v.holding.quantity for v in held), Decimal(0))),
                "price": f(first.price),
                "price_date": iso(first.price_date),
                "price_currency": None
                if first.price_currency is None
                else str(first.price_currency),
                "is_stale": any(v.is_stale for v in held),
                "valuation_mode": first.valuation_mode.value,
                "missing_fx_currency": None
                if first.missing_fx_currency is None
                else str(first.missing_fx_currency),
                "value": f(value),
                "cost": f(cost),
                "unrealized": f(value - cost) if value is not None and cost is not None else None,
                "unrealized_pct": ratio_pct(float((value - cost) / cost))
                if value is not None and cost
                else None,
                "weight": ratio_pct(sum(weights)) if all(w is not None for w in weights) else None,
                "realized": f(realized.get(instrument_id)) if instrument_id in realized else None,
                "dividends": {
                    cur: f(amount) for cur, amount in dividends.get(instrument_id, {}).items()
                },
                "accounts": [
                    {
                        "account_id": convert.maybe_pk(v.account_id),
                        "account_name": (
                            state.account(v.account_id).name
                            if state.account(v.account_id)
                            else None
                        ),
                        "quantity": f(v.holding.quantity),
                        "average_cost": f(v.holding.average_cost),
                        "cost_currency": str(v.holding.currency),
                        "value": f(v.market_value_base),
                        "cost": f(v.cost_basis_base),
                        "unrealized_pct": ratio_pct(v.unrealized_pct),
                        "weight": ratio_pct(v.weight),
                    }
                    for v in held
                ],
                "lots": lots,
                "open_signals": open_by_instrument.get(convert.pk(instrument_id), 0),
                "has_thesis": convert.pk(instrument_id) in with_thesis,
                "closes_30d": closes_30d(state.market.bars.get(instrument_id, ()), state.as_of),
            }
        )
    rows.sort(key=lambda r: -(r["value"] or 0))
    return rows


CLOSES_DAYS = 30


def closes_30d(bars, as_of: dt.date) -> list[dict]:
    """Stored daily closes of the last 30 calendar days up to ``as_of`` (sparklines; no network)."""
    since = as_of - dt.timedelta(days=CLOSES_DAYS)
    return [{"date": iso(b.date), "close": f(b.close)} for b in bars if since < b.date <= as_of]


def position_detail(
    session: Session, profile: Profile, instrument_id: int, *, days: int = 730
) -> dict:
    st = strategy_files.load(session, profile)
    state = portfolio.build(session, profile, strategy=st.config)
    rows = [
        r for r in position_rows(session, profile, state) if r["instrument"]["id"] == instrument_id
    ]
    inst = state.instruments.get(convert.sid(instrument_id))
    if inst is None:
        from ..store import instruments as instrument_store

        inst = instrument_store.load_one(session, instrument_id, profile_id=profile.id)
    since = state.as_of - dt.timedelta(days=days)
    series = market.bars(session, [instrument_id], until=state.as_of, since=since).get(
        convert.sid(instrument_id), ()
    )
    window = [b.close for b in series[-252:]]
    txns = [t for t in state.txns if t.instrument_id == convert.sid(instrument_id)]
    return {
        "instrument": None if inst is None else instrument_dict(inst),
        "position": rows[0] if rows else None,
        "series": [{"date": iso(b.date), "close": f(b.close)} for b in series],
        "high_52w": f(max(window)) if window else None,
        "transactions": [txn_dict(t, state) for t in txns],
        "theses": [thesis_dict(t) for t in journal.theses(session, profile.id, instrument_id)],
        "decisions": [
            decision_dict(d)
            for d in journal.decisions(session, profile.id, instrument_id=instrument_id)
        ],
        "manual_valuations": [
            manual_valuation_dict(m)
            for m in transactions.manual_valuation_rows(session, profile.id, [instrument_id])
        ],
    }


def txn_dict(t, state: portfolio.PortfolioState | None = None) -> dict:
    acc = state.account(t.account_id) if state is not None else None
    return {
        "id": convert.maybe_pk(t.id),
        "account_id": convert.maybe_pk(t.account_id),
        "account_name": acc.name if acc else None,
        "type": t.type.value,
        "trade_date": iso(t.trade_date),
        "instrument_id": convert.maybe_pk(t.instrument_id),
        "quantity": f(t.quantity),
        "price": f(t.price),
        "currency": str(t.currency),
        "gross_amount": f(t.gross_amount),
        "fee": f(t.fee),
        "tax": f(t.tax),
        "cash_amount": f(t.cash_amount),
        "cash_currency": str(t.cash_currency),
        "fx_rate": f(t.fx_rate),
        "split_ratio": None if t.split_ratio is None else str(t.split_ratio),
        "source": t.source.value,
        "note": t.note,
        "external_ref": t.external_ref,
    }


def manual_txn_dict(result) -> dict:
    """Response of a manual transaction (``service.transactions.ManualTxnResult``)."""
    row = txn_dict(result.transaction)
    row["account_name"] = result.account.name
    return {
        "transaction": row,
        "instrument": None if result.instrument is None else instrument_dict(result.instrument),
        "new_instrument": result.new_instrument,
        "warnings": list(result.warnings),
    }


# --------------------------------------------------------------------------- #
# Signals, journal
# --------------------------------------------------------------------------- #


def _signal_source(row: InvSignal) -> str:
    """``alert`` (an alert's signal), ``research`` (a research note's, F6) or ``rule``."""
    if is_alert_key(row.rule_id):
        return "alert"
    return "research" if is_research_key(row.rule_id) else "rule"


def _note_id(row: InvSignal) -> int | None:
    """The lead research note of a research signal (the UI's ``notatka`` link), else None."""
    if not is_research_key(row.rule_id):
        return None
    note_id = (row.payload or {}).get("note_id")
    return note_id if isinstance(note_id, int) else None


def _message_code(row: InvSignal, labels: dict[int, str]) -> dict:
    label = labels.get(row.instrument_id) if row.instrument_id else None
    code, params = alert_message(row.kind, row.payload, row.message, label)
    return {"message_code": code, "message_params": params}


def signal_dict(
    row: InvSignal, decisions: list[InvDecision] = (), labels: dict[int, str] | None = None
) -> dict:
    """``message_code`` / ``message_params``: the alert signal's message as a stable code
    (``alert.<kind>``) + its facts for a translated label (None for rule signals)."""
    label = (labels or {}).get(row.instrument_id) if row.instrument_id else None
    return {
        "id": row.id,
        "rule_id": row.rule_id,
        "kind": row.kind,
        "dedup_key": row.dedup_key,
        "severity": row.severity,
        "polarity": row.polarity,
        "source": _signal_source(row),
        "alert_id": alert_id_of(row.rule_id),
        "note_id": _note_id(row),
        "status": row.status,
        "message": row.message,
        **_message_code(row, labels or {}),
        "instrument_id": row.instrument_id,
        "instrument_label": label,
        "account_id": row.account_id,
        "payload": row.payload,
        "first_seen_at": iso(row.first_seen_at),
        "last_seen_at": iso(row.last_seen_at),
        "acknowledged_at": iso(row.acknowledged_at),
        "closed_at": iso(row.closed_at),
        "snoozed_until": iso(row.snoozed_until),
        "snoozed": signals.is_snoozed(row, utcnow()),
        "decisions": [decision_dict(d) for d in decisions],
    }


def signals_view(session: Session, profile: Profile, status: str = "open") -> list[dict]:
    query = select(InvSignal).where(InvSignal.profile_id == profile.id)
    if status == "open":
        query = query.where(InvSignal.status.in_(signals.OPEN_STATUSES))
    elif status == "history":
        query = query.where(InvSignal.status.in_(signals.CLOSED_STATUSES))
    rows = list(session.exec(query.order_by(InvSignal.id.desc())).all())
    by_signal: dict[int, list[InvDecision]] = defaultdict(list)
    for d in journal.decisions(session, profile.id):
        if d.signal_id is not None:
            by_signal[d.signal_id].append(d)
    from ..store import instruments as instrument_store

    labels = {
        k: v.label
        for k, v in instrument_store.load(
            session, {r.instrument_id for r in rows if r.instrument_id}, profile_id=profile.id
        ).items()
    }
    rank = {SignalSeverity.ACTION.value: 0, SignalSeverity.INFO.value: 1}
    if status == "open":
        now = utcnow()
        rows.sort(
            key=lambda r: (
                signals.is_snoozed(r, now),
                r.status != "active",
                rank.get(r.severity, 9),
                -r.id,
            )
        )
    return [signal_dict(r, by_signal.get(r.id, []), labels) for r in rows]


# --------------------------------------------------------------------------- #
# Polarity, attention, alerts, watchlist
# --------------------------------------------------------------------------- #

ATTENTION_LIMIT = 6
"""Items in the overview's ``attention`` list (two rows of a thirds layout)."""


def polarity_counts(rows: Iterable[InvSignal]) -> dict[str, int]:
    counts = Counter(r.polarity for r in rows)
    return {key: counts.get(key, 0) for key in ("positive", "negative", "neutral")}


def attention(
    session: Session, profile: Profile, open_rows: list[InvSignal], held: set[int]
) -> dict:
    """The compact "look at this" list: open signals (from rules and triggered alerts) that are not
    snoozed, ranked by active before acknowledged, action before info, negative before positive
    before neutral, items about held positions (or the whole portfolio) before watched instruments,
    newest first."""
    now = utcnow()
    snoozed = [r for r in open_rows if signals.is_snoozed(r, now)]
    open_rows = [r for r in open_rows if not signals.is_snoozed(r, now)]
    alerts_by_id = {a.id: a for a in alert_store.alerts(session, profile.id) if a.id is not None}
    from ..store import instruments as instrument_store

    labels = {
        k: v.label
        for k, v in instrument_store.load(
            session, {r.instrument_id for r in open_rows if r.instrument_id}, profile_id=profile.id
        ).items()
    }
    severity = {SignalSeverity.ACTION.value: 0, SignalSeverity.INFO.value: 1}

    def relevant(row: InvSignal) -> bool:
        return row.instrument_id is None or row.instrument_id in held

    ranked = sorted(
        open_rows,
        key=lambda r: (
            r.status != "active",
            severity.get(r.severity, 9),
            polarity_rank(r.polarity),
            not relevant(r),
            -(r.last_seen_at.timestamp() if r.last_seen_at else 0),
            -(r.id or 0),
        ),
    )
    items = []
    for row in ranked[:ATTENTION_LIMIT]:
        alert_id = alert_id_of(row.rule_id)
        alert = alerts_by_id.get(alert_id) if alert_id is not None else None
        items.append(
            {
                "type": "alert" if alert_id is not None else "signal",
                "signal_id": row.id,
                "alert_id": alert_id,
                "kind": row.kind,
                "rule_id": row.rule_id,
                "polarity": row.polarity,
                "severity": row.severity,
                "status": row.status,
                "title": alert.title if alert is not None else row.rule_id,
                "message": row.message,
                **_message_code(row, labels),
                "source": alert.source if alert is not None else _signal_source(row),
                "note_id": _note_id(row),
                "instrument_id": row.instrument_id,
                "instrument_label": labels.get(row.instrument_id) if row.instrument_id else None,
                "held": row.instrument_id is not None and row.instrument_id in held,
                "first_seen_at": iso(row.first_seen_at),
                "last_seen_at": iso(row.last_seen_at),
            }
        )
    return {
        "attention": items,
        "attention_total": len(open_rows),
        "attention_snoozed": len(snoozed),
    }


def _number(text: str | None) -> float | None:
    if text is None:
        return None
    try:
        return float(Decimal(text))
    except ArithmeticError:
        return None


def alert_dict(
    row: InvAlert, instrument: Instrument | None = None, open_signal: InvSignal | None = None
) -> dict:
    info = CATALOG.get(row.kind)  # StrEnum keys match their wire names
    return {
        "id": row.id,
        "kind": row.kind,
        "scope": row.scope,
        "instrument_id": row.instrument_id,
        "instrument": None
        if instrument is None
        else {
            "id": convert.maybe_pk(instrument.id),
            "label": instrument.label,
            "symbol": instrument.symbol,
            "name": instrument.name,
            "isin": instrument.isin,
            "currency": str(instrument.currency),
            "asset_class": instrument.asset_class.value,
            "valuation_mode": instrument.valuation_mode.value
            if instrument.valuation_mode
            else None,
        },
        "params": dict(row.params or {}),
        "unit": info.unit if info is not None else None,
        "polarity": row.polarity,
        "severity": row.severity,
        "title": row.title,
        "note": row.note,
        "source": row.source,
        "created_by": row.created_by,
        "status": row.status,
        "cooldown_days": row.cooldown_days,
        "expires_at": iso(row.expires_at),
        "snoozed_until": iso(row.snoozed_until),
        "last_triggered_at": iso(row.last_triggered_at),
        "last_checked_at": iso(row.last_checked_at),
        "last_value": _number(row.last_value),
        "signal": None
        if open_signal is None
        else {
            "id": open_signal.id,
            "status": open_signal.status,
            "message": open_signal.message,
            **_message_code(
                open_signal, {} if instrument is None else {row.instrument_id: instrument.label}
            ),
            "first_seen_at": iso(open_signal.first_seen_at),
        },
        "created_at": iso(row.created_at),
        "updated_at": iso(row.updated_at),
    }


ALERT_STATUS_ORDER = {"triggered": 0, "active": 1, "snoozed": 2, "muted": 3, "expired": 4}


def alerts_view(
    session: Session, profile: Profile, statuses: list[str] | None = None
) -> list[dict]:
    """The profile's alerts (``statuses`` filter; None = all): triggered first, then active, snoozed,
    muted, expired; newest first within a status."""
    from ..store import instruments as instrument_store

    rows = alert_store.alerts(session, profile.id, statuses)
    loaded = instrument_store.load(
        session, {r.instrument_id for r in rows if r.instrument_id}, profile_id=profile.id
    )
    open_signals = alert_store.open_alert_signals(session, profile.id)
    rows.sort(key=lambda r: (ALERT_STATUS_ORDER.get(r.status, 9), -(r.id or 0)))
    return [
        alert_dict(
            r, loaded.get(r.instrument_id) if r.instrument_id else None, open_signals.get(r.id)
        )
        for r in rows
    ]


def one_alert(session: Session, profile: Profile, row: InvAlert) -> dict:
    from ..store import instruments as instrument_store

    instrument = (
        instrument_store.load_one(session, row.instrument_id, profile_id=profile.id)
        if row.instrument_id
        else None
    )
    return alert_dict(
        row, instrument, alert_store.open_alert_signals(session, profile.id).get(row.id)
    )


def alert_kinds() -> dict:
    """The alert catalog for forms (kinds, scopes, params with limits) plus the polarity values."""
    return {
        "kinds": catalog_dicts(),
        "polarities": ["positive", "negative", "neutral"],
        "severities": [s.value for s in SignalSeverity],
        "statuses": list(ALERT_STATUS_ORDER),
    }


def _ratio_between(new: Decimal, old: Decimal) -> float | None:
    return float(new / old - 1) if old > 0 else None


def _alert_level(row: InvAlert, check) -> Decimal | None:
    """The price at which a live price alert would change state, from its evaluation details."""
    outcome = check.outcome
    details = (
        outcome.candidate.payload
        if isinstance(outcome, Fired)
        else getattr(outcome, "details", None) or {}
    )

    def number(key: str) -> Decimal | None:
        value = details.get(key)
        return None if value is None else Decimal(str(value))

    match row.kind:
        case "price_above" | "price_below":
            return number("level")
        case "sma_cross":
            return number("sma")
        case "new_high":
            return number("previous_high")
        case "drawdown_from_high":
            high = number("high")
            threshold = Decimal(str((row.params or {}).get("threshold", 0)))
            return None if high is None else high * (1 - threshold)
    return None


def nearest_alert(
    alerts: list[InvAlert], instrument: Instrument | None, bars: tuple, as_of: dt.date
) -> dict | None:
    """The live price alert whose level is closest to the last close: ``distance_pct`` = (level -
    close) / close as a fraction (positive = the level is above the close)."""
    from ..alerts import AlertData, evaluate_alert
    from . import alerts as alert_service

    if instrument is None or not bars:
        return None
    close = bars[-1].close
    if close <= 0:
        return None
    data = AlertData(as_of=as_of, bars={instrument.id: bars}, max_price_age_days=10_000)
    best: dict | None = None
    for row in alerts:
        if row.status not in ("active", "triggered", "snoozed") or row.instrument_id is None:
            continue
        level = _alert_level(row, evaluate_alert(alert_service.definition(row, instrument), data))
        if level is None:
            continue
        distance = float((level - close) / close)
        if best is None or abs(distance) < abs(best["distance_pct"]):
            best = {
                "alert_id": row.id,
                "kind": row.kind,
                "title": row.title,
                "level": f(level),
                "distance_pct": round(distance, 6),
            }
    return best


def watchlist_row(
    item: InvWatchlistItem,
    instrument: Instrument | None,
    bars: tuple,
    *,
    as_of: dt.date,
    held: bool,
    alerts: list[InvAlert],
    max_price_age_days: int = 5,
) -> dict:
    """One watched instrument with hard price facts only (last close, past changes, 52-week high);
    never a forecast."""
    price: dict | None = None
    if bars:
        last = bars[-1]
        year = bars[-252:]
        high = max(year, key=lambda b: b.close)
        price = {
            "close": f(last.close),
            "date": iso(last.date),
            "currency": str(last.currency or (instrument.currency if instrument else "")),
            "stale": (as_of - last.date).days > max_price_age_days,
            "change_1d": _ratio_between(last.close, bars[-2].close) if len(bars) >= 2 else None,
            "change_1m": _ratio_between(last.close, bars[-22].close) if len(bars) >= 22 else None,
            "high_52w": f(high.close),
            "high_52w_date": iso(high.date),
            "from_high_52w": float((last.close - high.close) / high.close) if high.close else None,
            "bars": len(bars),
        }
    has_source = instrument is not None and any(instrument.alias(ns) for ns in ("yahoo", "stooq"))
    return {
        "id": item.id,
        "instrument_id": item.instrument_id,
        "instrument": instrument_dict(instrument) if instrument is not None else None,
        "note": item.note,
        "tags": list(item.tags or []),
        "source": item.source,
        "added_at": iso(item.added_at),
        "held": held,
        "price_source": has_source,
        "price": price,
        "closes_30d": closes_30d(bars, as_of),
        "alerts": {
            "count": len(alerts),
            "live": sum(a.status in ("active", "triggered", "snoozed") for a in alerts),
            "triggered": sum(a.status == "triggered" for a in alerts),
            "nearest": nearest_alert(alerts, instrument, bars, as_of),
        },
    }


def watchlist_view(
    session: Session, profile: Profile, *, as_of: dt.date | None = None
) -> list[dict]:
    """Every watchlist item of the profile, oldest first."""
    from ..store import instruments as instrument_store

    as_of = as_of or portfolio.today()
    items = alert_store.watchlist(session, profile.id)
    if not items:
        return []
    ids = {i.instrument_id for i in items}
    loaded = instrument_store.load(session, ids, profile_id=profile.id)
    series = market.bars(session, ids, until=as_of, since=as_of - dt.timedelta(days=400))
    snapshot = build_snapshot(
        convert.sid(profile.id),
        transactions.transactions(session, profile.id),
        as_of,
        renames=transactions.renames(session, profile.id),
    )
    held = {convert.pk(h.instrument_id) for h in snapshot.holdings}
    by_instrument: dict[int, list[InvAlert]] = defaultdict(list)
    for a in alert_store.alerts(session, profile.id):
        if a.instrument_id is not None:
            by_instrument[a.instrument_id].append(a)
    st = strategy_files.load(session, profile)
    max_age = st.config.data.max_price_age_days if st.config is not None else 5
    return [
        watchlist_row(
            item,
            loaded.get(item.instrument_id),
            series.get(convert.sid(item.instrument_id), ()),
            as_of=as_of,
            held=item.instrument_id in held,
            alerts=by_instrument.get(item.instrument_id, []),
            max_price_age_days=max_age,
        )
        for item in items
    ]


def decision_dict(d: InvDecision) -> dict:
    return {
        "id": d.id,
        "signal_id": d.signal_id,
        "instrument_id": d.instrument_id,
        "account_id": d.account_id,
        "action": d.action,
        "quantity": f(d.quantity),
        "price": f(d.price),
        "currency": d.currency,
        "reason": d.reason,
        "created_at": iso(d.created_at),
    }


def thesis_dict(t: InvThesis) -> dict:
    return {
        "id": t.id,
        "instrument_id": t.instrument_id,
        "entry_type": t.entry_type,
        "thesis": t.thesis,
        "invalidation": t.invalidation,
        "exit_plan": t.exit_plan,
        "size_plan": t.size_plan,
        "reviewed_at": iso(t.reviewed_at),
        "created_at": iso(t.created_at),
        "updated_at": iso(t.updated_at),
    }


def manual_valuation_dict(m: InvManualValuation) -> dict:
    return {
        "id": m.id,
        "instrument_id": m.instrument_id,
        "as_of": iso(m.as_of),
        "unit_value": f(m.unit_value),
        "currency": m.currency,
        "note": m.note,
    }


# --------------------------------------------------------------------------- #
# Strategy, imports
# --------------------------------------------------------------------------- #


def version_dict(v: InvStrategyVersion) -> dict:
    return {
        "version": v.version,
        "state": v.state,
        "created_at": iso(v.created_at),
        "sha256": v.sha256,
        "issues": len(v.issues or []),
    }


def bucket_match_dict(bucket: BucketDef) -> dict:
    """One bucket's ``match`` criteria (sorted lists; empty = any), so a client can classify an
    instrument (asset class + tags) to fit a chosen bucket."""
    match = bucket.match
    keys = [convert.maybe_pk(i) for i in match.instrument_ids]
    return {
        "id": bucket.id,
        "asset_class": sorted(a.value for a in match.asset_classes),
        "tags": sorted(match.tags),
        "mic": sorted(match.mics),
        "currency": sorted(str(c) for c in match.currencies),
        "instrument_ids": sorted(k for k in keys if k is not None)
        + sorted(i for i in match.instrument_ids if convert.maybe_pk(i) is None),
    }


def strategy_status(session: Session, profile: Profile) -> dict:
    st = strategy_files.load(session, profile)
    config = st.config
    facts = None
    if config is not None:
        facts = {
            "base_currency": str(config.base_currency),
            "buckets": [b.id for b in config.allocation.buckets],
            "targets": dict(config.allocation.targets),
            "rules": [
                {
                    "id": r.id,
                    "kind": r.kind,
                    "severity": r.severity.value,
                    "cooldown_days": r.cooldown_days,
                }
                for r in config.rules
            ],
            "horizon_years": config.horizon_years,
            "contributions": None
            if config.contributions is None
            else {
                "monthly_amount": f(config.contributions.monthly_amount),
                "day_of_month": config.contributions.day_of_month,
            },
            "notifications": {
                "immediate": sorted(s.value for s in config.notifications.immediate),
                "digest_weekday": config.notifications.digest_weekday.value,
            },
            "bucket_matches": [bucket_match_dict(b) for b in config.allocation.buckets],
        }
    mismatch = None
    if config is not None and str(config.base_currency) != profile.base_currency:
        mismatch = f"strategy base_currency {config.base_currency} differs from the profile's {profile.base_currency}"
    return {
        **strategy_brief(st),
        "files": {
            "yaml": str(st.yaml_path),
            "md": str(st.md_path),
            "yaml_exists": st.yaml_path.is_file(),
            "md_exists": st.md_path.is_file(),
        },
        "read_error": st.read_error,
        "issues": [strategy_files.issue_dict(i) for i in st.issues],
        "inactive_rules": [
            {
                "index": r.index,
                "rule_id": r.rule_id,
                "kind": r.kind,
                "line": r.line,
                "issues": [strategy_files.issue_dict(i) for i in r.issues],
            }
            for r in st.inactive_rules
        ],
        "facts": facts,
        "base_currency_note": mismatch,
        "versions": [version_dict(v) for v in strategy_files.versions(session, profile.id)],
    }


def preview_dict(preview: ImportPreview) -> dict:
    plan = preview.plan
    account: Account = preview.account
    out: dict = {
        "file_id": preview.sha256,
        "file_name": preview.request.file.name,
        "size": len(preview.request.file.content),
        "account": {
            "id": account.id,
            "name": account.name,
            "broker": account.bank,
            "broker_name": institutions.display_name(account.bank),
        },
        "importer": {
            "id": preview.importer_id,
            "name": preview.importer_name,
            "detected": list(preview.detected),
            "requested": preview.request.importer,
        },
        "can_commit": preview.can_commit,
        "warnings": [import_warning_dict(w) for w in preview.warnings],
        "errors": [import_warning_dict(w) for w in preview.errors],
        "previous_imports": [
            {"batch_id": b.id, "at": iso(b.created_at), "file_name": b.file_name}
            for b in preview.previous_batches
        ],
        "account_hint": None if preview.parse is None else preview.parse.account_hint,
        "counts": None,
        "rows": [],
        "new_instruments": [],
        "renames": [],
        "status_changes": [],
        "reconciliation": None,
    }
    if plan is None:
        return out
    new_ids = {i.id for i in plan.new_instruments}

    def label(instrument_id: str | None) -> dict | None:
        if instrument_id is None:
            return None
        inst = plan.instruments.get(instrument_id)
        return {
            "id": convert.maybe_pk(instrument_id)
            if instrument_id not in new_ids
            else instrument_id,
            "label": inst.label if inst else instrument_id,
            "new": instrument_id in new_ids,
        }

    out["counts"] = {
        "rows": len(plan.rows),
        "new": plan.new_count,
        "duplicates": plan.duplicate_count,
        "positions": len(plan.positions),
        "renames": len(plan.renames),
        "status_changes": len(plan.status_changes),
        "new_instruments": len(plan.new_instruments),
        "warnings": len(out["warnings"]),
        "errors": len(out["errors"]),
    }
    out["rows"] = [
        {
            "row": r.parsed.row_index,
            "date": iso(r.txn.trade_date),
            "type": r.txn.type.value,
            "instrument": label(r.txn.instrument_id),
            "quantity": f(r.txn.quantity),
            "price": f(r.txn.price),
            "currency": str(r.txn.currency),
            "amount": f(r.txn.cash_amount),
            "cash_currency": str(r.txn.cash_currency),
            "status": "duplicate" if r.is_duplicate else "new",
        }
        for r in plan.rows
    ]
    out["new_instruments"] = [instrument_dict(i) for i in plan.new_instruments]
    out["renames"] = [
        {
            "date": iso(r.rename.date),
            "old": label(r.rename.old_instrument_id),
            "new": label(r.rename.new_instrument_id),
            "note": r.rename.note,
        }
        for r in plan.renames
    ]
    out["status_changes"] = [
        {"instrument": label(c.instrument_id), "status": c.status.value, "date": iso(c.parsed.date)}
        for c in plan.status_changes
    ]
    if preview.reconciliation is not None:
        out["reconciliation"] = reconciliation_dict(
            preview.reconciliation, plan.instruments, new_ids
        )
    return out


def reconciliation_dict(
    report, instruments_by_id: dict[str, Instrument], new_ids=frozenset()
) -> dict:
    proposals = {c.diff.instrument_id: c.txn for c in report.corrections}
    rows = []
    for d in report.diffs:
        inst = instruments_by_id.get(d.instrument_id)
        txn = proposals.get(d.instrument_id)
        rows.append(
            {
                "instrument_id": d.instrument_id
                if d.instrument_id in new_ids
                else convert.maybe_pk(d.instrument_id),
                "label": inst.label if inst else d.instrument_id,
                "broker_quantity": f(d.broker_quantity),
                "computed_quantity": f(d.computed_quantity),
                "delta": f(d.delta),
                "kind": d.kind.value,
                "currency": str(d.currency),
                "correction": None
                if txn is None
                else {
                    "type": txn.type.value,
                    "quantity": f(txn.quantity),
                    "price": f(txn.price),
                    "date": iso(txn.trade_date),
                    "note": txn.note,
                },
            }
        )
    return {
        "account_id": convert.maybe_pk(report.account_id),
        "as_of": iso(report.as_of),
        "diffs": rows,
        "mismatches": len(report.mismatches),
        "warnings": list(report.warnings),
    }


def batch_dict(b: InvImportBatch) -> dict:
    return {
        "id": b.id,
        "account_id": b.account_id,
        "importer": b.importer,
        "broker": b.broker,
        "file_name": b.file_name,
        "file_sha256": b.file_sha256,
        "inserted": b.txn_count,
        "duplicates": b.duplicate_count,
        "positions": b.position_count,
        "renames": b.rename_count,
        "status_changes": b.status_change_count,
        "new_instruments": b.instrument_count,
        "corrections": b.correction_count,
        "warnings": len(b.warnings or []),
        "created_at": iso(b.created_at),
    }


# --------------------------------------------------------------------------- #
# Position chart
# --------------------------------------------------------------------------- #

CHART_RULE_KINDS = (DrawdownFromHighRule.KIND, LossFromCostRule.KIND, GainFromCostRule.KIND)


def _months_before(day: dt.date, months: int) -> dt.date:
    """The same day ``months`` calendar months earlier (clamped to the month's last day)."""
    year, month = divmod(day.year * 12 + day.month - 1 - months, 12)
    month += 1
    return dt.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _average_cost(held: list[ValuedHolding], currency: str) -> Decimal | None:
    """Cost per unit across the holdings (total cost / total quantity) when every holding's lots are
    in ``currency`` with known costs; None otherwise."""
    cost = Decimal(0)
    quantity = Decimal(0)
    for v in held:
        basis = v.holding.cost_basis
        if basis is None or str(v.holding.currency) != currency:
            return None
        cost += basis
        quantity += v.holding.quantity
    if not quantity:
        return None
    return divided_by(cost, quantity)


def position_chart(
    session: Session, profile: Profile, instrument_id: int, *, months: int = 24
) -> dict:
    """Closes of the last ``months`` months with the price levels at which the strategy's active
    per-instrument rules fire, plus buy / sell markers.

    Threshold levels: ``drawdown_from_high`` -> max close of the rule's last ``window_days`` bars times
    (1 - threshold); ``loss_from_cost`` / ``gain_from_cost`` -> average cost per unit times
    (1 -/+ threshold). The cost rules themselves compare value and cost in the base currency across
    accounts, so with moving FX rates the cost lines are an approximation in the price currency.
    """
    from ..store import instruments as instrument_store

    st = strategy_files.load(session, profile)
    config = st.config
    state = portfolio.build(session, profile, strategy=config)
    key = convert.sid(instrument_id)
    inst = state.instruments.get(key) or instrument_store.load_one(
        session, instrument_id, profile_id=profile.id
    )
    as_of = state.as_of
    since = _months_before(as_of, months)
    bars = market.bars(session, [instrument_id], until=as_of).get(key, ())
    reported = [b.currency for b in bars if b.currency is not None]
    currency = str(reported[-1]) if reported else (str(inst.currency) if inst else None)
    window = [b.close for b in bars[-252:]]
    held = [v for v in state.valued.valued if v.instrument_id == key]
    average = _average_cost(held, currency) if held and currency else None

    thresholds = []
    for rule in config.rules if config is not None else ():
        if rule.kind not in CHART_RULE_KINDS:
            continue
        params = rule.params
        rule_filter = getattr(params, "filter", None)
        if inst is None or (rule_filter is not None and not rule_filter.accepts(inst)):
            continue
        fraction = Decimal(str(params.threshold))
        if rule.kind == DrawdownFromHighRule.KIND:
            closes = [b.close for b in bars[-params.window_days :]]
            if not closes:
                continue
            basis, window_days, level = "high", params.window_days, max(closes) * (1 - fraction)
        elif average is None:
            continue
        elif rule.kind == LossFromCostRule.KIND:
            basis, window_days, level = "cost", None, average * (1 - fraction)
        else:
            basis, window_days, level = "cost", None, average * (1 + fraction)
        thresholds.append(
            {
                "rule_id": rule.id,
                "kind": rule.kind,
                "threshold": float(params.threshold),
                "basis": basis,
                "window_days": window_days,
                "y": f(level),
            }
        )

    markers = [
        {
            "date": iso(t.trade_date),
            "type": t.type.value,
            "quantity": f(t.quantity),
            "price": f(t.price),
            "currency": str(t.currency),
            "account_id": convert.maybe_pk(t.account_id),
        }
        for t in state.txns
        if t.instrument_id == key
        and t.type in (TxnType.BUY, TxnType.SELL)
        and since <= t.trade_date <= as_of
    ]
    last = bars[-1] if bars else None
    return {
        "instrument_id": instrument_id,
        "label": inst.label if inst else str(instrument_id),
        "currency": currency,
        "valuation_mode": effective_valuation_mode(inst).value if inst else None,
        "as_of": iso(as_of),
        "series": [{"date": iso(b.date), "close": f(b.close)} for b in bars if b.date >= since],
        "high_52w": f(max(window)) if window else None,
        "last": None if last is None else {"date": iso(last.date), "close": f(last.close)},
        "cost": None if not held else {"average": f(average), "currency": currency},
        "thresholds": thresholds,
        "markers": markers,
    }


# --------------------------------------------------------------------------- #
# Weekly review digest
# --------------------------------------------------------------------------- #

REVIEW_MODULE = "investments"
DEFAULT_DIGEST_DAYS = 7
PRICE_MOVE_MIN = 0.05
"""Price moves smaller than this (5 %) since the baseline are left out of the digest."""


def last_review(session: Session, profile: Profile) -> dict | None:
    """The profile's last weekly review of the investments module as
    ``{"done_at": aware datetime, "notes": str | None, "stats": dict}``, or None.

    Reads ``finanse.core.reviews.last`` (owned by core; optional: missing module, another
    signature or any error means "no review"). Tried as ``last(profile, "investments")``, then, on a
    ``TypeError``, as ``last(session, profile.id, "investments")``. The record may be an object or a
    dict with ``done_at`` (datetime or ISO text), ``notes`` and ``stats``. The module is looked up per
    call, so it can appear (or be replaced in tests) at runtime. Adjust only this helper when the
    reviews contract changes.
    """
    try:
        reviews = importlib.import_module("finanse.core.reviews")
    except ImportError:
        return None
    lookup = getattr(reviews, "last", None)
    if not callable(lookup):
        return None
    try:
        try:
            record = lookup(profile, REVIEW_MODULE)
        except TypeError:
            record = lookup(session, profile.id, REVIEW_MODULE)
    except Exception:  # noqa: BLE001 - an optional dependency must never break the digest
        return None
    if record is None:
        return None

    def get(name: str):
        if isinstance(record, dict):
            return record.get(name)
        return getattr(record, name, None)

    done_at = get("done_at")
    if isinstance(done_at, str):
        try:
            done_at = dt.datetime.fromisoformat(done_at)
        except ValueError:
            return None
    if not isinstance(done_at, dt.datetime):
        return None
    stats = get("stats")
    notes = get("notes")
    return {
        "done_at": convert.aware(done_at),
        "notes": None if notes is None else str(notes),
        "stats": dict(stats) if isinstance(stats, dict) else {},
    }


def _last_weekday(day: dt.date, iso_weekday: int) -> dt.date:
    """The latest date on/before ``day`` falling on ``iso_weekday`` (Monday = 1)."""
    return day - dt.timedelta(days=(day.isoweekday() - iso_weekday) % 7)


def _at_or_after(value: dt.datetime | None, since_at: dt.datetime) -> bool:
    return value is not None and convert.aware(value) >= since_at


def _price_moves(session: Session, state: portfolio.PortfolioState, since: dt.date) -> list[dict]:
    """Held market-valued instruments whose newest close moved at least ``PRICE_MOVE_MIN`` from the
    close on/before ``since``, largest move first."""
    held: dict[InstrumentId, Instrument] = {}
    for v in state.valued.valued:
        if v.valuation_mode == ValuationMode.MARKET:
            held.setdefault(v.instrument_id, v.instrument)
    series = market.bars(
        session,
        [convert.pk(i) for i in held],
        until=state.as_of,
        since=since - dt.timedelta(days=31),
    )
    moves = []
    for instrument_id, inst in held.items():
        bars = series.get(instrument_id, ())
        start = next((b for b in reversed(bars) if b.date <= since), None)
        if start is None or not bars or start.close <= 0:
            continue
        end = bars[-1]
        change = ratio(end.close - start.close, start.close)
        if change is None or abs(change) < PRICE_MOVE_MIN:
            continue
        moves.append(
            {
                "instrument_id": convert.maybe_pk(instrument_id),
                "label": inst.label,
                "currency": str(end.currency or inst.currency),
                "from_date": iso(start.date),
                "from": f(start.close),
                "to_date": iso(end.date),
                "to": f(end.close),
                "change_pct": ratio_pct(change),
            }
        )
    moves.sort(key=lambda m: -abs(m["change_pct"]))
    return moves


EVENTS_LIMIT = 200


def _local_midnight(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time.min).astimezone().astimezone(dt.UTC)


def _digest_events(
    *,
    new_rows: list[InvSignal],
    escalated: list[InvSignal],
    escalated_at: dict[int, dt.datetime],
    resolved: list[InvSignal],
    labels: dict[int, str],
    batches: list[InvImportBatch],
    decisions: list[InvDecision],
    txns: list,
    runs: list[InvRuleRun],
) -> list[dict]:
    """The re-entry change log: one typed, dated entry per change, newest first. Types:
    ``signal_created``, ``alert_triggered``, ``signal_escalated``, ``signal_resolved``, ``import``,
    ``decision``, ``deposit``, ``withdrawal``, ``data_warning``."""
    out: list[tuple[dt.datetime, dict]] = []

    def signal_fields(row: InvSignal) -> dict:
        return {
            "signal_id": row.id,
            "alert_id": alert_id_of(row.rule_id),
            "kind": row.kind,
            "rule_id": row.rule_id,
            "severity": row.severity,
            "polarity": row.polarity,
            "status": row.status,
            "message": row.message,
            **_message_code(row, labels),
            "instrument_id": row.instrument_id,
            "instrument_label": labels.get(row.instrument_id) if row.instrument_id else None,
            "bucket_id": (row.payload or {}).get("bucket_id"),  # drift / bucket signals (F6)
        }

    def add(event_type: str, at: dt.datetime | dt.date, /, **fields) -> None:
        moment = convert.aware(at) if isinstance(at, dt.datetime) else _local_midnight(at)
        date = at.astimezone().date() if isinstance(at, dt.datetime) else at
        out.append((moment, {"type": event_type, "at": iso(at), "date": iso(date), **fields}))

    for row in new_rows:
        kind = "alert_triggered" if is_alert_key(row.rule_id) else "signal_created"
        add(kind, row.first_seen_at, **signal_fields(row))
    for row in escalated:
        add("signal_escalated", escalated_at.get(row.id, row.last_seen_at), **signal_fields(row))
    for row in resolved:
        if row.closed_at is not None:
            add("signal_resolved", row.closed_at, **signal_fields(row))
    for b in batches:
        add(
            "import",
            b.created_at,
            batch_id=b.id,
            account_id=b.account_id,
            file_name=b.file_name,
            inserted=b.txn_count,
            duplicates=b.duplicate_count,
        )
    for d in decisions:
        add(
            "decision",
            d.created_at,
            decision_id=d.id,
            signal_id=d.signal_id,
            action=d.action,
            instrument_id=d.instrument_id,
            instrument_label=labels.get(d.instrument_id) if d.instrument_id else None,
            reason=d.reason,
        )
    for t in txns:
        if t.type in (TxnType.DEPOSIT, TxnType.WITHDRAWAL):
            add(
                t.type.value,
                t.trade_date,
                account_id=convert.maybe_pk(t.account_id),
                amount=f(t.cash_amount),
                currency=str(t.cash_currency),
            )
    for run in runs:
        if run.status in ("partial", "failed") and run.errors:
            add(
                "data_warning",
                run.started_at,
                run_id=run.id,
                status=run.status,
                message=run.errors[0],
                count=len(run.errors),
            )
    out.sort(key=lambda item: item[0], reverse=True)
    return [event for _, event in out]


def _net_contributions(
    state: portfolio.PortfolioState, *, after: dt.date, until: dt.date
) -> Decimal | None:
    """Deposits minus withdrawals dated after ``after`` up to ``until``, in the base currency at the
    trade-date rate (None when a rate is missing: the split would be a guess)."""
    total = Decimal(0)
    for t in state.txns:
        if t.type not in (TxnType.DEPOSIT, TxnType.WITHDRAWAL) or not after < t.trade_date <= until:
            continue
        converted = fx_convert(state.fx, t.cash_amount, t.cash_currency, state.base, t.trade_date)
        if converted is None:
            return None
        total += converted
    return total


_UNIT_FLOWS = (TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT)
_log = logging.getLogger("finanse.investments.views")


def _other_flows(
    session: Session,
    profile: Profile,
    state: portfolio.PortfolioState,
    *,
    after: dt.date,
    until: dt.date,
) -> tuple[Decimal | None, Decimal]:
    """External flows other than deposits / withdrawals dated after ``after`` up to ``until``, like
    the performance engine counts them (F6 review V4): ``(transfers, implied_funding)``.

    ``transfers``: units moved in / out and adjustments at the day's unit value the performance
    series used, cash-only transfers at the trade-date rate; None when one cannot be valued.
    ``implied_funding``: cash gaps filled by unrecorded money (negative cash and its reversal)."""
    window = [
        t for t in state.txns if t.type in _UNIT_FLOWS and after < t.trade_date <= until
    ]
    unit_moves = [t for t in window if t.instrument_id is not None and t.quantity]
    transfers: Decimal | None = Decimal(0)
    for t in window:
        if t in unit_moves:
            continue
        converted = fx_convert(state.fx, t.cash_amount, t.cash_currency, state.base, t.trade_date)
        if converted is None:
            return None, Decimal(0)
        transfers += converted
    implied = Decimal(0)
    try:
        from ..performance import service as perf

        computed = perf.compute(session, profile, as_of=until)
    except Exception:  # noqa: BLE001 - the digest still answers; the split is then unknown
        _log.exception("review digest: performance flows failed")
        return (None if unit_moves else transfers), implied
    if not computed.has_history:
        return (None if unit_moves else transfers), implied
    series = computed.series
    for t in unit_moves:
        value = series.txn_values.get(t.id)
        if value is None:
            return None, implied
        transfers += -value if t.type == TxnType.TRANSFER_OUT else value
    combined = computed.combined()
    for day, gap in zip(series.dates, combined.implied, strict=True):
        if after < day <= until and gap:
            implied += Decimal(str(gap))
    return transfers, implied


def review_digest(session: Session, profile: Profile, since_date: dt.date | None = None) -> dict:
    """What changed since the last weekly review (or the last 7 days without one, or since
    ``since_date`` when given: baseline ``since``): value, signals, imports, transactions, decisions,
    dividends, larger price moves, current warnings, strategy, and a typed, dated ``events`` list.

    Timestamps (``*_at``) compare with the baseline instant ``since_at``; dates (dividends, the
    value then, price moves) with its local calendar date ``since`` (never after ``as_of``).
    """
    st = strategy_files.load(session, profile)
    config = st.config
    state = portfolio.build(session, profile, strategy=config)
    as_of = state.as_of
    now = utcnow()
    review = last_review(session, profile)
    if since_date is not None:
        since_at = _local_midnight(since_date)
    else:
        since_at = review["done_at"] if review else now - dt.timedelta(days=DEFAULT_DIGEST_DAYS)
    since = min(since_at.astimezone().date(), as_of)
    weekday = config.notifications.digest_weekday if config is not None else None
    digest_weekday = weekday.value if weekday is not None else "sunday"
    last_digest_day = _last_weekday(as_of, weekday.iso_number if weekday is not None else 7)
    review_due = review is None or last_digest_day > review["done_at"].astimezone().date()

    # Value then and now (base currency).
    total = state.valued.total_base
    then_total: Decimal | None = None
    if any(t.trade_date <= since for t in state.txns):
        then = portfolio.build(session, profile, as_of=since, strategy=config, base=state.base)
        then_total = then.valued.total_base
    change = None if then_total is None else total - then_total
    contributions = (
        None if then_total is None else _net_contributions(state, after=since, until=as_of)
    )
    transfers: Decimal | None = None
    implied = Decimal(0)
    if then_total is not None:
        transfers, implied = _other_flows(session, profile, state, after=since, until=as_of)
    market_change = (
        None
        if change is None or contributions is None or transfers is None
        else change - contributions - transfers - implied
    )

    # Signals.
    from ..store import instruments as instrument_store

    rows = list(
        session.exec(
            select(InvSignal)
            .where(InvSignal.profile_id == profile.id)
            .order_by(InvSignal.id.desc())
        ).all()
    )
    decisions = journal.decisions(session, profile.id)
    by_signal: dict[int, list[InvDecision]] = defaultdict(list)
    for d in decisions:
        if d.signal_id is not None:
            by_signal[d.signal_id].append(d)
    labels = {
        k: v.label
        for k, v in instrument_store.load(
            session, {r.instrument_id for r in rows if r.instrument_id}, profile_id=profile.id
        ).items()
    }
    new_rows = [r for r in rows if _at_or_after(r.first_seen_at, since_at)]
    new_ids = {r.id for r in new_rows}
    escalated_ids: set[int] = set()
    escalated_at: dict[int, dt.datetime] = {}
    runs_since: list[InvRuleRun] = []
    for run in session.exec(select(InvRuleRun).where(InvRuleRun.profile_id == profile.id)).all():
        if _at_or_after(run.started_at, since_at):
            runs_since.append(run)
            for i in (run.report or {}).get("escalated", []):
                escalated_ids.add(int(i))
                escalated_at[int(i)] = max(escalated_at.get(int(i), run.started_at), run.started_at)
    escalated = [r for r in rows if r.id in escalated_ids and r.id not in new_ids]
    resolved = [
        r
        for r in rows
        if r.status in signals.CLOSED_STATUSES and _at_or_after(r.closed_at, since_at)
    ]
    open_rows = [r for r in rows if r.status in signals.OPEN_STATUSES]

    def signal_rows(found: list[InvSignal]) -> list[dict]:
        return [signal_dict(r, by_signal.get(r.id, []), labels) for r in found]

    # Imports, transactions, decisions since the baseline.
    names = {a.id: a.name for a in transactions.brokerage_accounts(session, profile.id)}
    batches = session.exec(
        select(InvImportBatch)
        .where(InvImportBatch.profile_id == profile.id)
        .order_by(InvImportBatch.created_at.desc(), InvImportBatch.id.desc())
    ).all()
    imports_since = []
    for b in batches:
        if _at_or_after(b.created_at, since_at):
            row = batch_dict(b)
            row["account_name"] = names.get(b.account_id)
            imports_since.append(row)
    created = [
        t
        for t in transactions.transaction_rows(session, profile.id)
        if _at_or_after(t.created_at, since_at)
    ]
    dividends: dict[str, Decimal] = defaultdict(Decimal)
    for t in state.txns:
        if t.type == TxnType.DIVIDEND and t.trade_date >= since:
            dividends[str(t.cash_currency)] += t.cash_amount

    events = _digest_events(
        new_rows=new_rows,
        escalated=escalated,
        escalated_at=escalated_at,
        resolved=resolved,
        labels=labels,
        batches=[b for b in batches if _at_or_after(b.created_at, since_at)],
        decisions=[d for d in decisions if _at_or_after(d.created_at, since_at)],
        txns=[t for t in state.txns if since < t.trade_date <= as_of],  # like contributions
        runs=runs_since,
    )
    return {
        "as_of": iso(as_of),
        "since": iso(since),
        "since_at": iso(since_at),
        "until_at": iso(now),
        "baseline": "since" if since_date is not None else ("review" if review else "default_7d"),
        "events": events[:EVENTS_LIMIT],
        "events_total": len(events),
        "last_review": None
        if review is None
        else {
            "done_at": iso(review["done_at"]),
            "notes": review["notes"],
            "stats": review["stats"],
        },
        "digest_weekday": digest_weekday,
        "review_due": review_due,
        "value": {
            "currency": str(state.base),
            "then": f(then_total),
            "now": f(total),
            "change": f(change),
            "change_pct": ratio_pct(ratio(change, then_total)) if change is not None else None,
            # change = contributions (net deposits - withdrawals) + transfers (units moved in / out,
            # adjustments, cash transfers) + implied_funding (cash gaps filled by unrecorded money)
            # + market_change (the market part), like the performance engine's external flows
            "contributions": f(contributions),
            "transfers": f(transfers),
            "implied_funding": f(implied) if then_total is not None else None,
            "market_change": f(market_change),
            "market_change_pct": ratio_pct(ratio(market_change, then_total))
            if market_change is not None
            else None,
        },
        "signals": {
            "new": signal_rows(new_rows),
            "escalated": signal_rows(escalated),
            "resolved": signal_rows(resolved),
            "open": len(open_rows),
            "undecided": sum(1 for r in open_rows if not by_signal.get(r.id)),
        },
        "imports": imports_since,
        "transactions": {
            "count": len(created),
            "by_type": dict(sorted(Counter(t.type for t in created).items())),
            "manual": sum(1 for t in created if t.source == TxnSource.MANUAL.value),
        },
        "decisions": [decision_dict(d) for d in decisions if _at_or_after(d.created_at, since_at)],
        "dividends": {cur: f(amount) for cur, amount in sorted(dividends.items())},
        "price_moves": _price_moves(session, state, since),
        "warnings": [warning_dict(w) for w in state.valued.all_warnings],
        "stale_count": sum(1 for v in state.valued.valued if v.is_stale),
        "strategy": {
            "version": st.version.version if st.version is not None else None,
            "state": st.state,
            "changed_since": any(
                _at_or_after(v.created_at, since_at)
                for v in strategy_files.versions(session, profile.id)
            ),
        },
        # research since the same baseline (F6, research.views; run null = research never ran)
        "research": research_digest(session, profile.id, since_at, now=now),
    }
