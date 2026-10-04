"""Market data: daily price bars and FX rates."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from .values import CalendarDate, Currency, InstrumentId


@dataclass(frozen=True, slots=True)
class PriceBar:
    """One daily bar of an instrument, prices in the instrument's currency. Key: (instrument, date)."""

    instrument_id: InstrumentId
    date: CalendarDate
    """Exchange calendar date of the session."""
    close: Decimal
    source: str
    """Id of the price source that delivered the bar (``stooq``, ``yahoo``)."""
    fetched_at: datetime | None = None
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    volume: int | None = None
    currency: Currency | None = None
    """Quote currency the source reported after minor-unit normalization (always the instrument
    currency: mismatches are rejected), None when the source reports none (stooq)."""


@dataclass(frozen=True, slots=True)
class FxRate:
    """A daily FX rate: ``rate`` units of ``base`` per 1 unit of ``quote`` (NBP table A: PLN per 1 USD).

    Key: (base, quote, date).
    """

    quote: Currency
    date: CalendarDate
    """Effective date of the rate (NBP table date)."""
    rate: Decimal
    source: str
    fetched_at: datetime | None = None
    base: Currency = Currency.PLN
