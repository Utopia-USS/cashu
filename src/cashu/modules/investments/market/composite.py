"""Tries alias-based price sources per instrument in order, with fallback and attribution."""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from ..domain import AliasNamespace, CalendarDate, Instrument, PriceBar
from .market_http import MarketHttp
from .sources import (
    NoPriceSourceException,
    PriceHistory,
    PriceSource,
    QuoteCurrencyMismatchException,
    SourceBlockedException,
    SourceException,
)
from .stooq import StooqPriceSource
from .yahoo import UtcClock, YahooPriceSource, utc_now

PriceSourceOrder = Callable[[Instrument], Sequence[str]]
"""Source ids (= alias namespaces) to try for an instrument, most preferred first."""


def default_price_source_order(instrument: Instrument) -> Sequence[str]:
    """``stooq`` first for Warsaw listings (MIC ``XWAR``), ``yahoo`` first for everything else."""
    if (instrument.mic or "").upper() == "XWAR":
        return (AliasNamespace.STOOQ, AliasNamespace.YAHOO)
    return (AliasNamespace.YAHOO, AliasNamespace.STOOQ)


@dataclass(slots=True)
class SourceHealth:
    """Per-source counters of one :class:`CompositePriceSource` (one run)."""

    source_id: str
    attempts: int = 0
    with_data: int = 0
    empty: int = 0
    failures: int = 0
    blocked: bool = False
    """Set after a :class:`SourceBlockedException`; the source is skipped from then on."""
    last_error: str | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "attempts": self.attempts,
            "with_data": self.with_data,
            "empty": self.empty,
            "failures": self.failures,
            "blocked": self.blocked,
            "last_error": self.last_error,
        }


class CompositePriceSource(PriceSource):
    """Returns the first non-empty answer of the sources the instrument has an alias for, in
    ``order``. Every bar keeps the ``source`` of the source that delivered it (attribution).

    Outcome:

    - some source returned bars: that answer (with its splits and currency);
    - no bars, but at least one source answered empty: an empty answer ("no data in range"), unless a
      source reported a quote currency mismatch (a configuration error worth reporting, R3);
    - every candidate failed: one :class:`SourceException` naming each failure (retryable if any was);
    - no source can price the instrument: :class:`NoPriceSourceException`.

    A source that raises :class:`SourceBlockedException` is skipped for the rest of this instance's
    life, so create one composite per run. :attr:`health` keeps per-source counters for the report.
    """

    def __init__(
        self,
        sources: Sequence[PriceSource],
        *,
        order: PriceSourceOrder = default_price_source_order,
        logger: logging.Logger | None = None,
    ) -> None:
        self._sources = {source.id: source for source in sources}
        self._order = order
        self._log = logger or logging.getLogger("cashu.investments.market.composite")
        self._health: dict[str, SourceHealth] = {}

    @classmethod
    def standard(cls, http: MarketHttp, *, clock: UtcClock = utc_now) -> CompositePriceSource:
        """stooq + yahoo over one shared :class:`MarketHttp`, in the default order."""
        return cls([StooqPriceSource(http, clock=clock), YahooPriceSource(http, clock=clock)])

    @property
    def id(self) -> str:
        return "composite"

    @property
    def health(self) -> dict[str, SourceHealth]:
        """Counters per source id, for sources that were called or blocked in this run."""
        return dict(self._health)

    def history(
        self, instrument: Instrument, start: CalendarDate, end: CalendarDate
    ) -> list[PriceBar]:
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument: Instrument, start: CalendarDate, end: CalendarDate) -> PriceHistory:
        preferred = list(self._order(instrument))
        ordered = preferred + [s for s in self._sources if s not in preferred]
        candidates = [
            self._sources[source_id]
            for source_id in ordered
            if source_id in self._sources and instrument.alias(source_id) is not None
        ]
        if not candidates:
            raise NoPriceSourceException(
                self.id,
                f"no price source for this instrument (no {' / '.join(self._sources)} alias)",
            )

        failures: list[SourceException] = []
        answered_empty = False
        for source in candidates:
            health = self._health.setdefault(source.id, SourceHealth(source.id))
            if health.blocked:
                failures.append(
                    SourceException(
                        source.id,
                        f"skipped, blocked earlier in this run ({health.last_error})",
                        retryable=True,
                    )
                )
                continue
            health.attempts += 1
            try:
                answer = source.fetch(instrument, start, end)
            except SourceException as error:
                health.failures += 1
                health.last_error = error.message
                if isinstance(error, SourceBlockedException):
                    health.blocked = True
                failures.append(error)
                self._log.info("%s failed for %s: %s", source.id, instrument.id, error.message)
                continue
            except Exception as error:  # noqa: BLE001 - a parser bug must not hide the other sources
                health.failures += 1
                health.last_error = repr(error)
                failures.append(SourceException(source.id, repr(error), cause=error))
                self._log.warning("%s failed unexpectedly for %s", source.id, instrument.id)
                continue
            if answer.bars:
                health.with_data += 1
                return answer
            health.empty += 1
            answered_empty = True
            self._log.debug("%s: no bars for %s %s..%s", source.id, instrument.id, start, end)

        mismatch = any(isinstance(f, QuoteCurrencyMismatchException) for f in failures)
        if answered_empty and not mismatch:
            return PriceHistory()
        raise SourceException(
            self.id,
            "; ".join(f"{f.source_id}: {f.message}" for f in failures),
            retryable=any(f.retryable for f in failures),
            cause=failures[0] if failures else None,
        )
