"""Return math on daily series: contributions-neutral TWR, money-weighted XIRR, drawdowns,
annualizing. Pure, floats (money stays ``Decimal`` until it reaches this module).

Conventions:

- A daily series is aligned lists: ``values[i]`` is the end-of-day value of day ``i``, ``flows[i]`` the
  external flows booked on day ``i`` (+ = money put in), ``complete[i]`` whether the value is whole.
- TWR treats a day's flows as arriving at the end of that day: ``r_i = (V_i - F_i) / V_prev - 1`` (a
  deposit earns nothing on its day; units moved in or out are valued at that day's value, so the
  same-cash-flow simulation, which buys at the day's close, has exactly the benchmark's TWR). With no
  capital at the start of the day (``V_prev`` <= half a cent) the day's return is 0. Incomplete days are
  linked over: from the last complete value ``V_p`` to the next one ``V_q`` the flows ``F`` of the
  stretch count from its start, ``r = V_q / (V_p + F) - 1``.
- XIRR solves ``sum(cf_i * (1 + d) ** -t_i) = 0`` for a daily rate ``d`` (``t_i`` in days from the first
  flow, investor sign: money put in is negative) by bisection on ``x = ln(1 + d)``. Annual rate
  ``(1 + d) ** 365 - 1``; the period (not annualized) money-weighted return ``(1 + d) ** span - 1``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

CAPITAL_EPSILON = 0.005
"""Capital (base currency units) below which a day earns nothing (half a cent)."""

MIN_ANNUALIZE_DAYS = 365
"""Returns over shorter spans are not annualized (a week's gain to the power of 52 means nothing)."""


@dataclass(frozen=True, slots=True)
class Drawdown:
    """The deepest fall of an index from a running peak."""

    depth: float
    """Fraction <= 0 (-0.18 = an 18 % fall); 0 when the index never fell."""
    peak: date | None = None
    trough: date | None = None
    recovered: date | None = None
    """First date after the trough when the index was back at the peak, None while it is not."""

    def to_dict(self) -> dict:
        return {
            "depth": round(self.depth, 6),
            "peak": None if self.peak is None else self.peak.isoformat(),
            "trough": None if self.trough is None else self.trough.isoformat(),
            "recovered": None if self.recovered is None else self.recovered.isoformat(),
        }


def twr_index(
    values: Sequence[float], flows: Sequence[float], complete: Sequence[bool]
) -> list[float | None]:
    """Growth of 1 from the first point (index 1.0 there), linked daily. Incomplete points are None.

    The first point is the base: its value is the starting capital and its own flows are ignored (they
    are part of that value)."""
    out: list[float | None] = []
    index = 1.0
    prev: float | None = None
    prev_at = 0
    pending = 0.0
    for i, (value, flow, whole) in enumerate(zip(values, flows, complete, strict=True)):
        if i == 0:
            out.append(1.0 if whole else None)
            prev = value if whole else None
            continue
        pending += flow
        if not whole:
            out.append(None)
            continue
        if prev is None:
            # No complete point yet: this one becomes the base.
            prev, prev_at, pending = value, i, 0.0
            out.append(index)
            continue
        if i - prev_at == 1:
            # One day: the flows came at its end.
            if prev > CAPITAL_EPSILON and value - pending >= 0:
                index *= (value - pending) / prev
        else:
            # Over unvalued days the flows count from the start of the stretch.
            capital = prev + pending
            if capital > CAPITAL_EPSILON:
                index *= value / capital
        prev, prev_at, pending = value, i, 0.0
        out.append(index)
    return out


def period_return(
    index: Sequence[float | None], start: int = 0, end: int | None = None
) -> float | None:
    """``index[end] / index[start] - 1`` using the nearest complete points (start: first on/after,
    end: last on/before); None without both."""
    end = len(index) - 1 if end is None else end
    first = next((index[i] for i in range(start, end + 1) if index[i] is not None), None)
    last = next((index[i] for i in range(end, start - 1, -1) if index[i] is not None), None)
    if first is None or last is None or first <= 0:
        return None
    return last / first - 1


def annualized(ret: float | None, days: int) -> float | None:
    """``(1 + ret) ** (365 / days) - 1``; None for spans shorter than a year or a total loss."""
    if ret is None or days < MIN_ANNUALIZE_DAYS or ret <= -1:
        return None
    return (1 + ret) ** (365 / days) - 1


@dataclass(frozen=True, slots=True)
class Xirr:
    """A solved money-weighted return."""

    log_daily: float
    """``ln(1 + d)`` of the daily rate."""
    span_days: int

    @property
    def annual(self) -> float | None:
        """Annual rate; None for spans shorter than a year (or an absurd value)."""
        if self.span_days < MIN_ANNUALIZE_DAYS:
            return None
        exponent = 365 * self.log_daily
        return None if exponent > 50 else math.expm1(exponent)

    @property
    def period(self) -> float:
        """Money-weighted return over the whole span, not annualized."""
        return math.expm1(self.log_daily * self.span_days)


def xirr(cashflows: Sequence[tuple[date, float]]) -> Xirr | None:
    """Money-weighted return of investor cash flows (negative = money put in, the final value as a
    positive flow on the last day). None without flows of both signs or without a sign change of the
    net present value inside the searched range."""
    flows = [(d, a) for d, a in cashflows if a != 0]
    if not flows or not any(a > 0 for _, a in flows) or not any(a < 0 for _, a in flows):
        return None
    t0 = min(d for d, _ in flows)
    span = max(d for d, _ in flows).toordinal() - t0.toordinal()
    times = [(d.toordinal() - t0.toordinal(), a) for d, a in flows]
    if span == 0:
        return None
    bound = min(1.0, 50.0 / span)

    def npv(x: float) -> float:
        return sum(a * math.exp(-x * t) for t, a in times)

    lo, hi = -bound, bound
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo == 0:
        return Xirr(lo, span)
    if f_hi == 0:
        return Xirr(hi, span)
    if (f_lo > 0) == (f_hi > 0):
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if f_mid == 0 or hi - lo < 1e-15:
            return Xirr(mid, span)
        if (f_mid > 0) == (f_lo > 0):
            lo, f_lo = mid, f_mid
        else:
            hi = mid
    return Xirr((lo + hi) / 2, span)


def max_drawdown(dates: Sequence[date], index: Sequence[float | None]) -> Drawdown:
    """Deepest peak-to-trough fall of ``index`` (None points skipped) with its dates and recovery."""
    peak_value: float | None = None
    peak_date: date | None = None
    best = Drawdown(0.0)
    best_peak_value: float | None = None
    for day, value in zip(dates, index, strict=True):
        if value is None:
            continue
        if peak_value is None or value > peak_value:
            peak_value, peak_date = value, day
            continue
        depth = value / peak_value - 1 if peak_value > 0 else 0.0
        if depth < best.depth:
            best = Drawdown(depth, peak_date, day)
            best_peak_value = peak_value
    if best.trough is None or best_peak_value is None:
        return best
    for day, value in zip(dates, index, strict=True):
        if day > best.trough and value is not None and value >= best_peak_value:
            return Drawdown(best.depth, best.peak, best.trough, day)
    return best


def drawdown_series(index: Sequence[float | None]) -> list[float | None]:
    """Per point: the fall from the running peak (0 at a new high, None where the index is None)."""
    out: list[float | None] = []
    peak: float | None = None
    for value in index:
        if value is None:
            out.append(None)
            continue
        if peak is None or value > peak:
            peak = value
        out.append(value / peak - 1 if peak > 0 else 0.0)
    return out
