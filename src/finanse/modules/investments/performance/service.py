"""Performance service: loads a profile's history through the store, runs the pure performance code and
shapes the JSON the API, the CLI and the MCP tool read. No network (``backfill`` fetches prices).

The full-history computation (daily series of every account, benchmark prices) is cached in memory per
profile and recomputed when a cheap fingerprint changes: transactions, renames, manual valuations,
strategy files, the stored bars / rates / instrument rows involved, or the date. Ranges and account
filters are cut from the cached series.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import threading
from collections import OrderedDict
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core.models import Account, Profile

from ..domain import (
    AliasNamespace,
    AllocationPlan,
    Currency,
    Instrument,
    InstrumentRename,
    ManualValuation,
    PriceBar,
    Transaction,
)
from ..models import (
    InvFxRate,
    InvInstrument,
    InvInstrumentRename,
    InvPriceBar,
    InvTransaction,
)
from ..portfolio import InMemoryFxLookup
from ..service import portfolio as portfolio_service
from ..service import strategy as strategy_files
from ..store import convert, market, transactions
from ..store import instruments as instrument_store
from ..strategy import Benchmark
from . import attribution as attr
from . import report, returns
from .benchmark import benchmark_prices
from .returns import Drawdown
from .series import PortfolioSeries, Renames, ValuationPolicy, build_series

ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
CACHE_SIZE = 8
HISTORY_MARGIN_DAYS = 14
"""Bars and rates are loaded from this many days before the first transaction (weekends, holidays)."""


class RangeError(ValueError):
    """Unknown range key (message safe to show)."""


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #


def is_isin(value: str) -> bool:
    return bool(ISIN.match(value.strip().upper()))


def find_proxy(session: Session, proxy: str) -> Instrument | None:
    """The stored instrument a strategy ``benchmark.proxy`` names: by ISIN, else by its yahoo alias
    (a guessed alias counts; as written, upper or lower case), else by a stooq alias."""
    value = proxy.strip()
    if not value:
        return None
    lookup = instrument_store.DbInstrumentLookup(session)
    if is_isin(value):
        found = lookup.by_isin(value)
        if found is not None:
            return found
    for namespace in (AliasNamespace.YAHOO, AliasNamespace.STOOQ):
        for variant in dict.fromkeys((value, value.upper(), value.lower())):
            found = lookup.by_alias(namespace, variant)
            if found is not None:
                return found
    return None


@dataclass
class Loaded:
    """One profile's inputs, read in one session."""

    profile_id: int
    base: Currency
    policy: ValuationPolicy
    plan: AllocationPlan | None
    benchmark: Benchmark | None
    strategy_state: str
    accounts: list[Account]
    txns: list[Transaction]
    renames: list[InstrumentRename]
    instruments: dict[str, Instrument]
    bars: dict[str, tuple[PriceBar, ...]]
    manual: dict[str, tuple[ManualValuation, ...]]
    fx: InMemoryFxLookup
    benchmark_instrument: Instrument | None = None
    benchmark_bars: tuple[PriceBar, ...] = ()
    instrument_pks: frozenset[int] = frozenset()
    currencies: frozenset[str] = frozenset()


