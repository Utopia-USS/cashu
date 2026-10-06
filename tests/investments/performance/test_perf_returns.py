"""Return math with hand-computed results: TWR with deposits / withdrawals / incomplete days, XIRR,
drawdowns, annualizing."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.modules.investments.performance import returns

D0 = dt.date(2025, 1, 1)


def dates(n: int) -> list[dt.date]:
    return [D0 + dt.timedelta(days=i) for i in range(n)]


def test_twr_ignores_deposits():
    # 1000 in (no capital before: 0 %), +10 %, then +10 % again and 500 more at the end of that day:
    # (1710 - 500) / 1100 = 1.1
    index = returns.twr_index([0, 1000, 1100, 1710, 1710], [0, 1000, 0, 500, 0], [True] * 5)
    assert index == pytest.approx([1.0, 1.0, 1.1, 1.21, 1.21])
    assert returns.period_return(index) == pytest.approx(0.21)


def test_twr_withdrawal_and_empty_account():
    # 600 out at the start of a flat day: no return; everything out, later 500 in, +10 %
    index = returns.twr_index(
        [1000, 1200, 600, 0, 0, 500, 550],
        [0, 0, -600, -600, 0, 500, 0],
        [True] * 7,
    )
    assert index == pytest.approx([1.0, 1.2, 1.2, 1.2, 1.2, 1.2, 1.32])


def test_twr_links_over_incomplete_days():
    # the flow of the unvalued day carries to the next valued one: 1650 / (1100 + 500)
    index = returns.twr_index([1000, 1100, 999, 1650], [0, 0, 500, 0], [True, True, False, True])
    assert index[2] is None
    assert index[3] == pytest.approx(1.1 * 1650 / 1600)


def test_twr_first_complete_point_is_the_base():
    index = returns.twr_index([5, 1000, 1100], [0, 0, 0], [False, True, True])
    assert index == [None, 1.0, pytest.approx(1.1)]


def test_xirr_one_year():
    solved = returns.xirr([(D0, -1000.0), (D0 + dt.timedelta(days=365), 1100.0)])
    assert solved is not None
    assert solved.annual == pytest.approx(0.10, abs=1e-9)
    assert solved.period == pytest.approx(0.10, abs=1e-9)


def test_xirr_two_deposits():
    # 1000 on day 0, 1000 on day 182, 2200 back on day 365. By hand (r = 13.47 %):
    # 1000 * 1.1347 + 1000 * 1.1347 ** (183 / 365) = 1134.7 + 1065.3 = 2200.0
    flows = [
        (D0, -1000.0),
        (D0 + dt.timedelta(days=182), -1000.0),
        (D0 + dt.timedelta(days=365), 2200.0),
    ]
    solved = returns.xirr(flows)
    assert solved is not None
    r = solved.annual
    assert r == pytest.approx(0.1347, abs=2e-4)
    npv = -1000 - 1000 / (1 + r) ** (182 / 365) + 2200 / (1 + r)
    assert npv == pytest.approx(0, abs=1e-6)


def test_xirr_short_span_is_not_annualized():
    solved = returns.xirr([(D0, -1000.0), (D0 + dt.timedelta(days=30), 1050.0)])
    assert solved is not None
    assert solved.annual is None
    assert solved.period == pytest.approx(0.05, abs=1e-9)


def test_xirr_needs_both_signs():
    assert returns.xirr([(D0, -1000.0), (D0 + dt.timedelta(days=30), -5.0)]) is None
    assert returns.xirr([]) is None


def test_max_drawdown_with_recovery():
    ds = dates(5)
    dd = returns.max_drawdown(ds, [1.0, 1.2, 0.9, 1.0, 1.25])
    assert dd.depth == pytest.approx(-0.25)
    assert (dd.peak, dd.trough, dd.recovered) == (ds[1], ds[2], ds[4])
    series = returns.drawdown_series([1.0, 1.2, 0.9, None, 1.25])
    assert series[:3] == pytest.approx([0.0, 0.0, -0.25])
    assert series[3] is None and series[4] == 0.0


def test_max_drawdown_not_recovered_and_flat():
    ds = dates(4)
    dd = returns.max_drawdown(ds, [1.0, None, 0.8, 0.9])
    assert dd.depth == pytest.approx(-0.2)
    assert dd.recovered is None
    assert returns.max_drawdown(ds, [1.0, 1.0, 1.1, 1.2]).depth == 0.0


def test_annualized():
    assert returns.annualized(0.21, 730) == pytest.approx(0.1)
    assert returns.annualized(0.1, 100) is None
    assert returns.annualized(None, 800) is None
