"""Range metrics: range base days, a portfolio that is exactly the benchmark (same TWR, zero excess),
rolling windows, calendar years, chart sampling."""

from __future__ import annotations

import datetime as dt
import itertools

import pytest
from perf_support import day, days

from finanse.modules.investments.performance import report
from finanse.modules.investments.performance.series import Combined
from finanse.modules.investments.performance.service import sample


def combined(values, flows=None, complete=None) -> Combined:
    n = len(values)
    return Combined(
        values=list(values),
        flows=list(flows or [0.0] * n),
        fees=[0.0] * n,
        complete=list(complete or [True] * n),
        implied=[0.0] * n,
    )


@pytest.mark.parametrize(
    ("key", "end", "expected"),
    [
        ("1m", "2026-03-31", "2026-02-28"),
        ("3m", "2026-03-31", "2025-12-31"),
        ("ytd", "2026-03-31", "2025-12-31"),
        ("1y", "2026-03-31", "2025-03-31"),
        ("3y", "2026-03-31", "2024-06-30"),  # clamped to the series start
        ("max", "2026-03-31", "2024-06-30"),
    ],
)
def test_range_base(key, end, expected):
    assert report.range_base(key, day(end), day("2024-06-30")) == day(expected)


def test_one_year_back_from_a_leap_day():
    assert report.range_base("1y", day("2024-02-29"), day("2020-01-01")) == day("2023-02-28")


def test_unknown_range():
    with pytest.raises(ValueError, match="unknown range"):
        report.range_base("5y", day("2026-01-01"), day("2025-01-01"))


def test_portfolio_that_is_the_benchmark_has_zero_excess():
    # 10 units at 100; 1100 deposited and invested at the 110 close; 121 at the end
    ds = days("2025-01-01", "2025-01-04")
    c = combined([1000.0, 1000.0, 2200.0, 2420.0], [0.0, 0.0, 1100.0, 0.0])
    m = report.compute_range("max", ds, c, [100.0, 100.0, 110.0, 121.0])
    s, b = m.summary, m.benchmark
    assert s["twr"] == pytest.approx(0.21) and b["twr"] == pytest.approx(0.21)
    assert b["excess_twr"] == pytest.approx(0.0, abs=1e-12)
    assert m.simulation.values == pytest.approx(c.values)
    assert b["excess_value"] == pytest.approx(0.0) and b["excess_vs_simulation"] == pytest.approx(
        0.0
    )
    assert s["pnl"] == pytest.approx(320.0) and b["simulation_pnl"] == pytest.approx(320.0)
    assert s["mwr"] == pytest.approx(b["simulation_mwr"])
    assert s["xirr"] is None  # four days are not annualized
    assert b["covers_range"] and b["first_priced"] == ds[0]


def test_benchmark_beats_a_flat_portfolio():
    ds = days("2025-01-01", "2025-01-03")
    c = combined([1000.0, 1000.0, 1000.0])
    m = report.compute_range("max", ds, c, [None, 100.0, 120.0])
    b = m.benchmark
    assert b["twr"] == pytest.approx(0.2)
    assert not b["covers_range"]
    assert b["simulation_end_value"] == pytest.approx(1200.0)  # invested at the first price
    assert b["excess_value"] == pytest.approx(-200.0)
    assert b["max_drawdown"].depth == 0.0


def _growth(start: str, end: str, daily: float, base: float) -> list[float]:
    return [base * daily**i for i in range(len(days(start, end)))]


def test_rolling_windows_and_calendar_years():
    ds = days("2023-01-01", "2025-03-31")
    c = combined(_growth("2023-01-01", "2025-03-31", 1.0002, 1000.0))
    bench = _growth("2023-01-01", "2025-03-31", 1.0001, 100.0)
    twr = report.returns.twr_index(c.values, c.flows, c.complete)
    windows = report.rolling(ds, c, twr, bench, 12)
    first = windows[0]
    assert first.date == day("2024-01-31")  # the first month end with a full year behind it
    assert first.portfolio == pytest.approx(1.0002**365 - 1)
    assert first.benchmark == pytest.approx(1.0001**365 - 1)
    assert first.excess == pytest.approx(first.portfolio - first.benchmark)
    assert windows[-1].date == day("2025-03-31")
    summary = report.rolling_summary(windows)
    assert summary["windows"] == len(windows) == 15
    assert summary["share_outperforming"] == 1.0
    assert report.rolling(ds, c, twr, bench, 24)[0].date == day("2025-01-31")
    assert report.rolling(ds, c, twr, bench, 36) == []
    later = report.rolling(ds, c, twr, bench, 12, from_date=day("2025-01-01"))
    assert [w.date for w in later] == [day("2025-01-31"), day("2025-02-28"), day("2025-03-31")]

    years = report.per_year(ds, twr, bench)
    assert [(y.year, y.partial) for y in years] == [(2023, True), (2024, False), (2025, True)]
    assert years[1].portfolio == pytest.approx(1.0002**366 - 1)  # 2024 is a leap year
    assert years[1].benchmark == pytest.approx(1.0001**366 - 1)


def test_rolling_skips_windows_without_capital():
    ds = days("2024-01-01", "2025-02-28")
    values = [0.0] * 40 + [1000.0] * (len(ds) - 40)
    flows = [0.0] * 40 + [1000.0] + [0.0] * (len(ds) - 41)
    c = combined(values, flows)
    twr = report.returns.twr_index(c.values, c.flows, c.complete)
    windows = report.rolling(ds, c, twr, None, 12)
    # 2024-02-09 is the first funded day: the window ending 2025-01-31 starts on an empty account
    assert [w.date for w in windows] == [day("2025-02-28")]
    assert windows[0].benchmark is None and windows[0].excess is None


def test_sample():
    short = days("2025-01-01", "2025-12-31")
    assert sample(short) == ("day", list(range(len(short))))
    three = [dt.date(2022, 1, 1) + dt.timedelta(days=i) for i in range(1100)]
    step, picked = sample(three)
    assert step == "week" and picked[0] == 0 and picked[-1] == 1099
    assert all(b - a == 7 for a, b in itertools.pairwise(picked[1:]))
    long = [dt.date(2018, 1, 1) + dt.timedelta(days=i) for i in range(2500)]
    step, picked = sample(long)
    assert step == "month" and picked[0] == 0 and picked[-1] == 2499
    assert all(long[i].day in (28, 29, 30, 31) for i in picked[1:-1])