def load(session: Session, profile: Profile, end: dt.date) -> Loaded:
    st = strategy_files.load(session, profile)
    config = st.config
    base = portfolio_service.base_currency(profile, config)
    data = config.data if config is not None else None
    policy = (
        ValuationPolicy(data.max_price_age_days, data.max_fx_age_days)
        if data is not None
        else ValuationPolicy()
    )
    pid = profile.id
    txns = [t for t in transactions.transactions(session, pid) if t.trade_date <= end]
    renames = transactions.renames(session, pid)
    referenced = {convert.pk(t.instrument_id) for t in txns if t.instrument_id is not None}
    for r in renames:
        referenced |= {convert.pk(r.old_instrument_id), convert.pk(r.new_instrument_id)}
    benchmark = config.benchmark if config is not None else None
    proxy = find_proxy(session, benchmark.proxy) if benchmark is not None else None
    pks = set(referenced)
    if proxy is not None:
        pks.add(convert.pk(proxy.id))
    loaded = {convert.sid(k): v for k, v in instrument_store.load(session, pks).items()}
    first = min((t.trade_date for t in txns), default=end)
    since = first - dt.timedelta(days=HISTORY_MARGIN_DAYS)
    series = market.bars(session, pks, until=end, since=since)
    manual: dict[str, list[ManualValuation]] = {}
    for valuation in transactions.manual_valuations(session, pid):
        manual.setdefault(valuation.instrument_id, []).append(valuation)
    currencies = {str(base)}
    for t in txns:
        currencies |= {str(t.currency), str(t.cash_currency)}
    for inst in loaded.values():
        currencies.add(str(inst.currency))
    for values in manual.values():
        currencies |= {str(v.currency) for v in values}
    fx = InMemoryFxLookup(market.rates(session, currencies, until=end, since=since))
    bench_bars: tuple[PriceBar, ...] = ()
    if proxy is not None:
        bench_bars = series.get(proxy.id, ())
        if proxy.id not in {convert.sid(k) for k in referenced}:
            series = {k: v for k, v in series.items() if k != proxy.id}
    return Loaded(
        profile_id=pid,
        base=base,
        policy=policy,
        plan=config.allocation if config is not None else None,
        benchmark=benchmark,
        strategy_state=st.state,
        accounts=transactions.brokerage_accounts(session, pid),
        txns=txns,
        renames=renames,
        instruments=dict(loaded),
        bars=series,
        manual={k: tuple(sorted(v, key=lambda m: m.as_of)) for k, v in manual.items()},
        fx=fx,
        benchmark_instrument=proxy,
        benchmark_bars=bench_bars,
        instrument_pks=frozenset(pks),
        currencies=frozenset(currencies),
    )


# --------------------------------------------------------------------------- #
# Computing (cached)
# --------------------------------------------------------------------------- #


@dataclass
class Computed:
    loaded: Loaded
    end: dt.date
    series: PortfolioSeries
    bench_prices: list[float | None] | None
    _ranges: dict = field(default_factory=dict)

    @property
    def has_history(self) -> bool:
        return bool(self.loaded.txns)

    def combined(self, account_ids: Collection[str] | None = None):
        return self.series.combined(account_ids)


_cache: OrderedDict[int, tuple[tuple, tuple, Computed]] = OrderedDict()
_lock = threading.Lock()


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _profile_key(session: Session, profile: Profile, end: dt.date) -> tuple:
    accounts = [a.id for a in transactions.brokerage_accounts(session, profile.id)]
    txn = (0, None)
    if accounts:
        txn = tuple(
            session.exec(
                select(func.count(InvTransaction.id), func.max(InvTransaction.id)).where(
                    InvTransaction.account_id.in_(accounts)
                )
            ).one()
        )
    renames = tuple(
        session.exec(
            select(func.count(InvInstrumentRename.id), func.max(InvInstrumentRename.id)).where(
                InvInstrumentRename.profile_id == profile.id
            )
        ).one()
    )
    digest = hashlib.sha256()
    for row in transactions.manual_valuation_rows(session, profile.id):
        digest.update(f"{row.instrument_id}|{row.as_of}|{row.unit_value}|{row.currency};".encode())
    st = strategy_files.load(session, profile)
    return (
        end,
        tuple(accounts),
        txn,
        renames,
        digest.hexdigest(),
        st.sha256,
        st.state,
        profile.base_currency,
    )


def _market_key(session: Session, pks: Collection[int], currencies: Collection[str]) -> tuple:
    ids = sorted(pks)
    bars = (0, None, None)
    inst = None
    if ids:
        bars = tuple(
            session.exec(
                select(
                    func.count(InvPriceBar.id),
                    func.max(InvPriceBar.date),
                    func.max(InvPriceBar.fetched_at),
                ).where(InvPriceBar.instrument_id.in_(ids))
            ).one()
        )
        inst = session.exec(
            select(func.max(InvInstrument.updated_at)).where(InvInstrument.id.in_(ids))
        ).one()
    rates = tuple(
        session.exec(
            select(
                func.count(InvFxRate.id), func.max(InvFxRate.date), func.max(InvFxRate.fetched_at)
            ).where(InvFxRate.quote.in_(sorted(currencies)))
        ).one()
    )
    return (bars, rates, inst)


