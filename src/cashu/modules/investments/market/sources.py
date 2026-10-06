"""Market data source contracts: price and FX sources, their answers and their errors."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, runtime_checkable

from ..domain import CalendarDate, Currency, FxRate, Instrument, PriceBar

# --- errors -------------------------------------------------------------------------------------


class SourceException(Exception):
    """A market data source failed (HTTP error, timeout, unexpected format, "no such symbol")."""

    def __init__(
        self,
        source_id: str,
        message: str,
        *,
        retryable: bool = False,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.source_id = source_id
        self.message = message
        self.retryable = retryable
        """True for transient failures (429, 5xx, network errors) a later run may not hit."""
        self.cause = cause

    def __str__(self) -> str:
        flag = ", retryable" if self.retryable else ""
        return f"{type(self).__name__}({self.source_id}{flag}): {self.message}"


class SourceBlockedException(SourceException):
    """The source refused to serve this client: a bot-protection page, a daily request limit, an API
    key demand, HTTP 401/403, or rate limiting (429) that persisted through every retry.

    Not specific to one instrument, so ``CompositePriceSource`` stops asking the source for the rest of
    its lifetime (one run). We never try to get around a bot check.
    """


class QuoteCurrencyMismatchException(SourceException):
    """The source quotes the instrument in another currency than ``Instrument.currency`` (after
    minor-unit normalization, e.g. GBp -> GBP): its bars would be valued wrongly, so none are returned.
    Not retryable (R3)."""

    def __init__(
        self,
        source_id: str,
        message: str,
        *,
        quote_currency: Currency,
        instrument_currency: Currency,
    ) -> None:
        super().__init__(source_id, message)
        self.quote_currency = quote_currency
        self.instrument_currency = instrument_currency


class NoPriceSourceException(SourceException):
    """No configured source can price the instrument (no alias in any source's namespace, e.g. a
    treasury bond). A configuration gap, not a transport failure."""


# --- answers ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SplitEvent:
    """A stock split reported by a price source: ``ratio`` new units per old unit (4:1 is 4),
    effective on ``date`` (exchange calendar date)."""

    date: CalendarDate
    ratio: Decimal


@dataclass(frozen=True, slots=True)
class PriceHistory:
    """Everything a price source answered for one request."""

    bars: tuple[PriceBar, ...] = ()
    """Bars dated within the requested range, oldest first, prices in ``currency``."""
    splits: tuple[SplitEvent, ...] = ()
    """Splits the source reported within the range. A source that reports splits serves split-adjusted
    closes, so bars stored before a split are stale (R6)."""
    currency: Currency | None = None
    """Quote currency after minor-unit normalization, already checked against the instrument currency;
    None when the source reports none."""


# --- source contracts ---------------------------------------------------------------------------


class PriceSource(ABC):
    """Daily price history of instruments (stooq, yahoo, composite)."""

    @property
    @abstractmethod
    def id(self) -> str:
        """Stable id, stored as ``PriceBar.source`` (``stooq``, ``yahoo``)."""

    @abstractmethod
    def history(
        self, instrument: Instrument, start: CalendarDate, end: CalendarDate
    ) -> list[PriceBar]:
        """Daily bars with ``start <= date <= end``, oldest first. The source picks its symbol from
        ``instrument.alias(...)``. No data in the range is an empty list; transport or format failures
        raise :class:`SourceException`. Prices are in the instrument currency: a source that learns the
        quote currency rejects a mismatch with :class:`QuoteCurrencyMismatchException`."""

    def fetch(self, instrument: Instrument, start: CalendarDate, end: CalendarDate) -> PriceHistory:
        """:meth:`history` plus split events and the quote currency. The default wraps
        :meth:`history` (no splits, currency unknown); sources that know more override it."""
        return PriceHistory(bars=tuple(self.history(instrument, start, end)))


@runtime_checkable
class FxSource(Protocol):
    """Daily FX rates against PLN (NBP table A mid rates)."""

    @property
    def id(self) -> str:
        """Stable id, stored as ``FxRate.source`` (``nbp``)."""
        ...

    def rates(self, quote: Currency, start: CalendarDate, end: CalendarDate) -> list[FxRate]:
        """Rates of ``quote`` with ``start <= date <= end``, oldest first: PLN per 1 unit of ``quote``
        (``FxRate.base`` is PLN). Days without a published rate are absent. Failures raise
        :class:`SourceException`."""
        ...
