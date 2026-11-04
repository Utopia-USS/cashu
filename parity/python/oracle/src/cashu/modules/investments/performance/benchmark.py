"""The benchmark: daily proxy prices in the base currency and the same-cash-flow simulation. Pure.

- Price for day ``d``: the newest stored close of the proxy on/before ``d`` no older than
  ``max_price_age_days``, converted at the rate on/before ``d`` no older than ``max_fx_age_days`` (the
  valuation's limits); None otherwise. Stored closes are split-adjusted by the source, so the series
  needs no corporate-action handling (it is a price index: distributions of a distributing fund are not
  reinvested; an accumulating proxy has none).
- Simulation: the portfolio's value at the range start buys proxy units at that day's price, then every
  external flow of the portfolio buys (withdrawals sell) units at that day's price. A flow on a day
  without a price waits for the next priced day. ``with_fees`` also sells units for the portfolio's
  account-level fees (the "same custody costs" variant). Units never go below 0 (a withdrawal larger than
  the simulated holding empties it; ``capped`` says it happened).
"""

from __future__ import annotations

import bisect
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from ..domain import CalendarDate, Currency, FxLookup, PriceBar


def benchmark_prices(
    dates: Sequence[CalendarDate],
    bars: Sequence[PriceBar],
    currency: Currency,
    fx: FxLookup,
    base: Currency,
    *,
    max_price_age_days: int,
    max_fx_age_days: int,
) -> list[float | None]:
    """Proxy price in ``base`` for every day of ``dates`` (None where unknown or too old)."""
    ordered = sorted(bars, key=lambda b: b.date)
    bar_dates = [b.date for b in ordered]
    out: list[float | None] = []
    for day in dates:
        i = bisect.bisect_right(bar_dates, day) - 1
        if i < 0 or (day - bar_dates[i]).days > max_price_age_days:
            out.append(None)
            continue
        quote = fx.quote_on_or_before(currency, day, base)
        if quote is None or quote.age_days(day) > max_fx_age_days:
            out.append(None)
            continue
        out.append(float(ordered[i].close * quote.rate))
    return out


def price_index(prices: Sequence[float | None], start: int = 0) -> list[float | None]:
    """Prices divided by the first known price at or after ``start`` (None before it)."""
    first = next((p for p in prices[start:] if p is not None and p > 0), None)
    out: list[float | None] = [None] * len(prices)
    if first is None:
        return out
    for i in range(start, len(prices)):
        price = prices[i]
        out[i] = None if price is None else price / first
    return out


@dataclass(frozen=True, slots=True)
class Simulation:
    """Daily values of the same-cash-flow benchmark holding (None before the first priced day)."""

    values: list[float | None]
    with_fees: list[float | None]
    started: date | None
    """First day the simulation held units (the range start when the proxy had a price then)."""
    capped: bool


def simulate(
    dates: Sequence[CalendarDate],
    prices: Sequence[float | None],
    start_value: float,
    flows: Sequence[float],
    fees: Sequence[float] | None = None,
) -> Simulation:
    """The same-cash-flow simulation over ``dates`` (index 0 = range start: ``start_value`` is invested
    there; flows of index 0 are part of it)."""
    n = len(dates)
    fee_list = list(fees) if fees is not None else [0.0] * n
    units = units_fees = 0.0
    pending = start_value
    pending_fees = 0.0
    last_price: float | None = None
    started: date | None = None
    capped = False
    values: list[float | None] = []
    with_fees: list[float | None] = []
    for i in range(n):
        if i > 0:
            pending += flows[i]
            pending_fees += fee_list[i]
        price = prices[i]
        priced = price is not None and price > 0
        if priced:
            last_price = price
        if last_price is None:
            values.append(None)
            with_fees.append(None)
            continue
        if priced and (pending or pending_fees):
            units += pending / last_price
            units_fees += (pending - pending_fees) / last_price
            pending = pending_fees = 0.0
            if started is None:
                started = dates[i]
        if units < 0:
            units, capped = 0.0, True
        if units_fees < 0:
            units_fees, capped = 0.0, True
        # a flow waiting for the next priced day is held as cash meanwhile
        values.append(units * last_price + pending)
        with_fees.append(units_fees * last_price + pending - pending_fees)
    return Simulation(values, with_fees, started, capped)
