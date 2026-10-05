"""Benchmark prices in the base currency and the same-cash-flow simulation, hand-computed."""

from __future__ import annotations

import pytest
from perf_support import EUR, PLN, bars, days, rates

from finanse.modules.investments.performance.benchmark import (
    benchmark_prices,
    price_index,
    simulate,
)
from finanse.modules.investments.portfolio import InMemoryFxLookup


def test_proxy_prices_converted_and_aged():
    ds = days("2025-01-02", "2025-01-12")
    fx = InMemoryFxLookup(rates(EUR, {"2025-01-02": "4.0", "2025-01-03": "4.1"}))
    proxy = bars("P", {"2025-01-02": 50, "2025-01-03": 51})
    out = benchmark_prices(ds, proxy, EUR, fx, PLN, max_price_age_days=5, max_fx_age_days=7)
    assert out[0] == pytest.approx(200.0)  # 50 * 4.0
    assert out[1] == pytest.approx(209.1)  # 51 * 4.1
    assert out[6] == pytest.approx(209.1)  # 01-08: the 01-03 close is 5 days old, still usable
    assert out[7] is None  # 01-09: 6 days old
    # the FX rate ages too: a fresh close with an 8-day-old rate is unusable
    late = benchmark_prices(
        days("2025-01-11", "2025-01-11"),
        bars("P", {"2025-01-11": 52}),
        EUR,
        fx,
        PLN,
        max_price_age_days=5,
        max_fx_age_days=7,
    )
    assert late == [None]


def test_price_index_starts_at_the_first_known_price():
    assert price_index([None, 200.0, 220.0, None, 250.0]) == [None, 1.0, 1.1, None, 1.25]


def test_same_cash_flow_simulation():
    # start value 1000 at price 100 = 10 units; flat; 1100 deposited at 110 = 10 more units; then 121
    ds = days("2025-01-01", "2025-01-04")
    sim = simulate(ds, [100.0, 100.0, 110.0, 121.0], 1000.0, [0.0, 0.0, 1100.0, 0.0])
    assert sim.values == pytest.approx([1000.0, 1000.0, 2200.0, 2420.0])
    assert sim.started == ds[0] and not sim.capped


def test_simulation_with_fees_sells_units():
    ds = days("2025-01-01", "2025-01-03")
    sim = simulate(ds, [100.0, 100.0, 200.0], 1000.0, [0.0, 0.0, 0.0], [0.0, 10.0, 0.0])
    assert sim.values == pytest.approx([1000.0, 1000.0, 2000.0])
    assert sim.with_fees == pytest.approx([1000.0, 990.0, 1980.0])  # 9.9 units at 200


def test_simulation_waits_for_the_first_price_and_caps_withdrawals():
    ds = days("2025-01-01", "2025-01-05")
    sim = simulate(ds, [None, None, 50.0, 50.0, 100.0], 0.0, [0.0, 500.0, 0.0, -1000.0, 0.0])
    # the 01-02 deposit waits for 01-03 (10 units); the 1000 withdrawal empties them
    assert sim.values == [None, None, pytest.approx(500.0), 0.0, 0.0]
    assert sim.started == ds[2] and sim.capped
