"""Batched quotes for the lightweight price refresh (P10, ``service.prices``): Yahoo's spark endpoint for
many symbols per request and one NBP table request for every currency, served to ``MarketDataRefresher``
through the ordinary ``PriceSource`` / ``FxSource`` contracts, so the refresh plans, reports and stores
exactly like the daily check.

Whatever a batch cannot answer goes to the fallback source (the daily check's per-instrument path):
no yahoo alias or a stooq-first listing (XWAR), a window older than the batch (nothing stored yet, or
the last stored bar before the spark window), a symbol Yahoo left out, a quote currency mismatch, or a
suspected split (the spark close on the newest stored day differs from the stored close by more than
``SPLIT_GUARD``: Yahoo adjusted its history, and the per-instrument chart reports the split, so the
refresher re-fetches the stored window). Spark has no split events of its own.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from decimal import Decimal

from ..domain import AliasNamespace, CalendarDate, Currency, FxRate, Instrument, InstrumentId
from .composite import default_price_source_order
from .nbp import NbpFxSource
from .sources import (
    FxSource,
    PriceHistory,
    PriceSource,
    SourceBlockedException,
    SourceException,
)
from .yahoo import YahooPriceSource

SPARK_CHUNK = 20
"""Symbols per spark request."""
SPLIT_GUARD = Decimal("0.25")
"""Relative difference between the spark close and the stored close of the same day above which the
instrument goes the per-instrument way (a split or another history adjustment)."""

PROBE_WAIT = 60.0
"""Seconds a stooq-first fetch waits for the first one's probe of stooq."""

_log = logging.getLogger("cashu.investments.market.batched")


