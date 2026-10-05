"""Price history backfill for performance: every instrument a profile ever held (held now or sold)
and the strategy's benchmark proxy, from the first transaction date onward; incremental afterwards.

Phases (never a database transaction across network IO):

1. read (one short session): profiles, their instruments with the first date each is needed from,
   newest split dates, currencies, benchmark proxies;
2. a benchmark proxy that is no stored instrument yet (a Yahoo symbol) is probed at the source (the
   quote currency comes from the source's currency-mismatch answer when the first guess is wrong), then
   inserted as an instrument in one short write transaction;
3. per instrument: the missing head of the history (``need_from .. first stored bar - 1``) is fetched
   and written in one short transaction, then the stored tail is brought up to date by the shared
   ``MarketDataRefresher`` (incremental, split re-fetch) and written in another;
4. FX: the refresher with ``fx_history_from`` = the first date each currency is needed, one write.

Delisted and frozen instruments are not fetched (like the daily check). A second run only asks the
sources for the days after the newest stored bar.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable, Collection
from contextlib import AbstractContextManager
from dataclasses import dataclass, field, replace

from sqlmodel import Session, select

from finanse.core import locks, profiles
from finanse.core.db import get_session
from finanse.core.models import Profile, ProfileModule, utcnow

from ..domain import (
    AliasNamespace,
    AssetClass,
    Currency,
    Instrument,
    InstrumentAlias,
    InstrumentId,
    TxnType,
)
from ..market import (
    FetchStatus,
    MarketDataRefresher,
    PriceSource,
    QuoteCurrencyMismatchException,
    SourceException,
)
from ..portfolio import build_snapshot
from ..service import daily
from ..service import portfolio as portfolio_service
from ..service import strategy as strategy_files
from ..store import convert, market, transactions
from ..store import instruments as instrument_store
from .service import find_proxy, is_isin

LOCK_NAME = "investments-backfill"
MODULE_ID = "investments"
HEAD_MARGIN_DAYS = 7
"""History is fetched from this many days before the first transaction (a price on/before it)."""
HEAD_TOLERANCE_DAYS = 7
"""A stored history starting at most this many days after ``need_from`` counts as complete."""
PROBE_DAYS = 14
SessionFactory = Callable[[], AbstractContextManager[Session]]
_log = logging.getLogger("finanse.investments.backfill")


class BackfillBusy(RuntimeError):
    """Another backfill is running."""


@dataclass
class InstrumentResult:
    instrument_id: InstrumentId
    label: str
    role: str
    """``held``, ``sold`` or ``benchmark``."""
    need_from: dt.date
    status: str = "ok"
    """``ok`` (fetched or already complete), ``skipped`` (delisted / frozen), ``no_data``, ``error``."""
    head: tuple[dt.date, dt.date] | None = None
    bars_written: int = 0
    bars_replaced: int = 0
    messages: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "instrument_id": convert.maybe_pk(self.instrument_id),
            "label": self.label,
            "role": self.role,
            "need_from": self.need_from.isoformat(),
            "status": self.status,
            "head": None
            if self.head is None
            else [self.head[0].isoformat(), self.head[1].isoformat()],
            "bars_written": self.bars_written,
            "bars_replaced": self.bars_replaced,
            "messages": self.messages,
        }


@dataclass
class BenchmarkResult:
    profile: str
    proxy: str
    status: str
    """``found``, ``added``, ``not_found`` or ``error``."""
    instrument_id: int | None = None
    message: str | None = None

    def to_dict(self) -> dict:
        return {
            "profile": self.profile,
            "proxy": self.proxy,
            "status": self.status,
            "instrument_id": self.instrument_id,
            "message": self.message,
        }


@dataclass
class BackfillReport:
    as_of: dt.date
    profiles: list[str] = field(default_factory=list)
    instruments: list[InstrumentResult] = field(default_factory=list)
    benchmarks: list[BenchmarkResult] = field(default_factory=list)
    fx: list[dict] = field(default_factory=list)
    rates_written: int = 0
    started_at: dt.datetime | None = None
    finished_at: dt.datetime | None = None

    def to_dict(self) -> dict:
        return {
            "as_of": self.as_of.isoformat(),
            "profiles": self.profiles,
            "instruments": [i.to_dict() for i in self.instruments],
            "benchmarks": [b.to_dict() for b in self.benchmarks],
            "fx": self.fx,
            "rates_written": self.rates_written,
            "started_at": None if self.started_at is None else self.started_at.isoformat(),
            "finished_at": None if self.finished_at is None else self.finished_at.isoformat(),
        }


@dataclass
class _Plan:
    """What the read phase found, for all checked profiles together."""

    instruments: dict[InstrumentId, Instrument] = field(default_factory=dict)
    need_from: dict[InstrumentId, dt.date] = field(default_factory=dict)
    roles: dict[InstrumentId, str] = field(default_factory=dict)
    split_dates: dict[InstrumentId, dt.date] = field(default_factory=dict)
    currencies: dict[Currency, dt.date] = field(default_factory=dict)
    proxies: list[tuple[str, str, dt.date, Currency]] = field(default_factory=list)
    """(profile slug, proxy, need from, currency guess) of proxies with no stored instrument."""


def _earliest(target: dict, key, value: dt.date) -> None:
    if key not in target or value < target[key]:
        target[key] = value


def _profiles(session: Session, profile_ids: Collection[int] | None) -> list[Profile]:
    if profile_ids is not None:
        rows = [session.get(Profile, pid) for pid in sorted(set(profile_ids))]
        return [p for p in rows if p is not None]
    enabled = set(
        session.exec(
            select(ProfileModule.profile_id).where(
                ProfileModule.module_id == MODULE_ID,
                ProfileModule.enabled == True,
            )
        ).all()
    )
    return [p for p in profiles.list_profiles(session) if p.id in enabled]


def _read(
    session: Session, checked: list[Profile], as_of: dt.date, report: BackfillReport
) -> _Plan:
    plan = _Plan()
    for profile in checked:
        report.profiles.append(profile.slug)
        txns = [t for t in transactions.transactions(session, profile.id) if t.trade_date <= as_of]
        if not txns:
            continue
        first = min(t.trade_date for t in txns)
        renames = transactions.renames(session, profile.id)
        snapshot = build_snapshot(convert.sid(profile.id), txns, as_of, renames=renames)
        held = {h.instrument_id for h in snapshot.holdings}
        needed: dict[InstrumentId, dt.date] = {}
        for t in txns:
            if t.instrument_id is not None:
                _earliest(needed, t.instrument_id, t.trade_date)
            if t.type == TxnType.SPLIT and t.instrument_id is not None:
                current = plan.split_dates.get(t.instrument_id)
                if current is None or t.trade_date > current:
                    plan.split_dates[t.instrument_id] = t.trade_date
            _earliest(plan.currencies, t.currency, first)
            _earliest(plan.currencies, t.cash_currency, first)
        for r in renames:
            if r.date <= as_of:
                _earliest(needed, r.new_instrument_id, r.date)
        loaded = instrument_store.load(
            session, [convert.pk(i) for i in needed], profile_id=profile.id
        )
        for pk, inst in loaded.items():
            iid = convert.sid(pk)
            # Profiles may see a shared instrument differently (one froze it): fetch it when any
            # profile's own view still needs market prices (like the daily check).
            known = plan.instruments.get(iid)
            if known is None or (inst.fetches_market_data and not known.fetches_market_data):
                plan.instruments[iid] = inst
            _earliest(plan.need_from, iid, needed[iid])
            _earliest(plan.currencies, inst.currency, needed[iid])
            role = "held" if iid in held else "sold"
            if plan.roles.get(iid) != "held":
                plan.roles[iid] = role
        st = strategy_files.load(session, profile)
        base = portfolio_service.base_currency(profile, st.config)
        _earliest(plan.currencies, base, first)
        bench = st.config.benchmark if st.config is not None else None
        if bench is None:
            continue
        proxy = find_proxy(session, bench.proxy)
        if proxy is None:
            plan.proxies.append((profile.slug, bench.proxy, first, bench.currency))
            continue
        report.benchmarks.append(
            BenchmarkResult(profile.slug, bench.proxy, "found", convert.maybe_pk(proxy.id))
        )
        plan.instruments.setdefault(proxy.id, proxy)
        _earliest(plan.need_from, proxy.id, first)
        plan.roles.setdefault(proxy.id, "benchmark")
        _earliest(plan.currencies, proxy.currency, first)
    return plan


def _mismatch(error: BaseException | None) -> QuoteCurrencyMismatchException | None:
    seen = 0
    while error is not None and seen < 5:
        if isinstance(error, QuoteCurrencyMismatchException):
            return error
        error = getattr(error, "cause", None) or error.__cause__
        seen += 1
    return None


def _probe_proxy(
    prices: PriceSource, proxy: str, guess: Currency, as_of: dt.date
) -> tuple[Instrument | None, str | None]:
    """A planned instrument for a Yahoo-symbol proxy whose quote currency the source confirmed."""
    symbol = proxy.strip()
    planned = Instrument(
        id="0",
        name=symbol,
        currency=guess,
        asset_class=AssetClass.ETF,
        symbol=symbol.split(".")[0].upper(),
        aliases=(InstrumentAlias(AliasNamespace.YAHOO, symbol),),
    )
    start = as_of - dt.timedelta(days=PROBE_DAYS)
    for _attempt in range(2):
        try:
            answer = prices.fetch(planned, start, as_of)
        except SourceException as error:
            mismatch = _mismatch(error)
            if mismatch is not None and mismatch.quote_currency != planned.currency:
                planned = replace(planned, currency=mismatch.quote_currency)
                continue
            return None, f"{error.source_id}: {error.message}"
        if not answer.bars:
            return None, f"no prices for {symbol} in the last {PROBE_DAYS} days"
        if answer.currency is not None and answer.currency != planned.currency:
            planned = replace(planned, currency=answer.currency)
        return planned, None
    return None, f"could not settle the quote currency of {symbol}"


def run_backfill(
    *,
    profile_ids: Collection[int] | None = None,
    as_of: dt.date | None = None,
    sources: daily.MarketSources | Callable[[], daily.MarketSources] | None = None,
    session_factory: SessionFactory = get_session,
    clock: Callable[[], dt.datetime] = utcnow,
    lock_wait: float = 0.0,
) -> BackfillReport:
    """Backfill ``profile_ids`` (default: every profile with investments enabled). Raises
    :class:`BackfillBusy` while another backfill runs."""
    try:
        with locks.run_lock(LOCK_NAME, wait=lock_wait):
            return _run(profile_ids, as_of, sources, session_factory, clock)
    except locks.LockBusy as e:
        raise BackfillBusy(str(e)) from None


def _unpack(sources) -> daily.MarketSources:
    if sources is None:
        sources = daily.default_sources
    if callable(sources) and not isinstance(sources, daily.MarketSources):
        sources = sources()
    return sources


def _run(profile_ids, as_of, sources, session_factory, clock) -> BackfillReport:
    as_of = as_of or portfolio_service.today()
    report = BackfillReport(as_of=as_of, started_at=convert.aware(clock()))
    with session_factory() as s:
        plan = _read(s, _profiles(s, profile_ids), as_of, report)
    if not plan.instruments and not plan.proxies and not plan.currencies:
        report.finished_at = convert.aware(clock())
        return report

    active = _unpack(sources)
    try:
        _resolve_proxies(plan, active.prices, as_of, report, session_factory)
        stored = market.DbStoredMarketData(session_factory)
        refresher = MarketDataRefresher(active.prices, active.fx)
        for iid, instrument in plan.instruments.items():
            result = InstrumentResult(
                iid,
                instrument.label,
                plan.roles.get(iid, "sold"),
                plan.need_from[iid] - dt.timedelta(days=HEAD_MARGIN_DAYS),
            )
            report.instruments.append(result)
            _backfill_instrument(
                instrument,
                result,
                plan,
                stored,
                refresher,
                active.prices,
                as_of,
                clock,
                session_factory,
            )
        fx_report = refresher.refresh(
            stored,
            [],
            sorted(plan.currencies),
            as_of,
            fx_history_from={
                c: d - dt.timedelta(days=HEAD_MARGIN_DAYS) for c, d in plan.currencies.items()
            },
        )
        with session_factory() as s:
            stats = market.apply_fetch_report(s, fx_report, now=convert.aware(clock()))
        report.rates_written = stats["rates_written"]
        report.fx = [
            {
                "currency": str(f.currency),
                "status": f.status.value,
                "start": None if f.start is None else f.start.isoformat(),
                "rates": f.rate_count,
                "message": f.message,
            }
            for f in fx_report.fx
        ]
    finally:
        active.close()
    report.finished_at = convert.aware(clock())
    return report


def _resolve_proxies(
    plan: _Plan,
    prices: PriceSource,
    as_of: dt.date,
    report: BackfillReport,
    session_factory: SessionFactory,
) -> None:
    probed: dict[str, tuple[Instrument | None, str | None]] = {}
    for slug, proxy, first, guess in plan.proxies:
        if is_isin(proxy):
            report.benchmarks.append(
                BenchmarkResult(
                    slug,
                    proxy,
                    "not_found",
                    message="an ISIN proxy must be an instrument already stored (import or add "
                    "it); a Yahoo symbol is added automatically",
                )
            )
            continue
        key = proxy.strip().upper()  # Yahoo symbols are case-insensitive, stored upper-case
        if key not in probed:
            probed[key] = _probe_proxy(prices, key, guess, as_of)
        planned, error = probed[key]
        if planned is None:
            report.benchmarks.append(BenchmarkResult(slug, proxy, "error", message=error))
            continue
        with session_factory() as s:
            existing = find_proxy(s, key)
            if existing is None:
                row = instrument_store.insert(s, planned)
                stored = instrument_store.load_one(s, row.id)
                status = "added"
            else:
                stored, status = existing, "found"
        assert stored is not None
        report.benchmarks.append(BenchmarkResult(slug, proxy, status, convert.maybe_pk(stored.id)))
        plan.instruments.setdefault(stored.id, stored)
        _earliest(plan.need_from, stored.id, first)
        plan.roles.setdefault(stored.id, "benchmark")
        _earliest(plan.currencies, stored.currency, first)


def _backfill_instrument(
    instrument: Instrument,
    result: InstrumentResult,
    plan: _Plan,
    stored: market.DbStoredMarketData,
    refresher: MarketDataRefresher,
    prices: PriceSource,
    as_of: dt.date,
    clock: Callable[[], dt.datetime],
    session_factory: SessionFactory,
) -> None:
    if not instrument.fetches_market_data:
        result.status = "skipped"
        result.messages.append(f"not fetched: instrument is {instrument.status.value}")
        return
    need_from = result.need_from
    first = stored.first_bar_date(instrument.id)
    head_end: dt.date | None = None
    if first is None:
        head_end = as_of
    elif (first - need_from).days > HEAD_TOLERANCE_DAYS:
        head_end = first - dt.timedelta(days=1)
    fresh_only = first is None
    if head_end is not None and need_from <= head_end:
        result.head = (need_from, head_end)
        try:
            answer = prices.fetch(instrument, need_from, head_end)
            bars = [
                b
                for b in answer.bars
                if b.instrument_id == instrument.id and need_from <= b.date <= head_end
            ]
        except SourceException as error:
            result.status = "error"
            result.messages.append(
                f"history {need_from}..{head_end}: {error.source_id}: {error.message}"
            )
            bars = []
            fresh_only = False
        except Exception as error:  # noqa: BLE001 - one broken instrument never aborts the backfill
            _log.exception("backfill %s failed", instrument.id)
            result.status = "error"
            result.messages.append(f"history {need_from}..{head_end}: {type(error).__name__}")
            bars = []
            fresh_only = False
        if bars:
            with session_factory() as s:
                result.bars_written += market.upsert_bars(s, bars, now=convert.aware(clock()))
        elif result.status != "error":
            result.messages.append(f"no bars for {need_from}..{head_end}")
            if first is None:
                result.status = "no_data"
                fresh_only = False
    if fresh_only and result.bars_written:
        return  # the whole history was fetched just now: nothing to refresh or re-adjust
    split = plan.split_dates.get(instrument.id)
    tail = refresher.refresh(
        stored, [instrument], [], as_of, split_dates={instrument.id: split} if split else None
    )
    with session_factory() as s:
        stats = market.apply_fetch_report(s, tail, now=convert.aware(clock()))
    result.bars_written += stats["bars_written"]
    result.bars_replaced += stats["bars_replaced"]
    for item in tail.instruments:
        if item.message:
            result.messages.append(item.message)
        if item.status == FetchStatus.ERROR:
            result.status = "error"
        elif item.status == FetchStatus.NO_DATA and result.status == "ok" and first is None:
            result.status = "no_data"
