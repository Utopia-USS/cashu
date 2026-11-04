"""Outcome of a market data refresh: per instrument and per currency, with the data to persist."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from ..domain import CalendarDate, Currency, FxRate, InstrumentId, PriceBar


class FetchStatus(StrEnum):
    """Outcome of refreshing one instrument or currency (value = wire name)."""

    OK = "ok"
    """Data was fetched, or the stored data was already up to date (no request made)."""
    NO_DATA = "no_data"
    """The source answered without data for the range, or no source can price the instrument."""
    SKIPPED = "skipped"
    """Not fetched on purpose: a delisted or frozen instrument (Stage 2 status)."""
    ERROR = "error"
    """The fetch failed (transport, blocked source, unexpected format, currency mismatch)."""


@dataclass(frozen=True, slots=True)
class InstrumentFetch:
    """Price refresh outcome of one instrument, including the bars to store.

    Persistence: when ``replace_from`` is set (a split made the refresher fetch the whole stored window
    again), delete the stored bars of the instrument dated ``replace_from..to`` and insert ``bars`` in
    one transaction; otherwise upsert ``bars`` by (instrument, date).
    """

    instrument_id: InstrumentId
    label: str
    """Symbol or name, for messages."""
    status: FetchStatus
    start: CalendarDate | None = None
    """Requested range start; None when no request was needed."""
    end: CalendarDate | None = None
    bars: tuple[PriceBar, ...] = ()
    source: str | None = None
    """Source(s) that delivered the bars (``stooq``, ``yahoo``), None without bars."""
    message: str | None = None
    currency: Currency | None = None
    """Quote currency the source reported (= the instrument currency), None when it reports none."""
    refetched_for_split: bool = False
    replace_from: CalendarDate | None = None

    @property
    def bar_count(self) -> int:
        return len(self.bars)

    def to_json(self) -> dict[str, object]:
        return {
            "instrument_id": self.instrument_id,
            "label": self.label,
            "status": self.status.value,
            "from": None if self.start is None else self.start.isoformat(),
            "to": None if self.end is None else self.end.isoformat(),
            "bar_count": self.bar_count,
            "source": self.source,
            "message": self.message,
            "currency": self.currency,
            "refetched_for_split": self.refetched_for_split,
        }


@dataclass(frozen=True, slots=True)
class FxFetch:
    """FX refresh outcome of one quote currency (rates in PLN per 1 unit), with the rates to upsert."""

    currency: Currency
    status: FetchStatus
    start: CalendarDate | None = None
    end: CalendarDate | None = None
    rates: tuple[FxRate, ...] = ()
    source: str | None = None
    message: str | None = None

    @property
    def rate_count(self) -> int:
        return len(self.rates)

    def to_json(self) -> dict[str, object]:
        return {
            "currency": self.currency,
            "status": self.status.value,
            "from": None if self.start is None else self.start.isoformat(),
            "to": None if self.end is None else self.end.isoformat(),
            "rate_count": self.rate_count,
            "source": self.source,
            "message": self.message,
        }


@dataclass(frozen=True, slots=True)
class FetchReport:
    """Result of a refresh: one entry per instrument and per requested currency, in input order. A
    failure is an entry, never an exception."""

    as_of: CalendarDate
    instruments: tuple[InstrumentFetch, ...] = ()
    fx: tuple[FxFetch, ...] = ()

    @property
    def has_errors(self) -> bool:
        return any(i.status == FetchStatus.ERROR for i in self.instruments) or any(
            f.status == FetchStatus.ERROR for f in self.fx
        )

    @property
    def error_messages(self) -> list[str]:
        """One human-readable line per error (for the run log)."""
        return [
            f"prices {i.label} ({i.instrument_id}): {i.message}"
            for i in self.instruments
            if i.status == FetchStatus.ERROR
        ] + [f"fx {f.currency}: {f.message}" for f in self.fx if f.status == FetchStatus.ERROR]

    def to_stats(self) -> dict[str, int]:
        """Counts for the run log (JSON-encodable)."""

        def count(items, status: FetchStatus) -> int:
            return sum(1 for item in items if item.status == status)

        return {
            "instruments_ok": count(self.instruments, FetchStatus.OK),
            "instruments_no_data": count(self.instruments, FetchStatus.NO_DATA),
            "instruments_skipped": count(self.instruments, FetchStatus.SKIPPED),
            "instruments_error": count(self.instruments, FetchStatus.ERROR),
            "bars_fetched": sum(i.bar_count for i in self.instruments),
            "fx_ok": count(self.fx, FetchStatus.OK),
            "fx_no_data": count(self.fx, FetchStatus.NO_DATA),
            "fx_error": count(self.fx, FetchStatus.ERROR),
            "rates_fetched": sum(f.rate_count for f in self.fx),
        }