def compute(session: Session, profile: Profile, *, as_of: dt.date | None = None) -> Computed:
    """The full-history computation of ``profile`` up to ``as_of`` (today by default), cached."""
    end = as_of or portfolio_service.today()
    key = _profile_key(session, profile, end)
    with _lock:
        hit = _cache.get(profile.id)
    if hit is not None and hit[0] == key:
        computed = hit[2]
        if (
            _market_key(session, computed.loaded.instrument_pks, computed.loaded.currencies)
            == hit[1]
        ):
            with _lock:
                _cache.move_to_end(profile.id)
            return computed
    loaded = load(session, profile, end)
    computed = _compute(loaded, end)
    market_key = _market_key(session, loaded.instrument_pks, loaded.currencies)
    with _lock:
        _cache[profile.id] = (key, market_key, computed)
        _cache.move_to_end(profile.id)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return computed


def _compute(loaded: Loaded, end: dt.date) -> Computed:
    if not loaded.txns:
        empty = PortfolioSeries(loaded.base, [end], {}, {}, {}, [])
        return Computed(loaded, end, empty, None)
    first = min(t.trade_date for t in loaded.txns)
    anchor = first - dt.timedelta(days=1)
    captures = {report.range_base(k, end, anchor) for k in report.RANGES} | {end}
    series = build_series(
        loaded.txns,
        instruments=loaded.instruments,
        bars=loaded.bars,
        fx=loaded.fx,
        base=loaded.base,
        end=end,
        renames=loaded.renames,
        manual_valuations=loaded.manual,
        policy=loaded.policy,
        capture_dates=captures,
    )
    bench = None
    proxy = loaded.benchmark_instrument
    if proxy is not None and loaded.benchmark_bars:
        bench = benchmark_prices(
            series.dates,
            loaded.benchmark_bars,
            proxy.currency,
            loaded.fx,
            loaded.base,
            max_price_age_days=loaded.policy.max_price_age_days,
            max_fx_age_days=loaded.policy.max_fx_age_days,
        )
        if all(p is None for p in bench):
            bench = None
    return Computed(loaded, end, series, bench)


# --------------------------------------------------------------------------- #
# JSON helpers
# --------------------------------------------------------------------------- #


def _money(value: float | Decimal | None) -> float | None:
    return None if value is None else round(float(value), 2)


def _ratio(value: float | None) -> float | None:
    return None if value is None else round(float(value), 6)


def _iso(value: dt.date | None) -> str | None:
    return None if value is None else value.isoformat()


def _drawdown(dd: Drawdown | None) -> dict | None:
    return None if dd is None else dd.to_dict()


def check_range(range_key: str) -> str:
    if range_key not in report.RANGES:
        raise RangeError(f"range must be one of {', '.join(report.RANGES)}")
    return range_key


def sample(dates: Sequence[dt.date]) -> tuple[str, list[int]]:
    """Chart points: daily up to ~13 months, weekly (counted back from the last day) up to ~5 years,
    month ends beyond. The first and last day are always included."""
    n = len(dates)
    span = (dates[-1] - dates[0]).days
    if span <= 400:
        return "day", list(range(n))
    if span <= 1900:
        picked = {i for i in range(n) if (n - 1 - i) % 7 == 0}
        step = "week"
    else:
        picked = set(report.month_ends(dates))
        step = "month"
    picked |= {0, n - 1}
    return step, sorted(picked)


def _scope(computed: Computed, account_ids: Collection[int] | None) -> frozenset[str] | None:
    return None if account_ids is None else frozenset(convert.sid(a) for a in account_ids)


def _benchmark_meta(computed: Computed) -> dict:
    loaded = computed.loaded
    bench = loaded.benchmark
    proxy = loaded.benchmark_instrument
    meta = {
        "status": "ok",
        "message": None,
        "id": None if bench is None else bench.id,
        "proxy": None if bench is None else bench.proxy,
        "instrument_id": None if proxy is None else convert.maybe_pk(proxy.id),
        "currency": None if proxy is None else str(proxy.currency),
    }
    if loaded.strategy_state in ("missing", "invalid"):
        meta.update(
            status="no_strategy",
            message="No usable strategy.yaml: its benchmark section names the comparison.",
        )
    elif bench is None:
        meta.update(status="not_configured", message="The strategy has no benchmark section.")
    elif proxy is None:
        meta.update(
            status="proxy_not_found",
            message=f"No stored instrument for the benchmark proxy {bench.proxy}: run "
            "`finanse invest backfill` (a Yahoo symbol is added automatically; an ISIN must be "
            "an instrument already known).",
        )
    elif computed.bench_prices is None:
        meta.update(
            status="no_prices",
            message=f"No usable prices of {bench.proxy} yet: run `finanse invest backfill`.",
        )
    return meta


