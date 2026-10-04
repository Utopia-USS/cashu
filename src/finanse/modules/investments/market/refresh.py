"""Incremental price and FX refresh planning. Reads what is stored through a protocol, fetches from the
sources, and returns the data to persist in a :class:`FetchReport` (no database writes here)."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Protocol

from ..domain import (
    CalendarDate,
    Currency,
    FxRate,
    Instrument,
    InstrumentId,
    ManualValuation,
    MarketView,
    PriceBar,
)
from ..portfolio import InMemoryFxLookup
from .fetch_report import FetchReport, FetchStatus, FxFetch, InstrumentFetch
from .sources import FxSource, NoPriceSourceException, PriceHistory, PriceSource, SourceException


class StoredMarketData(Protocol):
    """Read-only view of the stored bars and rates the refresher plans against."""

    def last_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None: ...

    def first_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None: ...

    def has_bars_fetched_before(
        self, instrument_id: InstrumentId, *, dated_before: CalendarDate, fetched_before: datetime
    ) -> bool:
        """True when a stored bar dated before ``dated_before`` was fetched before ``fetched_before``
        (a bar without a fetch time counts as fetched before)."""
        ...

    def last_rate_date(self, quote: Currency) -> CalendarDate | None: ...

    def first_rate_date(self, quote: Currency) -> CalendarDate | None: ...

    def has_rate_on_or_before(self, quote: Currency, on: CalendarDate) -> bool: ...


class MarketDataRefresher:
    """Incremental refresh of instrument bars and PLN rates (port of the Kompas ``MarketDataService``
    without the repository writes).

    Range per instrument / currency: from the last stored date (re-fetching ``refetch_days`` stored days,
    so a bar stored while its session was open is replaced by the final close) or ``as_of -
    backfill_days`` when nothing is stored, up to ``as_of``. Nothing is requested when the stored data
    already reaches past that range. Instruments that do not fetch market data (delisted, frozen) are
    skipped. Every failure is an entry in the report, never an exception.

    Splits (R6): sources serve split-adjusted closes (Yahoo adjusts its whole history), so bars stored
    before a split are unadjusted. When the source reports a split inside the fetched window, or the
    portfolio has a split transaction of the instrument (``split_dates``), and bars dated before that
    split were fetched before the end of the split day (UTC), the whole stored window (oldest stored bar
    .. as_of) is fetched again and returned with ``replace_from`` set. A re-fetch without bars is an error
    and the stored bars stay.
    """

    def __init__(
        self,
        prices: PriceSource,
        fx: FxSource,
        *,
        backfill_days: int = 400,
        refetch_days: int = 1,
        logger: logging.Logger | None = None,
    ) -> None:
        if refetch_days < 0:
            raise ValueError("refetch_days must not be negative")
        self._prices = prices
        self._fx = fx
        self.backfill_days = backfill_days
        self.refetch_days = refetch_days
        self._log = logger or logging.getLogger("finanse.investments.market")

    def refresh(
        self,
        stored: StoredMarketData,
        instruments: Iterable[Instrument],
        currencies: Iterable[Currency],
        as_of: CalendarDate,
        *,
        fx_history_from: Mapping[Currency, CalendarDate] | None = None,
        split_dates: Mapping[InstrumentId, CalendarDate] | None = None,
    ) -> FetchReport:
        """Fetches bars of ``instruments`` and PLN rates of ``currencies`` up to ``as_of``.

        ``fx_history_from``: when no rate of a currency exists on/before the given date (e.g. the open
        date of the oldest lot in it, needed for its cost at trade-date FX), the missing span from a week
        before that date up to the oldest stored rate is fetched as well.

        ``split_dates``: newest split transaction date per instrument (triggers the re-fetch for
        sources that do not report splits). PLN is skipped (identity rate).
        """
        history_from = fx_history_from or {}
        splits = split_dates or {}
        unique = list({instrument.id: instrument for instrument in instruments}.values())
        instrument_results = tuple(
            self._refresh_instrument(stored, instrument, as_of, splits.get(instrument.id))
            for instrument in unique
        )
        fx_results = tuple(
            self._refresh_currency(stored, currency, as_of, history_from.get(currency))
            for currency in dict.fromkeys(currencies)
            if currency != Currency.PLN
        )
        report = FetchReport(as_of=as_of, instruments=instrument_results, fx=fx_results)
        self._log.info("market refresh %s: %s", as_of, report.to_stats())
        return report

    def _start(self, last: CalendarDate | None, as_of: CalendarDate) -> CalendarDate:
        if last is None:
            return as_of - timedelta(days=self.backfill_days)
        return last + timedelta(days=1 - self.refetch_days)

    def _refresh_instrument(
        self,
        stored: StoredMarketData,
        instrument: Instrument,
        as_of: CalendarDate,
        split_date: CalendarDate | None,
    ) -> InstrumentFetch:
        label = instrument.symbol or instrument.name

        def result(
            status: FetchStatus, start: CalendarDate | None = None, **kwargs
        ) -> InstrumentFetch:
            return InstrumentFetch(
                instrument_id=instrument.id,
                label=label,
                status=status,
                start=start,
                end=None if start is None else as_of,
                **kwargs,
            )

        if not instrument.fetches_market_data:
            return result(
                FetchStatus.SKIPPED, message=f"not fetched: instrument is {instrument.status.value}"
            )
        last = stored.last_bar_date(instrument.id)
        first = stored.first_bar_date(instrument.id)
        start = self._start(last, as_of)
        try:
            reason = None
            if split_date is not None and _stored_unadjusted(stored, instrument, first, split_date):
                reason = f"split transaction on {split_date}"
            if reason is None and start > as_of:
                return result(FetchStatus.OK, message=f"up to date (last bar {last})")

            answer: PriceHistory | None = None
            if reason is None:
                answer = self._fetch(instrument, start, as_of)
                for split in answer.splits:
                    if _stored_unadjusted(stored, instrument, first, split.date):
                        reason = f"split {split.ratio}:1 on {split.date} reported by the source"
                        break
            if reason is not None and first is not None:
                start = first
                full = self._fetch(instrument, start, as_of)
                if not full.bars:
                    return result(
                        FetchStatus.ERROR,
                        start,
                        message=f"{reason}: re-fetching {start}..{as_of} returned no bars; "
                        "stored bars kept",
                    )
                self._log.info(
                    "prices %s (%s): %s, re-fetched %s..%s",
                    label,
                    instrument.id,
                    reason,
                    start,
                    as_of,
                )
                return result(
                    FetchStatus.OK,
                    start,
                    bars=full.bars,
                    source=_sources_of(full.bars),
                    message=f"{reason}: re-fetched the stored window",
                    currency=full.currency,
                    refetched_for_split=True,
                    replace_from=start,
                )

            assert answer is not None
            if not answer.bars:
                return result(FetchStatus.NO_DATA, start, message=f"no bars for {start}..{as_of}")
            return result(
                FetchStatus.OK,
                start,
                bars=answer.bars,
                source=_sources_of(answer.bars),
                currency=answer.currency,
            )
        except NoPriceSourceException as error:
            return result(FetchStatus.NO_DATA, start, message=error.message)
        except SourceException as error:
            self._log.warning("prices %s (%s) failed: %s", label, instrument.id, error)
            return result(FetchStatus.ERROR, start, message=f"{error.source_id}: {error.message}")
        except Exception as error:  # noqa: BLE001 - one broken instrument never aborts the refresh
            self._log.exception("prices %s (%s) failed unexpectedly", label, instrument.id)
            return result(FetchStatus.ERROR, start, message=f"{type(error).__name__}: {error}")

    def _fetch(
        self, instrument: Instrument, start: CalendarDate, end: CalendarDate
    ) -> PriceHistory:
        """``PriceSource.fetch`` restricted to bars of ``instrument`` within ``start..end``."""
        answer = self._prices.fetch(instrument, start, end)
        return PriceHistory(
            bars=tuple(
                bar
                for bar in answer.bars
                if bar.instrument_id == instrument.id and start <= bar.date <= end
            ),
            splits=answer.splits,
            currency=answer.currency,
        )

    def _refresh_currency(
        self,
        stored: StoredMarketData,
        currency: Currency,
        as_of: CalendarDate,
        history_from: CalendarDate | None,
    ) -> FxFetch:
        start: CalendarDate | None = None
        fetched: dict[CalendarDate, FxRate] = {}

        def result(status: FetchStatus, message: str | None = None) -> FxFetch:
            rates = tuple(fetched[on] for on in sorted(fetched))
            return FxFetch(
                currency=currency,
                status=status,
                start=start,
                end=None if start is None else as_of,
                rates=rates,
                source=self._fx.id if rates else None,
                message=message,
            )

        def fetch(begin: CalendarDate, end: CalendarDate) -> None:
            for rate in self._fx.rates(currency, begin, end):
                if rate.quote == currency and begin <= rate.date <= end:
                    fetched[rate.date] = rate

        try:
            last = stored.last_rate_date(currency)
            incremental = self._start(last, as_of)
            requested = False
            if incremental <= as_of:
                start, requested = incremental, True
                fetch(incremental, as_of)
            if history_from is not None and not (
                stored.has_rate_on_or_before(currency, history_from)
                or any(on <= history_from for on in fetched)
            ):
                history_start = history_from - timedelta(days=7)
                firsts = [d for d in (stored.first_rate_date(currency), *fetched) if d is not None]
                history_end = min(firsts) - timedelta(days=1) if firsts else as_of
                if history_start <= history_end:
                    start, requested = history_start, True
                    fetch(history_start, history_end)
            if not requested:
                return result(FetchStatus.OK, f"up to date (last rate {last})")
            if not fetched:
                return result(FetchStatus.NO_DATA, f"no rates for {start}..{as_of}")
            return result(FetchStatus.OK)
        except SourceException as error:
            self._log.warning("fx %s failed: %s", currency, error)
            fetched.clear()
            return result(FetchStatus.ERROR, f"{error.source_id}: {error.message}")
        except Exception as error:  # noqa: BLE001 - one broken currency never aborts the refresh
            self._log.exception("fx %s failed unexpectedly", currency)
            fetched.clear()
            return result(FetchStatus.ERROR, f"{type(error).__name__}: {error}")


def _stored_unadjusted(
    stored: StoredMarketData,
    instrument: Instrument,
    first: CalendarDate | None,
    split_date: CalendarDate,
) -> bool:
    """True when bars dated before ``split_date`` were stored before the split took effect (fetched
    before the end of the split day, UTC), so the source's adjusted history differs from them."""
    if first is None or first >= split_date:
        return False
    end_of_split_day = datetime(split_date.year, split_date.month, split_date.day, tzinfo=UTC)
    return stored.has_bars_fetched_before(
        instrument.id,
        dated_before=split_date,
        fetched_before=end_of_split_day + timedelta(days=1),
    )


