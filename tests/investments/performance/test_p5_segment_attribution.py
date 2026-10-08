"""Segment attribution (P5), pure and hand-computed: a PLN stock, a USD ETF and a USD crypto holding
with an FX move, a holding without a segment (with a stale close), a cost-valued holding and cash in
T0, a position opened within the window; contributions add up to ``explained``; T0 = 0 is empty."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from perf_support import PLN, USD, bars, day, rates

from cashu.modules.investments.performance.segment_attribution import (
    StartHolding,
    StartPortfolio,
    attribute_segments,
    close_on_or_before,
)
from cashu.modules.investments.portfolio import InMemoryFxLookup

START, END = day("2026-10-01"), day("2026-10-08")
SEGMENTS = {"A": "equity_pl", "B": "gold", "C": "crypto", "E": "bonds"}
FX = InMemoryFxLookup(rates(USD, {"2026-10-01": "4.0", "2026-10-08": "4.2"}))


def portfolio() -> StartPortfolio:
    # T0 = 4000 (A) + 2000 (B: 10 x 50 USD x 4.0) + 1000 (C: 0.01 x 25000 USD x 4.0) + 500 (D)
    #      + 1500 (E, valued at cost) + 1000 cash = 10000
    return StartPortfolio(
        Decimal(10000),
        (
            StartHolding("A", PLN, Decimal(3000)),
            StartHolding("A", PLN, Decimal(1000)),  # a second account: summed
            StartHolding("B", USD, Decimal(2000)),
            StartHolding("C", USD, Decimal(1000)),
            StartHolding("D", PLN, Decimal(500)),
            StartHolding("E", PLN, Decimal(1500), market=False),
        ),
    )


PRICES = {
    "A": bars("A", {"2026-09-30": 100, "2026-10-08": 110}),  # +10 %
    "B": bars("B", {"2026-10-01": 50, "2026-10-07": 45}),  # -10 % in USD
    "C": bars("C", {"2026-10-01": 25000, "2026-10-08": 30000}),  # +20 % in USD
    "D": bars("D", {"2026-10-01": 10, "2026-10-02": 9}),  # -10 %, last close 6 days old: stale
    "E": bars("E", {"2026-10-01": 100, "2026-10-08": 200}),  # cost-valued: never attributed
}


def run(total=None, **kw):
    start = portfolio() if total is None else StartPortfolio(Decimal(total), portfolio().holdings)
    return attribute_segments(
        start, PRICES, FX, PLN, START, END, SEGMENTS.get, held_at_end={"A", "B", "F"}, **kw
    )


def test_hand_computed_example():
    result = run()
    rows = {m.segment: m for m in result.segments}
    assert [m.segment for m in result.segments] == ["equity_pl", "crypto", "gold", "bonds"]
    assert rows["equity_pl"].contribution == pytest.approx(4000 * 0.10 / 10000)
    assert rows["equity_pl"].weight == pytest.approx(0.4)
    assert rows["equity_pl"].ret == pytest.approx(0.10)
    assert rows["gold"].contribution == pytest.approx(2000 * -0.10 / 10000)
    assert rows["gold"].weight == pytest.approx(0.2) and rows["gold"].ret == pytest.approx(-0.1)
    assert rows["crypto"].contribution == pytest.approx(1000 * 0.20 / 10000)
    (b,) = rows["gold"].instruments
    assert (b.instrument_id, b.contribution, b.ret) == ("B", pytest.approx(-0.02), -0.1)
    # E is valued at cost: its weight shows, it contributes 0 and has no market return
    bonds = rows["bonds"]
    assert (bonds.weight, bonds.contribution, bonds.ret) == (pytest.approx(0.15), 0.0, None)
    (e,) = bonds.instruments
    assert (e.instrument_id, e.contribution, e.ret) == ("E", 0.0, None)
    assert result.unassigned is not None and result.unassigned.segment is None
    assert result.unassigned.contribution == pytest.approx(500 * -0.10 / 10000)
    assert result.unassigned.weight == pytest.approx(0.05)
    # currency: B 2000 x (0.9 x 1.05 - 1 - (-0.1)) + C 1000 x (1.2 x 1.05 - 1 - 0.2)
    assert result.currency_contribution == pytest.approx((2000 * 0.045 + 1000 * 0.06) / 10000)
    (usd,) = result.currencies
    assert usd.currency == "USD" and usd.weight == pytest.approx(0.3)
    assert usd.ret == pytest.approx(0.05) and usd.contribution == pytest.approx(0.015)
    parts = sum(m.contribution for m in result.segments) + result.unassigned.contribution
    assert result.explained == pytest.approx(parts + result.currency_contribution)
    assert result.explained == pytest.approx(0.05)
    assert result.new_positions == 1  # F opened within the window
    assert result.stale == ("D",)


def test_instruments_sorted_by_absolute_contribution():
    segments = {"A": "equity_pl", "B": "equity_pl", "C": "equity_pl", "D": "equity_pl"}
    result = attribute_segments(portfolio(), PRICES, FX, PLN, START, END, segments.get)
    (row,) = result.segments
    assert [m.instrument_id for m in row.instruments] == ["A", "B", "C", "D"]  # ties by id
    assert row.ret == pytest.approx((400 - 200 + 200 - 50) / 7500)
    assert row.weight == pytest.approx(0.75)
    # without a segment the cost-valued holding is unassigned weight
    assert result.unassigned.weight == pytest.approx(0.15)
    assert result.unassigned.contribution == 0.0 and result.unassigned.ret is None


def test_zero_or_negative_total_is_empty():
    for total in (0, -5):
        result = run(total=total)
        assert result.empty and result.explained == 0 and result.currency_contribution == 0
        assert result.new_positions == 1


def test_missing_closes_count_as_no_move_and_are_flagged():
    prices = {**PRICES, "A": bars("A", {"2026-10-05": 100})}
    result = attribute_segments(
        portfolio(), prices, FX, PLN, START, END, SEGMENTS.get, max_price_age_days=5
    )
    rows = {m.segment: m for m in result.segments}
    assert rows["equity_pl"].contribution == 0 and "A" in result.stale
    missing_fx = attribute_segments(
        portfolio(), PRICES, InMemoryFxLookup([]), PLN, START, END, SEGMENTS.get
    )
    assert missing_fx.currency_contribution == 0


def test_close_on_or_before():
    series = bars("X", {"2026-10-01": 1, "2026-10-03": 2})
    assert close_on_or_before(series, day("2026-09-30")) is None
    assert close_on_or_before(series, day("2026-10-02")).close == 1
    assert close_on_or_before(series, dt.date(2026, 10, 9)).close == 2


def test_held_at_start_is_never_new_and_unvalued_or_stale_holdings_are_flagged():
    base = portfolio()
    start = StartPortfolio(
        base.total_base,
        (*base.holdings[:4], StartHolding("D", PLN, Decimal(500), stale=True)),
        unvalued=("G",),
        held=("A", "B", "C", "D", "E", "G", "H"),
    )
    result = attribute_segments(
        start, PRICES, FX, PLN, START, END, SEGMENTS.get, held_at_end={"G", "H", "F"}
    )
    assert result.new_positions == 1  # only F; G (unvalued) and H (cash-like) were held
    assert set(result.stale) == {"D", "G"}
    assert "G" not in {m.instrument_id for row in result.segments for m in row.instruments}


def test_no_negative_zero():
    flat = {k: bars(k, {"2026-10-01": 1, "2026-10-08": 1}) for k in "ABCDE"}
    result = attribute_segments(
        portfolio(), flat, InMemoryFxLookup([]), PLN, START, END, lambda _: "gold"
    )
    (row,) = result.segments
    assert str(row.contribution) == "0.0" and str(result.explained) == "0.0"