def _label(computed: Computed, instrument_id: str) -> dict:
    inst = computed.loaded.instruments.get(instrument_id)
    if inst is None:
        return {
            "instrument_id": convert.maybe_pk(instrument_id),
            "label": instrument_id,
            "symbol": None,
            "name": None,
            "asset_class": None,
            "isin": None,
            "valuation_mode": None,
        }
    return {
        "instrument_id": convert.maybe_pk(instrument_id),
        "label": inst.label,
        "symbol": inst.symbol,
        "name": inst.name,
        "asset_class": inst.asset_class.value,
        "isin": inst.isin,
        "valuation_mode": inst.valuation_mode.value if inst.valuation_mode else None,
    }


def _data_quality(computed: Computed, metrics: report.RangeMetrics, bench: dict) -> dict:
    s = computed.series
    summary = metrics.summary
    held = {iid for (_a, iid) in s.captures.get(computed.end, {})}
    newest = [s.last_bar_dates[i] for i in held if i in s.last_bar_dates]
    notes: list[dict] = []
    if summary["incomplete_days"]:
        notes.append(
            {
                "code": "incomplete_days",
                "message": f"{summary['incomplete_days']} day(s) could not be valued in full (a "
                "price, an FX rate or a manual valuation is missing); returns link over them.",
            }
        )
    if summary["implied_funding"]:
        notes.append(
            {
                "code": "implied_funding",
                "message": "A cash balance went negative (deposits missing from the history): the "
                "shortfall is counted as a contribution.",
            }
        )
    if s.price_scales:
        notes.append(
            {
                "code": "price_scale_inferred",
                "message": "Some trade prices sit at a clean multiple of the stored closes (a split "
                "the history does not book); the closes before those trades were scaled.",
            }
        )
    if s.unknown_flows:
        notes.append(
            {
                "code": "unknown_flows",
                "message": f"{len(s.unknown_flows)} transfer(s) or deposit(s) could not be valued "
                "(no FX rate or price) and count as 0.",
            }
        )
    if bench.get("status") == "ok" and not bench.get("covers_range", True):
        notes.append(
            {
                "code": "benchmark_partial",
                "message": "The benchmark's stored prices start after the range start; the "
                "simulation starts on its first priced day.",
            }
        )
    return {
        "incomplete_days": summary["incomplete_days"],
        "end_complete": summary["end_complete"],
        "implied_funding": _money(summary["implied_funding"]),
        "unknown_flows": len(s.unknown_flows),
        "price_scales": [
            {
                **_label(computed, p.instrument_id),
                "until": p.until.isoformat(),
                "factor": str(p.factor),
            }
            for p in s.price_scales
        ],
        "price_mismatches": len(s.price_mismatches),
        "newest_price": _iso(max(newest) if newest else None),
        "benchmark_newest_price": _iso(
            computed.loaded.benchmark_bars[-1].date if computed.loaded.benchmark_bars else None
        ),
        "notes": notes,
    }


def _summary_dict(summary: dict) -> dict:
    return {
        "start_value": _money(summary["start_value"]),
        "end_value": _money(summary["end_value"]),
        "net_contributions": _money(summary["net_contributions"]),
        "deposits": _money(summary["deposits"]),
        "withdrawals": _money(summary["withdrawals"]),
        "implied_funding": _money(summary["implied_funding"]),
        "account_fees": _money(summary["account_fees"]),
        "pnl": _money(summary["pnl"]),
        "twr": _ratio(summary["twr"]),
        "twr_annualized": _ratio(summary["twr_annualized"]),
        "xirr": _ratio(summary["xirr"]),
        "mwr": _ratio(summary["mwr"]),
        "max_drawdown": _drawdown(summary["max_drawdown"]),
        "days": summary["days"],
    }


