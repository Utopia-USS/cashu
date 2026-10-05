"""Range metrics on a combined daily series: value, contributions, TWR, XIRR, drawdowns, the
benchmark and its same-cash-flow simulation, rolling relative windows, calendar years. Pure.

Ranges (``RANGES``) end on the series' last day; the start is the *base day* whose end-of-day value is
the starting capital: ``1m`` / ``3m`` / ``1y`` / ``3y`` = the same calendar day that many months back
(clamped to the month's last day), ``ytd`` = 31 December of the previous year, ``max`` = the day before
the first transaction (value 0). A base day before the series start is clamped to it.

Rolling windows (12 / 24 / 36 months): at every month end (and the last day) whose window start lies
inside the history and finds capital at work, ``portfolio`` = TWR over the window, ``benchmark`` = the
proxy's price change over the same days, ``excess`` = portfolio - benchmark (cumulative, not annualized).
"""

from __future__ import annotations

import calendar
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date

from . import returns
from .benchmark import Simulation, price_index, simulate
from .series import Combined

RANGES = ("1m", "3m", "ytd", "1y", "3y", "max")
ROLLING_MONTHS = (12, 24, 36)


def months_back(day: date, months: int) -> date:
    """The same calendar day ``months`` earlier (clamped to the month's last day)."""
    total = day.year * 12 + (day.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def range_base(key: str, end: date, anchor: date) -> date:
    """Base day of range ``key`` ending on ``end`` (``anchor`` = the series' first day)."""
    match key:
        case "1m":
            start = months_back(end, 1)
        case "3m":
            start = months_back(end, 3)
        case "ytd":
            start = date(end.year - 1, 12, 31)
        case "1y":
            start = months_back(end, 12)
        case "3y":
            start = months_back(end, 36)
        case "max":
            start = anchor
        case _:
            raise ValueError(f"unknown range {key!r}; use one of {', '.join(RANGES)}")
    return max(start, anchor)


@dataclass
class RangeMetrics:
    """Everything one range needs: aligned daily arrays (index 0 = base day) and the summary."""

    key: str
    dates: list[date]
    values: list[float]
    flows: list[float]
    complete: list[bool]
    twr: list[float | None]
    drawdown: list[float | None]
    benchmark_index: list[float | None] | None = None
    benchmark_drawdown: list[float | None] | None = None
    simulation: Simulation | None = None
    summary: dict = field(default_factory=dict)
    benchmark: dict = field(default_factory=dict)

    @property
    def start(self) -> date:
        return self.dates[0]

    @property
    def end(self) -> date:
        return self.dates[-1]


def _sum(values: Sequence[float]) -> float:
    return float(sum(values))


def compute_range(
    key: str,
    dates: Sequence[date],
    combined: Combined,
    bench_prices: Sequence[float | None] | None,
) -> RangeMetrics:
    """Metrics of range ``key`` over a full-history combined series (``dates`` aligned with it)."""
    base = range_base(key, dates[-1], dates[0])
    i0 = (base - dates[0]).days
    sl = slice(i0, len(dates))
    ds = list(dates[sl])
    values = combined.values[sl]
    flows = combined.flows[sl]
    fees = combined.fees[sl]
    complete = combined.complete[sl]
    implied = combined.implied[sl]
    index = returns.twr_index(values, flows, complete)
    span = (ds[-1] - ds[0]).days
    start_value, end_value = values[0], values[-1]
    inner = flows[1:]
    net_flows = _sum(inner)
    deposits = _sum(f for f in inner if f > 0)
    withdrawals = _sum(-f for f in inner if f < 0)
    twr = returns.period_return(index)
    cashflows = [(ds[0], -start_value)] + [(ds[i], -flows[i]) for i in range(1, len(ds))]
    solved = returns.xirr([*cashflows, (ds[-1], end_value)])
    dd = returns.max_drawdown(ds, index)
    summary = {
        "start_value": start_value,
        "end_value": end_value,
        "net_contributions": net_flows,
        "deposits": deposits,
        "withdrawals": withdrawals,
        "implied_funding": _sum(implied[1:]),
        "account_fees": _sum(fees[1:]),
        "contributions_gross": start_value + deposits,
        "pnl": end_value - start_value - net_flows,
        "twr": twr,
        "twr_annualized": returns.annualized(twr, span),
        "xirr": None if solved is None else solved.annual,
        "mwr": None if solved is None else solved.period,
        "max_drawdown": dd,
        "days": span,
        "incomplete_days": sum(1 for c in complete[1:] if not c),
        "end_complete": complete[-1],
    }
    metrics = RangeMetrics(
        key=key,
        dates=ds,
        values=values,
        flows=flows,
        complete=complete,
        twr=index,
        drawdown=returns.drawdown_series(index),
        summary=summary,
    )
    if bench_prices is None:
        return metrics
    prices = list(bench_prices[sl])
    bindex = price_index(prices)
    metrics.benchmark_index = bindex
    metrics.benchmark_drawdown = returns.drawdown_series(bindex)
    sim = simulate(ds, prices, start_value, flows, fees)
    metrics.simulation = sim
    btwr = returns.period_return(bindex)
    first_priced = next((ds[i] for i, p in enumerate(prices) if p is not None), None)
    sim_end = sim.values[-1]
    sim_fees_end = sim.with_fees[-1]
    sim_solved = None if sim_end is None else returns.xirr([*cashflows, (ds[-1], sim_end)])
    metrics.benchmark = {
        "twr": btwr,
        "twr_annualized": returns.annualized(
            btwr, (ds[-1] - first_priced).days if first_priced else 0
        ),
        "max_drawdown": returns.max_drawdown(ds, bindex),
        "first_priced": first_priced,
        "covers_range": first_priced is not None and first_priced <= ds[0],
        "simulation_end_value": sim_end,
        "simulation_end_value_with_fees": sim_fees_end,
        "simulation_pnl": None if sim_end is None else sim_end - start_value - net_flows,
        "simulation_xirr": None if sim_solved is None else sim_solved.annual,
        "simulation_mwr": None if sim_solved is None else sim_solved.period,
        "simulation_started": sim.started,
        "simulation_capped": sim.capped,
        "excess_twr": None if twr is None or btwr is None else twr - btwr,
        "excess_value": None if sim_end is None else end_value - sim_end,
        "excess_vs_simulation": None if not sim_end else (end_value - sim_end) / sim_end,
    }
    return metrics


def _last_known(index: Sequence[float | None], at: int, floor: int = 0) -> float | None:
    for i in range(at, floor - 1, -1):
        if index[i] is not None:
            return index[i]
    return None


def month_ends(dates: Sequence[date]) -> list[int]:
    """Positions of the month ends inside ``dates`` plus the last day."""
    out = [i for i, d in enumerate(dates) if d.day == calendar.monthrange(d.year, d.month)[1]]
    if not out or out[-1] != len(dates) - 1:
        out.append(len(dates) - 1)
    return out


@dataclass(frozen=True, slots=True)
class RollingPoint:
    date: date
    portfolio: float
    benchmark: float | None
    excess: float | None


def rolling(
    dates: Sequence[date],
    combined: Combined,
    twr_full: Sequence[float | None],
    bench_full: Sequence[float | None] | None,
    months: int,
    *,
    from_date: date | None = None,
) -> list[RollingPoint]:
    """Rolling ``months`` windows ending at month ends on/after ``from_date``."""
    out: list[RollingPoint] = []
    for i in month_ends(dates):
        end_day = dates[i]
        if from_date is not None and end_day < from_date:
            continue
        start_day = months_back(end_day, months)
        if start_day < dates[0]:
            continue
        j = (start_day - dates[0]).days
        if combined.values[j] <= returns.CAPITAL_EPSILON:
            continue  # nothing invested at the window start
        a, b = _last_known(twr_full, j), _last_known(twr_full, i, j)
        if a is None or b is None or a <= 0:
            continue
        portfolio = b / a - 1
        bench = None
        if bench_full is not None:
            ba, bb = _last_known(bench_full, j), _last_known(bench_full, i, j)
            if ba is not None and bb is not None and ba > 0:
                bench = bb / ba - 1
        out.append(
            RollingPoint(end_day, portfolio, bench, None if bench is None else portfolio - bench)
        )
    return out


def rolling_summary(points: Sequence[RollingPoint]) -> dict:
    excess = [p.excess for p in points if p.excess is not None]
    return {
        "windows": len(points),
        "latest": None if not points else points[-1],
        "min_excess": min(excess) if excess else None,
        "max_excess": max(excess) if excess else None,
        "share_outperforming": (sum(1 for e in excess if e > 0) / len(excess)) if excess else None,
    }


@dataclass(frozen=True, slots=True)
class YearReturn:
    year: int
    portfolio: float | None
    benchmark: float | None
    partial: bool
    """The year is not whole inside the history (first or current year)."""


def per_year(
    dates: Sequence[date],
    twr_full: Sequence[float | None],
    bench_full: Sequence[float | None] | None,
) -> list[YearReturn]:
    out: list[YearReturn] = []
    for year in range(dates[1].year if len(dates) > 1 else dates[0].year, dates[-1].year + 1):
        base_day = max(date(year - 1, 12, 31), dates[0])
        end_day = min(date(year, 12, 31), dates[-1])
        j, i = (base_day - dates[0]).days, (end_day - dates[0]).days
        a, b = _last_known(twr_full, j), _last_known(twr_full, i, j)
        portfolio = None if a is None or b is None or a <= 0 else b / a - 1
        bench = None
        if bench_full is not None:
            ba = next((bench_full[k] for k in range(j, i + 1) if bench_full[k] is not None), None)
            bb = _last_known(bench_full, i, j)
            if ba is not None and bb is not None and ba > 0:
                bench = bb / ba - 1
        partial = base_day != date(year - 1, 12, 31) or end_day != date(year, 12, 31)
        out.append(YearReturn(year, portfolio, bench, partial))
    return out