class BatchedPriceSource(PriceSource):
    """Serves :meth:`fetch` from spark batches fetched by :meth:`prefetch`, else from ``fallback``.

    ``last_closes``: the newest stored ``(date, close)`` per instrument (the split guard)."""

    def __init__(
        self,
        yahoo: YahooPriceSource | None,
        fallback: PriceSource,
        *,
        last_closes: Mapping[InstrumentId, tuple[CalendarDate, Decimal]] | None = None,
        order: Callable[[Instrument], Sequence[str]] = default_price_source_order,
        chunk: int = SPARK_CHUNK,
    ) -> None:
        if chunk <= 0:
            raise ValueError("chunk must be positive")
        self._yahoo = yahoo
        self._fallback = fallback
        self._last = dict(last_closes or {})
        self._order = order
        self._chunk = chunk
        self._bodies: dict[str, str] = {}
        self.requests = 0
        """Spark requests made."""
        self.batched = 0
        """Instruments answered from a batch."""
        self.fallbacks = 0
        """Instruments sent to the fallback source."""
        self.batch_errors: list[str] = []
        self._lock = threading.Lock()
        self._probe_claimed = False
        self._probe_done = threading.Event()

    @property
    def id(self) -> str:
        return "batched"

    def _in_batch(self, instrument: Instrument) -> bool:
        symbol = instrument.alias(AliasNamespace.YAHOO)
        return symbol is not None and symbol in self._bodies

    def _blocked(self) -> set[str]:
        blocked = getattr(self._fallback, "blocked", None)
        return blocked() if callable(blocked) else set()

    def batchable(self, instrument: Instrument) -> bool:
        """Yahoo is the instrument's first source with an alias that is not blocked in this run (spark
        only replaces that path: a stooq-first listing goes per instrument until stooq is blocked)."""
        if self._yahoo is None or not instrument.fetches_market_data:
            return False
        if instrument.alias(AliasNamespace.YAHOO) is None:
            return False
        blocked = self._blocked()
        first = next(
            (
                s
                for s in self._order(instrument)
                if instrument.alias(s) is not None and s not in blocked
            ),
            None,
        )
        return first == AliasNamespace.YAHOO

    def _prefetchable(self, instrument: Instrument) -> bool:
        """Joins the spark request: a yahoo alias and a market-data instrument (a stooq-first one is
        answered from the batch only once stooq is blocked)."""
        return (
            self._yahoo is not None
            and instrument.fetches_market_data
            and instrument.alias(AliasNamespace.YAHOO) is not None
        )

    def prefetch(self, instruments: Iterable[Instrument]) -> None:
        """One spark request per ``chunk`` symbols of the batchable instruments. A failed chunk only
        sends its instruments to the fallback; a blocked source stops batching."""
        if self._yahoo is None:
            return
        symbols = sorted(
            {i.alias(AliasNamespace.YAHOO) for i in instruments if self._prefetchable(i)} - {None}
        )
        for start in range(0, len(symbols), self._chunk):
            chunk = symbols[start : start + self._chunk]
            self.requests += 1
            try:
                self._bodies.update(self._yahoo.spark(chunk))
            except SourceBlockedException as error:
                self.batch_errors.append(error.message)
                _log.info("spark blocked, the rest goes per instrument: %s", error.message)
                break
            except SourceException as error:
                self.batch_errors.append(error.message)
                _log.info("spark chunk failed: %s", error.message)
            except Exception as error:  # noqa: BLE001 - the fallback still answers
                self.batch_errors.append(repr(error))
                _log.warning("spark chunk failed unexpectedly", exc_info=True)

    def history(self, instrument: Instrument, start: CalendarDate, end: CalendarDate):
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument: Instrument, start: CalendarDate, end: CalendarDate) -> PriceHistory:
        answer = self._from_batch(instrument, start, end)
        if answer is None and self._in_batch(instrument):
            # A listing whose first source is another one (stooq for XWAR): the first such fetch
            # probes that source alone; the others wait for it, so once it turns out blocked they are
            # answered from the batch instead of all probing it at once (refresher workers).
            with self._lock:
                probe = not self._probe_claimed
                self._probe_claimed = True
            if probe:
                try:
                    with self._lock:
                        self.fallbacks += 1
                    return self._fallback.fetch(instrument, start, end)
                finally:
                    self._probe_done.set()
            self._probe_done.wait(PROBE_WAIT)
            answer = self._from_batch(instrument, start, end)
        with self._lock:
            if answer is not None:
                self.batched += 1
            else:
                self.fallbacks += 1
        return answer if answer is not None else self._fallback.fetch(instrument, start, end)

    def _from_batch(
        self, instrument: Instrument, start: CalendarDate, end: CalendarDate
    ) -> PriceHistory | None:
        symbol = instrument.alias(AliasNamespace.YAHOO)
        body = self._bodies.get(symbol) if symbol and self.batchable(instrument) else None
        if body is None or self._yahoo is None:
            return None
        try:
            full = self._yahoo.parse_history(body, instrument, dt.date.min, end, symbol=symbol)
        except SourceException:
            return None  # the per-instrument path reports it (unknown symbol, currency mismatch)
        if not full.bars or full.bars[0].date > start:
            return None  # the batch does not reach back to the planned start
        last = self._last.get(instrument.id)
        if last is not None:
            on, close = last
            same_day = next((b for b in full.bars if b.date == on), None)
            if same_day is not None and close > 0 and abs(same_day.close / close - 1) > SPLIT_GUARD:
                return None
        return PriceHistory(
            bars=tuple(b for b in full.bars if start <= b.date <= end), currency=full.currency
        )


class BatchedFxSource:
    """Serves :meth:`rates` from one NBP table request (:meth:`prefetch`) when the asked range lies
    within it, else from ``fallback`` (the per-currency request)."""

    def __init__(self, nbp: NbpFxSource | None, fallback: FxSource) -> None:
        self._nbp = nbp
        self._fallback = fallback
        self._window: tuple[CalendarDate, CalendarDate] | None = None
        self._rates: dict[Currency, list[FxRate]] = {}
        self.requests = 0
        self.batch_errors: list[str] = []

    @property
    def id(self) -> str:
        return self._fallback.id

    def prefetch(self, start: CalendarDate, end: CalendarDate) -> None:
        if self._nbp is None or start > end:
            return
        start = max(start, end - dt.timedelta(days=self._nbp.max_days_per_request - 1))
        self.requests += 1
        try:
            self._rates = self._nbp.table_rates(start, end)
        except SourceException as error:
            self.batch_errors.append(error.message)
            _log.info("nbp table failed: %s", error.message)
            return
        except Exception as error:  # noqa: BLE001 - the fallback still answers
            self.batch_errors.append(repr(error))
            _log.warning("nbp table failed unexpectedly", exc_info=True)
            return
        self._window = (start, end)

    def rates(self, quote: Currency, start: CalendarDate, end: CalendarDate) -> list[FxRate]:
        if self._window is not None and self._window[0] <= start and end <= self._window[1]:
            return [r for r in self._rates.get(quote, []) if start <= r.date <= end]
        return self._fallback.rates(quote, start, end)