def _benchmark_dict(meta: dict, metrics: report.RangeMetrics | None) -> dict:
    out = dict(meta)
    b = metrics.benchmark if metrics is not None else {}
    if meta["status"] != "ok" or not b:
        out.update(
            first_priced=None,
            covers_range=None,
            twr=None,
            twr_annualized=None,
            max_drawdown=None,
            simulation=None,
            excess_twr=None,
            excess_value=None,
            excess_vs_simulation=None,
        )
        return out
    out.update(
        first_priced=_iso(b["first_priced"]),
        covers_range=b["covers_range"],
        twr=_ratio(b["twr"]),
        twr_annualized=_ratio(b["twr_annualized"]),
        max_drawdown=_drawdown(b["max_drawdown"]),
        simulation={
            "end_value": _money(b["simulation_end_value"]),
            "end_value_with_fees": _money(b["simulation_end_value_with_fees"]),
            "pnl": _money(b["simulation_pnl"]),
            "xirr": _ratio(b["simulation_xirr"]),
            "mwr": _ratio(b["simulation_mwr"]),
            "started": _iso(b["simulation_started"]),
            "capped": b["simulation_capped"],
        },
        excess_twr=_ratio(b["excess_twr"]),
        excess_value=_money(b["excess_value"]),
        excess_vs_simulation=_ratio(b["excess_vs_simulation"]),
    )
    return out


def _range_metrics(
    computed: Computed, range_key: str, scope: frozenset[str] | None
) -> tuple[report.RangeMetrics, object]:
    combined = computed.combined(scope)
    metrics = report.compute_range(
        range_key, computed.series.dates, combined, computed.bench_prices
    )
    return metrics, combined


# --------------------------------------------------------------------------- #
# Views
# --------------------------------------------------------------------------- #


def _empty(computed: Computed, range_key: str, account_ids) -> dict:
    meta = _benchmark_meta(computed)
    return {
        "as_of": computed.end.isoformat(),
        "base_currency": str(computed.loaded.base),
        "range": range_key,
        "start": None,
        "end": computed.end.isoformat(),
        "accounts_filter": account_ids,
        "step": "day",
        "points": [],
        "summary": None,
        "benchmark": _benchmark_dict(meta, None),
        "rolling": [],
        "accounts": [],
        "data_quality": None,
    }


def performance_view(
    session: Session,
    profile: Profile,
    *,
    range_key: str = "1y",
    account_ids: list[int] | None = None,
    as_of: dt.date | None = None,
) -> dict:
    """``GET /investments/performance`` (see the CONTRACT in docs/fork/progress/F5-PF.md)."""
    check_range(range_key)
    computed = compute(session, profile, as_of=as_of)
    if not computed.has_history:
        return _empty(computed, range_key, account_ids)
    scope = _scope(computed, account_ids)
    metrics, combined = _range_metrics(computed, range_key, scope)
    meta = _benchmark_meta(computed)
    step, picked = sample(metrics.dates)

    contributions = []
    running = metrics.values[0]
    for i, f in enumerate(metrics.flows):
        if i > 0:
            running += f
        contributions.append(running)
    points = []
    prev = 0
    for k, i in enumerate(picked):
        flow = sum(metrics.flows[prev + 1 : i + 1]) if k > 0 else 0.0
        prev = i
        twr = metrics.twr[i]
        bindex = None if metrics.benchmark_index is None else metrics.benchmark_index[i]
        sim = None if metrics.simulation is None else metrics.simulation.values[i]
        points.append(
            {
                "date": metrics.dates[i].isoformat(),
                "value": _money(metrics.values[i]),
                "contributions": _money(contributions[i]),
                "flow": _money(flow),
                "twr": None if twr is None else _ratio(twr - 1),
                "drawdown": _ratio(metrics.drawdown[i]),
                "benchmark": None if bindex is None else _ratio(bindex - 1),
                "benchmark_drawdown": None
                if metrics.benchmark_drawdown is None
                else _ratio(metrics.benchmark_drawdown[i]),
                "simulated_value": _money(sim),
                "complete": metrics.complete[i],
            }
        )

    offset = computed.series.index_of(metrics.start)
    accounts = []
    names = {convert.sid(a.id): a for a in computed.loaded.accounts}
    for account_id, acc_series in computed.series.accounts.items():
        if scope is not None and account_id not in scope:
            continue
        single = computed.series.combined({account_id})
        acc_metrics = report.compute_range(range_key, computed.series.dates, single, None)
        acc = names.get(account_id)
        accounts.append(
            {
                "account_id": convert.maybe_pk(account_id),
                "name": None if acc is None else acc.name,
                "currency": None if acc is None else acc.currency,
                "values": [_money(acc_series.values[offset + i]) for i in picked],
                "summary": _summary_dict(acc_metrics.summary),
            }
        )

    full_twr = returns.twr_index(combined.values, combined.flows, combined.complete)
    rolling = []
    for months in report.ROLLING_MONTHS:
        windows = report.rolling(
            computed.series.dates,
            combined,
            full_twr,
            computed.bench_prices,
            months,
            from_date=metrics.start,
        )
        summary = report.rolling_summary(windows)
        latest = summary["latest"]
        rolling.append(
            {
                "months": months,
                "points": [
                    {
                        "date": p.date.isoformat(),
                        "portfolio": _ratio(p.portfolio),
                        "benchmark": _ratio(p.benchmark),
                        "excess": _ratio(p.excess),
                    }
                    for p in windows
                ],
                "windows": summary["windows"],
                "latest_excess": None if latest is None else _ratio(latest.excess),
                "min_excess": _ratio(summary["min_excess"]),
                "max_excess": _ratio(summary["max_excess"]),
                "share_outperforming": _ratio(summary["share_outperforming"]),
            }
        )

    bench = _benchmark_dict(meta, metrics)
    return {
        "as_of": computed.end.isoformat(),
        "base_currency": str(computed.loaded.base),
        "range": range_key,
        "start": metrics.start.isoformat(),
        "end": metrics.end.isoformat(),
        "accounts_filter": account_ids,
        "step": step,
        "points": points,
        "summary": _summary_dict(metrics.summary),
        "benchmark": bench,
        "rolling": rolling,
        "accounts": accounts,
        "data_quality": _data_quality(computed, metrics, bench),
    }


