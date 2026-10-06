"""Price bars and FX rates (shared reference data): the DB-backed ``StoredMarketData``, applying a
``FetchReport``, and the in-memory views valuation needs (``MarketView``, ``InMemoryFxLookup``).

Transactions: ``DbStoredMarketData`` opens one short read session per query, so the refresher never
holds a database transaction while it waits for the network. ``apply_fetch_report`` runs inside the
caller's (single, short) write transaction; a split re-fetch deletes the stored window and inserts
the new bars in that same transaction.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Collection, Iterable, Mapping
from contextlib import AbstractContextManager

from sqlalchemy import delete, func, or_
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, select

from cashu.core.db import get_session

from ..domain import (
    CalendarDate,
    Currency,
    FxRate,
    Instrument,
    InstrumentId,
    ManualValuation,
    MarketView,
    PortfolioSnapshot,
    PriceBar,
)
from ..market import FetchReport
from ..models import InvFxRate, InvPriceBar
from ..portfolio import InMemoryFxLookup, fx_currencies_for
from . import convert

SessionFactory = Callable[[], AbstractContextManager[Session]]
FX_BASE = Currency.PLN  # NBP rates: PLN per 1 unit of the quote currency
_CHUNK = 200


class DbStoredMarketData:
    """:class:`~..market.StoredMarketData` over the tables, one short session per question."""

    def __init__(self, session_factory: SessionFactory = get_session) -> None:
        self._factory = session_factory

    def _first(self, statement):
        with self._factory() as s:
            return s.exec(statement).first()

    def last_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None:
        return self._first(
            select(func.max(InvPriceBar.date)).where(
                InvPriceBar.instrument_id == convert.pk(instrument_id)
            )
        )

    def first_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None:
        return self._first(
            select(func.min(InvPriceBar.date)).where(
                InvPriceBar.instrument_id == convert.pk(instrument_id)
            )
        )

    def has_bars_fetched_before(
        self,
        instrument_id: InstrumentId,
        *,
        dated_before: CalendarDate,
        fetched_before: dt.datetime,
    ) -> bool:
        found = self._first(
            select(InvPriceBar.id)
            .where(
                InvPriceBar.instrument_id == convert.pk(instrument_id),
                InvPriceBar.date < dated_before,
                or_(
                    InvPriceBar.fetched_at.is_(None),
                    InvPriceBar.fetched_at < convert.aware(fetched_before),
                ),
            )
            .limit(1)
        )
        return found is not None

    def last_rate_date(self, quote: Currency) -> CalendarDate | None:
        return self._first(
            select(func.max(InvFxRate.date)).where(
                InvFxRate.base == FX_BASE, InvFxRate.quote == str(quote)
            )
        )

    def first_rate_date(self, quote: Currency) -> CalendarDate | None:
        return self._first(
            select(func.min(InvFxRate.date)).where(
                InvFxRate.base == FX_BASE, InvFxRate.quote == str(quote)
            )
        )

    def has_rate_on_or_before(self, quote: Currency, on: CalendarDate) -> bool:
        found = self._first(
            select(InvFxRate.id)
            .where(InvFxRate.base == FX_BASE, InvFxRate.quote == str(quote), InvFxRate.date <= on)
            .limit(1)
        )
        return found is not None


def apply_fetch_report(
    session: Session, report: FetchReport, *, now: dt.datetime
) -> dict[str, int]:
    """Store a refresh's bars and rates in the caller's transaction: replace the window
    ``replace_from..end`` for a split re-fetch, upsert by key otherwise. Returns counts."""
    stats = {"bars_written": 0, "bars_replaced": 0, "rates_written": 0}
    for item in report.instruments:
        if not item.bars and item.replace_from is None:
            continue
        instrument_id = convert.pk(item.instrument_id)
        if item.replace_from is not None:
            if not item.bars:
                continue  # never wipe a window without replacement bars
            end = item.end or report.as_of
            result = session.exec(
                delete(InvPriceBar).where(
                    InvPriceBar.instrument_id == instrument_id,
                    InvPriceBar.date >= item.replace_from,
                    InvPriceBar.date <= end,
                )
            )
            stats["bars_replaced"] += result.rowcount or 0
        stats["bars_written"] += upsert_bars(session, item.bars, now=now)
    for fx in report.fx:
        stats["rates_written"] += upsert_rates(session, fx.rates, now=now)
    return stats


def upsert_bars(session: Session, bars: Iterable[PriceBar], *, now: dt.datetime) -> int:
    rows = [
        {
            "instrument_id": convert.pk(b.instrument_id),
            "date": b.date,
            "close": b.close,
            "open": b.open,
            "high": b.high,
            "low": b.low,
            "volume": b.volume,
            "currency": None if b.currency is None else str(b.currency),
            "source": b.source,
            # Stored now if the source gave no time: the split check needs to know.
            "fetched_at": convert.aware(b.fetched_at or now),
        }
        for b in bars
    ]
    table = InvPriceBar.__table__
    for start in range(0, len(rows), _CHUNK):
        statement = sqlite_insert(table).values(rows[start : start + _CHUNK])
        statement = statement.on_conflict_do_update(
            index_elements=["instrument_id", "date"],
            set_={
                c: statement.excluded[c]
                for c in (
                    "close",
                    "open",
                    "high",
                    "low",
                    "volume",
                    "currency",
                    "source",
                    "fetched_at",
                )
            },
        )
        session.exec(statement)
    return len(rows)


def upsert_rates(session: Session, rates: Iterable[FxRate], *, now: dt.datetime) -> int:
    rows = [
        {
            "base": str(r.base),
            "quote": str(r.quote),
            "date": r.date,
            "rate": r.rate,
            "source": r.source,
            "fetched_at": convert.aware(r.fetched_at or now),
        }
        for r in rates
    ]
    table = InvFxRate.__table__
    for start in range(0, len(rows), _CHUNK):
        statement = sqlite_insert(table).values(rows[start : start + _CHUNK])
        statement = statement.on_conflict_do_update(
            index_elements=["base", "quote", "date"],
            set_={c: statement.excluded[c] for c in ("rate", "source", "fetched_at")},
        )
        session.exec(statement)
    return len(rows)


# --------------------------------------------------------------------------- #
# Reads for valuation
# --------------------------------------------------------------------------- #


def bars(
    session: Session,
    instrument_ids: Collection[int],
    *,
    until: CalendarDate,
    since: CalendarDate | None = None,
) -> dict[InstrumentId, tuple[PriceBar, ...]]:
    """Bars per instrument dated ``since..until`` (all history when ``since`` is None), oldest first."""
    ids = sorted(set(instrument_ids))
    if not ids:
        return {}
    query = select(InvPriceBar).where(InvPriceBar.instrument_id.in_(ids), InvPriceBar.date <= until)
    if since is not None:
        query = query.where(InvPriceBar.date >= since)
    out: dict[InstrumentId, list[PriceBar]] = {}
    for row in session.exec(query.order_by(InvPriceBar.instrument_id, InvPriceBar.date)).all():
        out.setdefault(convert.sid(row.instrument_id), []).append(convert.price_bar(row))
    return {k: tuple(v) for k, v in out.items()}


def last_bar_dates(session: Session, instrument_ids: Collection[int]) -> dict[int, CalendarDate]:
    ids = sorted(set(instrument_ids))
    if not ids:
        return {}
    rows = session.exec(
        select(InvPriceBar.instrument_id, func.max(InvPriceBar.date))
        .where(InvPriceBar.instrument_id.in_(ids))
        .group_by(InvPriceBar.instrument_id)
    ).all()
    return {i: d for i, d in rows}


def rates(
    session: Session,
    currencies: Iterable[Currency | str],
    *,
    until: CalendarDate,
    since: CalendarDate | None = None,
) -> list[FxRate]:
    """PLN rates of ``currencies`` dated ``since..until`` plus the newest one before ``since`` (so a
    weekend or holiday at the start still finds its rate)."""
    out: list[FxRate] = []
    for code in sorted({str(c) for c in currencies} - {str(FX_BASE)}):
        query = select(InvFxRate).where(
            InvFxRate.base == FX_BASE, InvFxRate.quote == code, InvFxRate.date <= until
        )
        if since is not None:
            query = query.where(InvFxRate.date >= since)
            before = session.exec(
                select(InvFxRate)
                .where(InvFxRate.base == FX_BASE, InvFxRate.quote == code, InvFxRate.date < since)
                .order_by(InvFxRate.date.desc())
            ).first()
            if before is not None:
                out.append(convert.fx_rate(before))
        out.extend(convert.fx_rate(r) for r in session.exec(query.order_by(InvFxRate.date)).all())
    return out


def newest_rate_date(session: Session) -> CalendarDate | None:
    return session.exec(select(func.max(InvFxRate.date)).where(InvFxRate.base == FX_BASE)).first()


def market_view(
    session: Session,
    as_of: CalendarDate,
    instruments: Mapping[InstrumentId, Instrument],
    manual_valuations: Iterable[ManualValuation] = (),
    *,
    history_days: int | None = 800,
) -> MarketView:
    """A :class:`MarketView` with the stored bars of ``instruments`` up to ``as_of`` (the last
    ``history_days`` days; all history when None) and the given manual valuations."""
    since = None if history_days is None else as_of - dt.timedelta(days=history_days)
    series = bars(session, [convert.pk(i) for i in instruments], until=as_of, since=since)
    valuations: dict[InstrumentId, list[ManualValuation]] = {}
    for valuation in manual_valuations:
        if valuation.instrument_id in instruments:
            valuations.setdefault(valuation.instrument_id, []).append(valuation)
    return MarketView(
        as_of=as_of,
        instruments=dict(instruments),
        bars=series,
        manual_valuations={
            k: tuple(sorted(v, key=lambda m: m.as_of)) for k, v in valuations.items()
        },
    )


def fx_lookup(
    session: Session, snapshot: PortfolioSnapshot, market: MarketView, base: Currency
) -> InMemoryFxLookup:
    """Every rate ``value_portfolio`` may ask for (``fx_currencies_for``), preloaded."""
    currencies, oldest = fx_currencies_for(snapshot, market, base)
    return InMemoryFxLookup(rates(session, currencies, until=snapshot.as_of, since=oldest))
