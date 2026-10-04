"""In-memory FX lookup (on/before a date, inverse and cross rates). Pure, no IO.

The persistence layer preloads the needed rates once (see :func:`fx_currencies_for`) and hands an
:class:`InMemoryFxLookup` to valuation, so valuation stays synchronous and IO-free.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Mapping
from decimal import Decimal

from ..domain import (
    CalendarDate,
    Currency,
    DatedPrice,
    FxLookup,
    FxQuote,
    FxRate,
    InstrumentId,
    MarketView,
    PortfolioSnapshot,
    divided_by,
    exact,
)


class InMemoryFxLookup:
    """An :class:`FxLookup` over rates held in memory.

    Resolution order for (quote, base): identity, a stored (base, quote) series, the inverse of a stored
    (quote, base) series, then a cross rate through any stored base (``USD -> EUR`` = PLN per USD / PLN
    per EUR, each on/before the date; the quote's date is the older leg). Inverse and cross rates are
    rounded with ``divided_by``. Non-positive rates are ignored; for one (base, quote, date) the last
    given rate wins.
    """

    def __init__(self, rates: Iterable[FxRate]) -> None:
        by_pair: dict[tuple[Currency, Currency], dict[CalendarDate, FxRate]] = {}
        for rate in rates:
            if rate.rate <= 0:
                continue
            by_pair.setdefault((rate.base, rate.quote), {})[rate.date] = rate
        self._series: dict[tuple[Currency, Currency], list[FxRate]] = {}
        self._dates: dict[tuple[Currency, Currency], list[CalendarDate]] = {}
        for pair, by_date in by_pair.items():
            series = sorted(by_date.values(), key=lambda r: r.date)
            self._series[pair] = series
            self._dates[pair] = [r.date for r in series]

    def rate_on_or_before(
        self, quote: Currency, on: CalendarDate, base: Currency = Currency.PLN
    ) -> Decimal | None:
        found = self.quote_on_or_before(quote, on, base)
        return None if found is None else found.rate

    @exact
    def quote_on_or_before(
        self, quote: Currency, on: CalendarDate, base: Currency = Currency.PLN
    ) -> FxQuote | None:
        if quote == base:
            return FxQuote(rate=Decimal(1), date=on)
        direct = self._find(base, quote, on)
        if direct is not None:
            return FxQuote(rate=direct.rate, date=direct.date)
        inverse = self._find(quote, base, on)
        if inverse is not None:
            return FxQuote(rate=divided_by(Decimal(1), inverse.rate), date=inverse.date)
        for pivot in dict.fromkeys(pair[0] for pair in self._series):
            quote_in_pivot = self._find(pivot, quote, on)
            base_in_pivot = self._find(pivot, base, on)
            if quote_in_pivot is not None and base_in_pivot is not None:
                return FxQuote(
                    rate=divided_by(quote_in_pivot.rate, base_in_pivot.rate),
                    date=min(quote_in_pivot.date, base_in_pivot.date),
                )
        return None

    def _find(self, base: Currency, quote: Currency, on: CalendarDate) -> FxRate | None:
        dates = self._dates.get((base, quote))
        if not dates:
            return None
        index = bisect_right(dates, on)
        return None if index == 0 else self._series[(base, quote)][index - 1]


@exact
def convert(
    fx: FxLookup, amount: Decimal, source: Currency, target: Currency, on: CalendarDate
) -> Decimal | None:
    """``amount`` in ``source`` converted to ``target`` at the rate on/before ``on`` (no age limit), or
    None when no rate is known."""
    rate = fx.rate_on_or_before(source, on, target)
    return None if rate is None else amount * rate


def fx_currencies_for(
    snapshot: PortfolioSnapshot,
    market: MarketView,
    base_currency: Currency,
    *,
    last_known_prices: Mapping[InstrumentId, DatedPrice] | None = None,
) -> tuple[frozenset[Currency], CalendarDate]:
    """What ``value_portfolio`` can ask the FX lookup for: every currency of lots, cash, held instruments,
    manual valuations, last trade prices and realized trades plus ``base_currency``, and the oldest date
    needed (oldest lot / realized open date, else the snapshot date). The loader preloads rates of these
    currencies from that date (plus the newest rate before it, for weekends) up to the snapshot date.
    """
    fallback = snapshot.last_trade_prices if last_known_prices is None else last_known_prices
    oldest = snapshot.as_of
    currencies: set[Currency] = {base_currency}
    for holding in snapshot.holdings:
        currencies.add(holding.currency)
        instrument = market.instrument(holding.instrument_id)
        if instrument is not None:
            currencies.add(instrument.currency)
        price = fallback.get(holding.instrument_id)
        if price is not None:
            currencies.add(price.currency)
        valuation = market.manual_valuation(holding.instrument_id, snapshot.as_of)
        if valuation is not None:
            currencies.add(valuation.currency)
        for lot in holding.lots:
            currencies.add(lot.currency)
            oldest = min(oldest, lot.open_date)
    for cash in snapshot.cash:
        currencies.add(cash.currency)
    for trade in snapshot.realized:
        currencies.add(trade.currency)
        if trade.cost_currency is not None:
            currencies.add(trade.cost_currency)
        oldest = min(oldest, trade.open_date)
    return frozenset(currencies), oldest
