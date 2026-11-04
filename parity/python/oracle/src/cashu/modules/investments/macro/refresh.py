"""Macro series refresh (P6): fetch the whole window of every reference series over a chart source
(Yahoo ``chart(symbol, start, end)``) and return the closes to store in a :class:`MacroReport`. No
database access here: the caller writes the report in its own short transaction afterwards
(``store.macro``), so no transaction is ever open while this waits for the network.

Window: ``as_of - BACKFILL_DAYS .. as_of`` for every series on every run (7 requests), so restated
adjusted closes (a new ETF payout rescales Yahoo's whole ``adjclose`` history) and late corrections
replace the stored ones. ETFs (``MacroSeries.adjusted``) store the adjusted close; indices and yields
the raw close.

Failures: every failure is an entry in the report (status ``error``), never an exception. Circuit
breaker: after a blocked source or a retryable failure (timeout, transport error, 429, 5xx) the
remaining series are not asked (one ``skipped`` entry names them), so a hanging or blocking source
costs one request's retries, not seven.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

from ..market import FetchStatus, SourceBlockedException, SourceException
from .series import BACKFILL_DAYS, SERIES, MacroSeries

_log = logging.getLogger("cashu.investments.macro")

SKIPPED_MESSAGE = "not asked: the source failed earlier in this run"
TIMEOUT_SECONDS = 10.0
"""Per attempt timeout of a macro request (production ``MarketHttp`` of the macro source)."""
MAX_RETRIES = 1
"""Retries of a macro request after the first attempt."""


class MacroChartSource(Protocol):
    """A chart source by public symbol (``YahooPriceSource`` satisfies it; tests pass fakes)."""

    def chart(self, symbol: str, start: dt.date, end: dt.date, *, instrument_id: str = ...) -> Any:
        """A ``market.ChartQuote`` (``.bars`` with ``.date`` / ``.close`` / ``.source`` and
        ``.adjusted`` are read)."""
        ...


@dataclass(frozen=True, slots=True)
class MacroFetch:
    """The refresh outcome of one series (or, for ``skipped``, of the series not asked: their keys
    joined by ``", "``), with the closes to upsert by (series, date)."""

    series: str
    symbol: str
    status: FetchStatus
    start: dt.date | None = None
    end: dt.date | None = None
    closes: tuple[tuple[dt.date, Decimal], ...] = ()
    source: str | None = None
    message: str | None = None
    adjusted: bool = False
    """``closes`` are distribution-adjusted (older stored bars are rescaled to match on write)."""

    @property
    def keys(self) -> list[str]:
        return self.series.split(", ")

    def to_json(self) -> dict[str, object]:
        return {
            "series": self.series,
            "symbol": self.symbol,
            "status": self.status.value,
            "from": None if self.start is None else self.start.isoformat(),
            "to": None if self.end is None else self.end.isoformat(),
            "bar_count": len(self.closes),
            "source": self.source,
            "message": self.message,
            "adjusted": self.adjusted,
        }


@dataclass(frozen=True, slots=True)
class MacroReport:
    as_of: dt.date
    series: tuple[MacroFetch, ...] = ()

    @property
    def error_messages(self) -> list[str]:
        return [
            f"macro {f.series} ({f.symbol}): {f.message}"
            for f in self.series
            if f.status == FetchStatus.ERROR
        ]

    def to_stats(self) -> dict[str, int]:
        def count(status: FetchStatus) -> int:
            return sum(len(f.keys) for f in self.series if f.status == status)

        return {
            "series_ok": count(FetchStatus.OK),
            "series_no_data": count(FetchStatus.NO_DATA),
            "series_error": count(FetchStatus.ERROR),
            "series_skipped": count(FetchStatus.SKIPPED),
            "bars_fetched": sum(len(f.closes) for f in self.series),
        }


def window_start(as_of: dt.date) -> dt.date:
    """The first date every refresh fetches."""
    return as_of - dt.timedelta(days=BACKFILL_DAYS)


def refresh_macro(
    source: MacroChartSource,
    as_of: dt.date,
    *,
    series: Sequence[MacroSeries] = SERIES,
    workers: int = 1,
) -> MacroReport:
    """Fetches every series' window (see the module doc) and returns the closes to store.
    ``workers`` > 1 fetches that many series at once (P10; the source's ``MarketHttp`` still paces
    the host); the circuit breaker then skips every series not started yet."""
    start = window_start(as_of)
    out: list[MacroFetch] = []
    skipped: list[MacroSeries] = []
    if workers > 1 and len(series) > 1:
        from concurrent.futures import ThreadPoolExecutor

        state = {"broken": False}
        guard = threading.Lock()

        def job(item: MacroSeries) -> MacroFetch | None:
            with guard:
                if state["broken"]:
                    return None
            fetched, broke = _one(source, item, start, as_of)
            if broke:
                with guard:
                    state["broken"] = True
            return fetched

        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="macro") as pool:
            results = list(pool.map(job, series))
        for item, fetched in zip(series, results, strict=True):
            if fetched is None:
                skipped.append(item)
            else:
                out.append(fetched)
        series = ()
    broken = False
    for item in series:
        if broken:
            skipped.append(item)
            continue
        fetched, broken = _one(source, item, start, as_of)
        out.append(fetched)
    if skipped:
        out.append(
            MacroFetch(
                series=", ".join(s.key for s in skipped),
                symbol=", ".join(s.symbol for s in skipped),
                status=FetchStatus.SKIPPED,
                start=start,
                end=as_of,
                message=SKIPPED_MESSAGE,
            )
        )
    return MacroReport(as_of=as_of, series=tuple(out))


def _window(points, start: dt.date, end: dt.date) -> tuple[tuple[dt.date, Decimal], ...]:
    return tuple(sorted({day: Decimal(str(v)) for day, v in points if start <= day <= end}.items()))


def _one(
    source: MacroChartSource, item: MacroSeries, start: dt.date, as_of: dt.date
) -> tuple[MacroFetch, bool]:
    """The fetch of one series and whether the circuit breaker trips."""
    base = {"series": item.key, "symbol": item.symbol, "start": start, "end": as_of}
    try:
        quote = source.chart(item.symbol, start, as_of, instrument_id=f"macro:{item.key}")
        raw = _window(((b.date, b.close) for b in quote.bars), start, as_of)
        adjusted = (
            _window(getattr(quote, "adjusted", ()) or (), start, as_of) if item.adjusted else ()
        )
    except SourceException as error:
        _log.warning("macro %s (%s) failed: %s", item.key, item.symbol, error)
        breaks = isinstance(error, SourceBlockedException) or error.retryable
        message = f"{error.source_id}: {error.message}"
        return MacroFetch(**base, status=FetchStatus.ERROR, message=message), breaks
    except Exception as error:  # noqa: BLE001 - one broken series never aborts the refresh
        _log.exception("macro %s (%s) failed unexpectedly", item.key, item.symbol)
        message = f"{type(error).__name__}: {error}"
        return MacroFetch(**base, status=FetchStatus.ERROR, message=message), False
    if not raw and not adjusted:
        message = f"no bars for {start}..{as_of}"
        return MacroFetch(**base, status=FetchStatus.NO_DATA, message=message), False
    sources = ", ".join(dict.fromkeys(bar.source for bar in quote.bars if bar.source)) or "yahoo"
    if item.adjusted and adjusted:
        fetched = MacroFetch(
            **base, status=FetchStatus.OK, closes=adjusted, source=sources, adjusted=True
        )
    elif item.adjusted:
        # no adjclose in the answer: the raw close, rescaled against the stored bars on write
        fetched = MacroFetch(
            **base,
            status=FetchStatus.OK,
            closes=raw,
            source=sources,
            adjusted=True,
            message="no adjusted close in the answer: raw close stored",
        )
    else:
        fetched = MacroFetch(**base, status=FetchStatus.OK, closes=raw, source=sources)
    return fetched, False