def attribution_view(
    session: Session,
    profile: Profile,
    *,
    range_key: str = "max",
    account_ids: list[int] | None = None,
    as_of: dt.date | None = None,
) -> dict:
    """``GET /investments/performance/attribution``."""
    check_range(range_key)
    computed = compute(session, profile, as_of=as_of)
    loaded = computed.loaded
    grouping = (
        "strategy_buckets" if loaded.plan is not None and loaded.plan.buckets else "asset_class"
    )
    if not computed.has_history:
        return {
            "as_of": computed.end.isoformat(),
            "base_currency": str(loaded.base),
            "range": range_key,
            "start": None,
            "end": computed.end.isoformat(),
            "accounts_filter": account_ids,
            "grouping": grouping,
            "total_pnl": None,
            "instruments_pnl": None,
            "instruments": [],
            "buckets": [],
            "account_level": None,
            "other": None,
            "concentration": None,
            "data_quality": None,
        }
    scope = _scope(computed, account_ids)
    metrics, _combined = _range_metrics(computed, range_key, scope)
    result = _attribution(computed, metrics, scope)
    total_instruments = result.instruments_pnl
    conc = attr.concentration([(r.instrument_id, r.pnl) for r in result.instruments])

    def bucket(iid: str) -> str:
        return attr.bucket_of(loaded.instruments.get(iid), loaded.plan)

    def share(value: Decimal) -> float | None:
        return _ratio(float(value / total_instruments)) if total_instruments > 0 else None

    rows = [
        {
            **_label(computed, r.instrument_id),
            "bucket": bucket(r.instrument_id),
            "held": r.held,
            "start_value": _money(r.start_value),
            "end_value": _money(r.end_value),
            "invested": _money(r.invested),
            "returned": _money(r.returned),
            "income": _money(r.income),
            "costs": _money(r.costs),
            "pnl": _money(r.pnl),
            "share_of_pnl": share(r.pnl),
            "unvalued": r.unvalued,
        }
        for r in result.instruments
    ]
    buckets = [
        {"bucket": b, "pnl": _money(p), "share_of_pnl": share(p), "instruments": n}
        for b, p, n in attr.group_by_bucket(result.instruments, bucket)
    ]
    summary = metrics.summary
    total = summary["pnl"]
    level = result.account_level
    gross = summary["contributions_gross"]
    bench_pnl = metrics.benchmark.get("simulation_pnl") if metrics.benchmark else None

    def of_contributions(value) -> float | None:
        return None if value is None or not gross or gross <= 0 else _ratio(float(value) / gross)

    return {
        "as_of": computed.end.isoformat(),
        "base_currency": str(loaded.base),
        "range": range_key,
        "start": metrics.start.isoformat(),
        "end": metrics.end.isoformat(),
        "accounts_filter": account_ids,
        "grouping": grouping,
        "total_pnl": _money(total),
        "instruments_pnl": _money(total_instruments),
        "instruments": rows,
        "buckets": buckets,
        "account_level": {
            "interest": _money(level.interest),
            "fees": _money(level.fees),
            "taxes": _money(level.taxes),
            "fx_conversions": _money(level.fx_conversions),
            "other_income": _money(level.other_income),
            "total": _money(level.total),
        },
        "other": _money(Decimal(str(total)) - total_instruments - level.total),
        "concentration": {
            "positive_instruments": conc.positive,
            "negative_instruments": conc.negative,
            "top": [{"n": n, "share": _ratio(s)} for n, s in conc.top_shares],
            "top2": [_label(computed, i) for i in conc.top2],
            "pnl_without_top2": _money(conc.pnl_without_top2),
            "contributions_gross": _money(gross),
            "pnl_pct_of_contributions": of_contributions(total),
            "pnl_without_top2_pct_of_contributions": of_contributions(conc.pnl_without_top2),
            "benchmark_pnl": _money(bench_pnl),
            "benchmark_pnl_pct_of_contributions": of_contributions(bench_pnl),
        },
        "data_quality": {
            "unvalued_instruments": sum(1 for r in result.instruments if r.unvalued),
            "unknown_cash": result.unknown_cash,
        },
    }


