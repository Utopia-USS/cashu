"""FX lookup contract used by valuation and rules (implementation: ``portfolio.fx_lookup``)."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, runtime_checkable

from .values import CalendarDate, Currency, days_between

DEFAULT_MAX_FX_AGE_DAYS = 10
"""Default of the strategy's ``data.max_fx_age_days``: an FX rate older than this many calendar days
relative to the date it is needed for counts as missing (NBP publishes every business day)."""


@dataclass(frozen=True, slots=True)
class FxQuote:
    """An FX rate with the date it was published for. For an inverse rate the date is the stored rate's,
    for a cross rate the older of the two legs, for the identity rate the requested date."""

    rate: Decimal
    """Units of the base currency per 1 unit of the quote currency."""
    date: CalendarDate

    def age_days(self, needed_for: CalendarDate) -> int:
        """Calendar days between :attr:`date` and ``needed_for`` (0 when from that very day)."""
        return days_between(self.date, needed_for)


@runtime_checkable
class FxLookup(Protocol):
    """Daily FX rates as of a date (synchronous, so valuation stays a pure function)."""

    def quote_on_or_before(
        self, quote: Currency, on: CalendarDate, base: Currency = Currency.PLN
    ) -> FxQuote | None:
        """Units of ``base`` per 1 ``quote`` from the newest rate dated on/before ``on`` (exactly 1 when
        ``quote == base``), with the date of the rate used; None when unknown."""
        ...

    def rate_on_or_before(
        self, quote: Currency, on: CalendarDate, base: Currency = Currency.PLN
    ) -> Decimal | None:
        """The rate of :meth:`quote_on_or_before`, or None."""
        ...
