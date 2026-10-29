"""The lightweight price refresh (P10): the latest quotes of a profile's held and watched instruments and
the NBP rates of their currencies, batched (Yahoo spark, one NBP table request; ``market.batched``), with
no rules, signals, alerts, macro series or performance backfill (that stays the daily check). The app
asks for it when it opens and every 15 minutes while it is visible (frontend ``priceRefresh.ts``).

- Throttle: a profile's refresh younger than :data:`THROTTLE` answers its stored result (``cached``)
  without any network.
- Lock: the refresh holds the daily check's lock (``investments-daily``) for its few seconds, so it never
  runs next to a daily check, a worker run or another refresh; a taken lock answers ``busy`` at once.
- Phases as in the daily check: one short read session, the network with no transaction open, one short
  write transaction (``store.market.apply_fetch_report``). A failure is a result, never an exception.
- ``CASHU_PRICE_REFRESH=0`` turns it off (status ``disabled``, no network).
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from cashu.core import locks, paths
from cashu.core.api import utc_iso
from cashu.core.db import get_session
from cashu.core.env import env
from cashu.core.models import Profile, utcnow

from ..domain import Currency
from ..market import (
    CompositePriceSource,
    FetchStatus,
    FxSource,
    MarketDataRefresher,
    MarketHttp,
    NbpFxSource,
    PriceSource,
    SourceException,
    StooqPriceSource,
    YahooPriceSource,
)
from ..market.batched import BatchedFxSource, BatchedPriceSource
from ..store import convert, market
from . import daily, portfolio

THROTTLE = dt.timedelta(minutes=10)
FX_WINDOW_DAYS = 31
"""Days of the one NBP table request (a currency whose last stored rate is older goes per currency)."""
SessionFactory = daily.SessionFactory
_log = logging.getLogger("cashu.investments.prices")


@dataclass
class PriceSources:
    """Sources of one refresh. ``yahoo`` / ``nbp`` enable the batches (None: everything goes through
    ``prices`` / ``fx``, the per-instrument and per-currency paths)."""

    prices: PriceSource
    fx: FxSource
    yahoo: YahooPriceSource | None = None
    nbp: NbpFxSource | None = None
    close: Callable[[], None] = lambda: None
    workers: int = 1


def default_sources() -> PriceSources:
    """Production: stooq + yahoo composite and NBP over one HTTP client, with the spark and table
    batches on the same Yahoo / NBP sources."""
    import httpx

    client = httpx.Client(follow_redirects=True)
    http = MarketHttp(client)
    yahoo = YahooPriceSource(http)
    nbp = NbpFxSource(http)
    return PriceSources(
        CompositePriceSource([StooqPriceSource(http), yahoo]), nbp, yahoo, nbp, client.close,
        workers=daily.WORKERS,
    )


class _Offline(PriceSource):
    """No remote source: every instrument and currency fails without a request."""

    @property
    def id(self) -> str:
        return "offline"

    def history(self, instrument, start, end):
        raise SourceException(self.id, "offline: no market source")

    def rates(self, quote, start, end):
        raise SourceException(self.id, "offline: no market source")


def offline_sources() -> PriceSources:
    """No network at all (the test suite's and the offline e2e server's ``default_sources``)."""
    offline = _Offline()
    return PriceSources(offline, offline)


@dataclass
class PriceRefresh:
    profile: str
    status: str
    """``ok`` | ``partial`` (some errors) | ``failed`` (nothing refreshed, errors) | ``busy`` (a daily
    check or another refresh holds the lock) | ``disabled`` (``CASHU_PRICE_REFRESH=0``)."""
    as_of: dt.date | None = None
    started_at: dt.datetime | None = None
    finished_at: dt.datetime | None = None
    updated: int = 0
    """Instruments with new or re-fetched bars."""
    skipped: int = 0
    """Instruments not refreshed without an error: up to date, no data, frozen / delisted."""
    fx_updated: int = 0
    errors: list[str] = field(default_factory=list)
    requests: dict = field(default_factory=dict)
    stored: dict = field(default_factory=dict)
    cached: bool = False

    def to_dict(self) -> dict:
        return {
            "profile": self.profile,
            "status": self.status,
            "as_of": None if self.as_of is None else self.as_of.isoformat(),
            "started_at": utc_iso(self.started_at),
            "finished_at": utc_iso(self.finished_at),
            "updated": self.updated,
            "skipped": self.skipped,
            "fx_updated": self.fx_updated,
            "errors": self.errors,
            "requests": self.requests,
            "stored": self.stored,
            "cached": self.cached,
        }


_last: dict[tuple[str, int], PriceRefresh] = {}
_guard = threading.Lock()


def enabled() -> bool:
    return (env("PRICE_REFRESH") or "1").strip().lower() not in ("0", "false", "off", "no")


def _cache_key(profile: Profile) -> tuple[str, int]:
    return str(paths.data_dir()), profile.id  # one process may serve several data dirs (tests)


def last_result(profile: Profile) -> PriceRefresh | None:
    with _guard:
        return _last.get(_cache_key(profile))


def clear_cache() -> None:
    with _guard:
        _last.clear()


def refresh_prices(
    profile: Profile,
    *,
    sources: PriceSources | Callable[[], PriceSources] | None = None,
    as_of: dt.date | None = None,
    force: bool = False,
    throttle: dt.timedelta = THROTTLE,
    clock: Callable[[], dt.datetime] = utcnow,
    session_factory: SessionFactory = get_session,
) -> PriceRefresh:
    """Refresh the profile's quotes now, or answer the last result when it is younger than
    ``throttle`` (``force`` skips the throttle, never the lock)."""
    now = convert.aware(clock())
    if not enabled():
        return PriceRefresh(profile.slug, "disabled", finished_at=now)
    previous = last_result(profile)
    if (
        not force
        and previous is not None
        and previous.finished_at is not None
        and now - previous.finished_at < throttle
    ):
        return replace(previous, cached=True)
    try:
        with locks.run_lock(daily.LOCK_NAME):
            result = _run(profile, sources, as_of, clock, session_factory)
    except locks.LockBusy:
        return PriceRefresh(profile.slug, "busy", started_at=now, finished_at=now)
    with _guard:
        _last[_cache_key(profile)] = result
    _log.info(
        "price refresh %s: %s, %d updated, %d skipped, %d errors",
        profile.slug,
        result.status,
        result.updated,
        result.skipped,
        len(result.errors),
    )
    return result


def _unpack(sources) -> PriceSources:
    if sources is None:
        sources = default_sources
    if callable(sources) and not isinstance(sources, PriceSources):
        sources = sources()
    return sources


def _run(profile, sources, as_of, clock, session_factory) -> PriceRefresh:
    as_of = as_of or portfolio.today()
    result = PriceRefresh(profile.slug, "ok", as_of=as_of, started_at=convert.aware(clock()))
    try:
        # 1. Read phase (no strategy version is recorded here).
        with session_factory() as s:
            fresh = s.get(Profile, profile.id) or profile
            needs = daily.price_needs(s, fresh, as_of)
            wanted = dict(needs.watched)
            wanted.update(needs.instruments)  # the held view wins for a held + watched instrument
            last_closes = market.last_closes(s, [convert.pk(i) for i in wanted])
        currencies = sorted(c for c in needs.currencies if c != Currency.PLN)
        stored = market.DbStoredMarketData(session_factory)

        # 2. Network phase: no transaction is open.
        active = _unpack(sources)
        try:
            prices = BatchedPriceSource(active.yahoo, active.prices, last_closes=last_closes)
            prices.prefetch(wanted.values())
            fx = BatchedFxSource(active.nbp, active.fx)
            known = [d for d in (stored.last_rate_date(c) for c in currencies) if d is not None]
            if known:
                fx.prefetch(max(min(known), as_of - dt.timedelta(days=FX_WINDOW_DAYS - 1)), as_of)
            report = MarketDataRefresher(prices, fx, workers=active.workers).refresh(
                stored, wanted.values(), currencies, as_of, split_dates=needs.split_dates
            )
        finally:
            active.close()
        result.requests = {
            "spark": prices.requests,
            "batched": prices.batched,
            "per_instrument": prices.fallbacks,
            "fx_tables": fx.requests,
        }

        # 3. One short write transaction.
        with session_factory() as s:
            result.stored = market.apply_fetch_report(s, report, now=convert.aware(clock()))
    except Exception as e:  # noqa: BLE001 - offline or a broken source: a result, never a crash
        _log.warning("price refresh failed for %s: %s", profile.slug, e, exc_info=True)
        result.status = "failed"
        result.errors = [f"{type(e).__name__}: {e}"[:300]]
        result.finished_at = convert.aware(clock())
        return result

    for item in report.instruments:
        if item.status == FetchStatus.OK and item.bars:
            result.updated += 1
        elif item.status != FetchStatus.ERROR:
            result.skipped += 1
    result.fx_updated = sum(1 for f in report.fx if f.status == FetchStatus.OK and f.rates)
    result.errors = report.error_messages
    if result.errors:
        nothing = not (result.updated or result.fx_updated or result.skipped)
        result.status = "failed" if nothing else "partial"
    result.finished_at = convert.aware(clock())
    return result