def _attribution(
    computed: Computed, metrics: report.RangeMetrics, scope: frozenset[str] | None
) -> attr.Attribution:
    s = computed.series
    return attr.attribute(
        computed.loaded.txns,
        start=metrics.start,
        end=metrics.end,
        start_values=s.captures.get(metrics.start, {}),
        end_values=s.captures.get(metrics.end, {}),
        txn_values=s.txn_values,
        fx=computed.loaded.fx,
        base=computed.loaded.base,
        renames=Renames(computed.loaded.renames),
        account_ids=scope,
    )


def mcp_summary(session: Session, profile: Profile, *, as_of: dt.date | None = None) -> dict | None:
    """Plain values (fractions, dates, counts, short codes) for the MCP ``history_metrics`` tool: whole
    history, every account. None without investments history."""
    computed = compute(session, profile, as_of=as_of)
    if not computed.has_history:
        return None
    metrics, combined = _range_metrics(computed, "max", None)
    meta = _benchmark_meta(computed)
    bench = metrics.benchmark if meta["status"] == "ok" else {}
    result = _attribution(computed, metrics, None)
    conc = attr.concentration([(r.instrument_id, r.pnl) for r in result.instruments])
    gross = metrics.summary["contributions_gross"]

    def of_contributions(value) -> float | None:
        return None if value is None or not gross or gross <= 0 else float(value) / gross

    full_twr = returns.twr_index(combined.values, combined.flows, combined.complete)
    rolling = []
    for months in report.ROLLING_MONTHS:
        windows = report.rolling(
            computed.series.dates, combined, full_twr, computed.bench_prices, months
        )
        summary = report.rolling_summary(windows)
        rolling.append({"months": months, **summary})
    return {
        "since": metrics.dates[1] if len(metrics.dates) > 1 else metrics.dates[0],
        "as_of": computed.end,
        "base_currency": str(computed.loaded.base),
        "summary": metrics.summary,
        "benchmark_meta": meta,
        "benchmark": bench,
        "concentration": conc,
        "pnl_pct_of_contributions": of_contributions(metrics.summary["pnl"]),
        "without_top2_pct_of_contributions": of_contributions(conc.pnl_without_top2),
        "benchmark_pnl_pct_of_contributions": of_contributions(bench.get("simulation_pnl")),
        "rolling": rolling,
        "per_year": report.per_year(computed.series.dates, full_twr, computed.bench_prices),
    }