def _sources_of(bars: Sequence[PriceBar]) -> str:
    return ", ".join(dict.fromkeys(bar.source for bar in bars))


class InMemoryMarketData:
    """Bars and rates in memory: a :class:`StoredMarketData` for tests and small tools, and the
    reference semantics of applying a :class:`FetchReport` (what the persistence layer must do)."""

    def __init__(self, bars: Iterable[PriceBar] = (), rates: Iterable[FxRate] = ()) -> None:
        self.bars: dict[InstrumentId, dict[CalendarDate, PriceBar]] = {}
        self.rates: dict[Currency, dict[CalendarDate, FxRate]] = {}
        self.upsert_bars(bars)
        self.upsert_rates(rates)

    def upsert_bars(self, bars: Iterable[PriceBar]) -> None:
        for bar in bars:
            self.bars.setdefault(bar.instrument_id, {})[bar.date] = bar

    def upsert_rates(self, rates: Iterable[FxRate]) -> None:
        for rate in rates:
            if rate.base == Currency.PLN:
                self.rates.setdefault(rate.quote, {})[rate.date] = rate

    def apply(self, report: FetchReport) -> None:
        """Stores a report's data: replace the window for split re-fetches, upsert otherwise."""
        for item in report.instruments:
            if item.replace_from is not None:
                series = self.bars.setdefault(item.instrument_id, {})
                end = item.end or report.as_of
                for on in [on for on in series if item.replace_from <= on <= end]:
                    del series[on]
            self.upsert_bars(item.bars)
        for item in report.fx:
            self.upsert_rates(item.rates)

    # --- StoredMarketData ------------------------------------------------------------------------

    def last_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None:
        series = self.bars.get(instrument_id)
        return max(series) if series else None

    def first_bar_date(self, instrument_id: InstrumentId) -> CalendarDate | None:
        series = self.bars.get(instrument_id)
        return min(series) if series else None

    def has_bars_fetched_before(
        self, instrument_id: InstrumentId, *, dated_before: CalendarDate, fetched_before: datetime
    ) -> bool:
        return any(
            on < dated_before and (bar.fetched_at is None or bar.fetched_at < fetched_before)
            for on, bar in self.bars.get(instrument_id, {}).items()
        )

    def last_rate_date(self, quote: Currency) -> CalendarDate | None:
        series = self.rates.get(quote)
        return max(series) if series else None

    def first_rate_date(self, quote: Currency) -> CalendarDate | None:
        series = self.rates.get(quote)
        return min(series) if series else None

    def has_rate_on_or_before(self, quote: Currency, on: CalendarDate) -> bool:
        return any(day <= on for day in self.rates.get(quote, {}))

    # --- views -----------------------------------------------------------------------------------

    def market_view(
        self,
        as_of: CalendarDate,
        instruments: Iterable[Instrument],
        manual_valuations: Iterable[ManualValuation] = (),
    ) -> MarketView:
        """A :class:`MarketView` with the stored bars of ``instruments`` dated on/before ``as_of``."""
        listed = {instrument.id: instrument for instrument in instruments}
        valuations: dict[InstrumentId, list[ManualValuation]] = {}
        for valuation in manual_valuations:
            valuations.setdefault(valuation.instrument_id, []).append(valuation)
        return MarketView(
            as_of=as_of,
            instruments=listed,
            bars={
                instrument_id: tuple(series[on] for on in sorted(series) if on <= as_of)
                for instrument_id, series in self.bars.items()
                if instrument_id in listed
            },
            manual_valuations={
                key: tuple(sorted(value, key=lambda v: v.as_of))
                for key, value in valuations.items()
            },
        )

    def fx_lookup(self) -> InMemoryFxLookup:
        return InMemoryFxLookup(rate for series in self.rates.values() for rate in series.values())
