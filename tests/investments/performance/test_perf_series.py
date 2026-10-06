"""Daily value / flow series with hand-computed values: deposits and FX, a split, a sale, a split the
history never booked (inferred scale), units moved in and out, implied funding, incomplete days, and
the incremental snapshots against ``build_snapshot`` / ``value_portfolio``."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from perf_support import EUR, PLN, USD, bars, day, days, instrument, rates, txn

from cashu.modules.investments.domain import (
    AssetClass,
    InstrumentRename,
    MarketView,
    ValuationMode,
)
from cashu.modules.investments.performance import report, returns
from cashu.modules.investments.performance.series import (
    SnapshotStream,
    ValuationPolicy,
    build_series,
)
from cashu.modules.investments.portfolio import (
    InMemoryFxLookup,
    build_snapshot,
    value_portfolio,
)


def series_of(txns, insts, bar_map, fx=(), end="2025-01-05", **kw):
    return build_series(
        txns,
        instruments={i.id: i for i in insts},
        bars=bar_map,
        fx=InMemoryFxLookup(list(fx)),
        base=PLN,
        end=day(end),
        **kw,
    )


def values(series, account_ids=None) -> list[float]:
    return series.combined(account_ids).values


def twr(series) -> float:
    c = series.combined()
    return returns.period_return(returns.twr_index(c.values, c.flows, c.complete))


def test_deposit_and_a_usd_holding_valued_at_daily_fx():
    # 10 000 PLN in; 10 X bought at 100 USD for 4 000 PLN (rate 4.0). Next day X = 110 USD at 4.2:
    # 6 000 cash + 10 * 110 * 4.2 = 10 620.
    txns = [
        txn("deposit", "2025-01-02", "10000"),
        txn(
            "buy",
            "2025-01-02",
            "-4000",
            instrument="X",
            quantity="10",
            price="100",
            currency=USD,
            cash_currency=PLN,
        ),
    ]
    s = series_of(
        txns,
        [instrument("X", USD)],
        {"X": bars("X", {"2025-01-02": 100, "2025-01-03": 110})},
        rates(USD, {"2025-01-02": "4.0", "2025-01-03": "4.2"}),
        end="2025-01-03",
    )
    assert s.dates == days("2025-01-01", "2025-01-03")
    assert values(s) == pytest.approx([0, 10000, 10620])
    assert s.combined().flows == pytest.approx([0, 10000, 0])
    assert twr(s) == pytest.approx(0.062)


def test_split_keeps_the_series_continuous():
    # The source serves split-adjusted closes (a 4:1 split on 01-04: 100 before = 25 adjusted).
    # 10 units before the split are valued at 25 * 4; 40 after it at the plain close.
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn("buy", "2025-01-02", "-1000", instrument="S", quantity="10", price="100"),
        txn("split", "2025-01-04", instrument="S", ratio="4"),
    ]
    adjusted = {"2025-01-02": 25, "2025-01-03": 27.5, "2025-01-04": 27.5, "2025-01-05": 30}
    s = series_of(txns, [instrument("S")], {"S": bars("S", adjusted)})
    assert values(s) == pytest.approx([0, 1000, 1100, 1100, 1200])
    assert twr(s) == pytest.approx(0.2)
    assert s.price_scales == ()  # the trade price matched the split-adjusted close x 4


def test_sale_and_cash_afterwards():
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn("buy", "2025-01-02", "-1000", instrument="A", quantity="10", price="100"),
        txn("sell", "2025-01-04", "1200", instrument="A", quantity="10", price="120"),
    ]
    closes = {"2025-01-02": 100, "2025-01-03": 105, "2025-01-04": 120, "2025-01-05": 130}
    s = series_of(txns, [instrument("A")], {"A": bars("A", closes)})
    assert values(s) == pytest.approx([0, 1000, 1050, 1200, 1200])
    assert twr(s) == pytest.approx(0.2)
    metrics = report.compute_range("max", s.dates, s.combined(), None)
    assert metrics.summary["pnl"] == pytest.approx(200)
    assert metrics.summary["net_contributions"] == pytest.approx(1000)


def test_split_the_history_never_booked_is_inferred_from_trades():
    # Held 01-02..01-03, sold; a 2:1 split later (not in the history) halved every stored close.
    # Trade prices are exactly twice the closes: the closes up to the sale are scaled by 2.
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn("buy", "2025-01-02", "-1000", instrument="B", quantity="10", price="100"),
        txn("sell", "2025-01-03", "1100", instrument="B", quantity="10", price="110"),
    ]
    adjusted = {"2025-01-02": 50, "2025-01-03": 55, "2025-01-10": 60}
    s = series_of(txns, [instrument("B")], {"B": bars("B", adjusted)}, end="2025-01-04")
    assert values(s) == pytest.approx([0, 1000, 1100, 1100])
    assert twr(s) == pytest.approx(0.1)
    assert [(p.until, p.factor) for p in s.price_scales] == [
        (day("2025-01-02"), 2),
        (day("2025-01-03"), 2),
    ]


def test_off_scale_trade_without_a_clean_multiple_is_reported():
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn("buy", "2025-01-02", "-1000", instrument="C", quantity="10", price="100"),
    ]
    s = series_of(txns, [instrument("C")], {"C": bars("C", {"2025-01-02": 62})}, end="2025-01-02")
    assert s.price_scales == ()
    assert len(s.price_mismatches) == 1 and s.price_mismatches[0].instrument_id == "C"


def test_units_moved_in_and_out_are_flows_at_that_days_value():
    # Flows come at the end of their day: units in at that day's close (100, they earn nothing that
    # day), units out at that day's close (120, the day's move from 110 is still ours).
    txns = [
        txn("transfer_in", "2025-01-02", instrument="T", quantity="10", tid="in"),
        txn("transfer_out", "2025-01-04", instrument="T", quantity="10", tid="out"),
    ]
    closes = {"2025-01-01": 99, "2025-01-02": 100, "2025-01-03": 110, "2025-01-04": 120}
    s = series_of(txns, [instrument("T")], {"T": bars("T", closes)})
    c = s.combined()
    assert c.values == pytest.approx([0, 1000, 1100, 0, 0])
    assert c.flows == pytest.approx([0, 1000, 0, -1200, 0])
    assert twr(s) == pytest.approx(0.2)
    assert s.txn_values == {"in": Decimal(1000), "out": Decimal(1200)}


def test_adjustment_adds_units_at_the_days_value():
    txns = [txn("adjustment", "2025-01-02", instrument="T", quantity="10", price="1", tid="adj")]
    s = series_of(txns, [instrument("T")], {"T": bars("T", {"2025-01-02": 100})}, end="2025-01-02")
    assert s.combined().flows == pytest.approx([0, 1000])
    assert s.txn_values == {"adj": Decimal(1000)}


def test_buy_without_its_deposit_is_implied_funding():
    # Cash goes to -1000 (counted as 0): the bought units are money from outside the history. The
    # deposit that later fills the hole is not new money (implied -1000, deposit +1000).
    txns = [
        txn("buy", "2025-01-02", "-1000", instrument="A", quantity="10", price="100"),
        txn("deposit", "2025-01-03", "1000"),
    ]
    s = series_of(
        txns,
        [instrument("A")],
        {"A": bars("A", {"2025-01-02": 100, "2025-01-03": 110})},
        end="2025-01-03",
    )
    c = s.combined()
    assert c.values == pytest.approx([0, 1000, 1100])
    assert c.flows == pytest.approx([0, 1000, 0])
    assert c.implied == pytest.approx([0, 1000, -1000])
    assert twr(s) == pytest.approx(0.1)


def test_negative_cash_then_deposit_covering_it():
    txns = [
        txn("buy", "2025-01-02", "-1000", instrument="A", quantity="10", price="100"),
        txn("deposit", "2025-01-04", "1500"),
    ]
    s = series_of(
        txns,
        [instrument("A")],
        {"A": bars("A", {"2025-01-02": 100, "2025-01-03": 110, "2025-01-04": 110})},
        end="2025-01-04",
    )
    c = s.combined()
    # after the deposit cash is +500: value 1100 + 500; flows: deposit 1500, implied -1000
    assert c.values == pytest.approx([0, 1000, 1100, 1600])
    assert c.flows == pytest.approx([0, 1000, 0, 500])
    assert twr(s) == pytest.approx(0.1)


def test_missing_fx_makes_days_incomplete_and_returns_link_over_them():
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn(
            "buy",
            "2025-01-02",
            "-1000",
            instrument="U",
            quantity="10",
            price="25",
            currency=USD,
            cash_currency=PLN,
        ),
    ]
    closes = {"2025-01-02": 25, "2025-01-03": 25, "2025-01-04": 26, "2025-01-05": 27.5}
    s = series_of(
        txns,
        [instrument("U", USD)],
        {"U": bars("U", closes)},
        rates(USD, {"2025-01-05": "4.0"}),  # nothing before 01-05
    )
    c = s.combined()
    assert c.complete == [True, False, False, False, True]
    assert c.values[-1] == pytest.approx(1100)
    # capital 1000 (the deposit, carried over the unvalued days) grew to 1100
    assert twr(s) == pytest.approx(0.1)


def test_stale_fx_beyond_the_limit_is_incomplete():
    txns = [
        txn("deposit", "2025-01-02", "100", currency=EUR),
    ]
    s = series_of(
        txns,
        [],
        {},
        rates(EUR, {"2025-01-01": "4.3"}),
        end="2025-01-20",
        policy=ValuationPolicy(max_price_age_days=5, max_fx_age_days=10),
    )
    c = s.combined()
    assert c.values[1] == pytest.approx(430) and c.complete[1]
    assert c.complete[10] and not c.complete[11]  # on 01-11 the rate is 10 days old, then 11


def test_cost_mode_holding_keeps_its_lots_and_is_valued_at_cost():
    bond = instrument("BOND", PLN, AssetClass.TREASURY_BOND)
    assert bond.valuation_mode == ValuationMode.COST
    txns = [
        txn("deposit", "2025-01-02", "1000"),
        txn("buy", "2025-01-02", "-1000", instrument="BOND", quantity="10", price="100"),
    ]
    s = series_of(txns, [bond], {}, end="2025-01-03")
    assert values(s) == pytest.approx([0, 1000, 1000])
    assert all(s.combined().complete)


# --------------------------------------------------------------------------- #
# Incremental snapshots == build_snapshot; series value == the public pipeline
# --------------------------------------------------------------------------- #


def _mixed_history():
    txns = [
        txn("deposit", "2025-01-02", "20000", account="1"),
        txn("deposit", "2025-01-02", "5000", account="2"),
        txn("buy", "2025-01-03", "-3000", account="1", instrument="A", quantity="30", price="100"),
        txn(
            "buy",
            "2025-01-03",
            "-4300",
            account="1",
            instrument="E",
            quantity="10",
            price="100",
            currency=EUR,
            cash_currency=PLN,
        ),
        txn("buy", "2025-01-06", "-1000", account="2", instrument="A", quantity="10", price="100"),
        txn("buy", "2025-01-08", "-1500", account="1", instrument="A", quantity="12", price="125"),
        txn("sell", "2025-01-10", "1400", account="1", instrument="A", quantity="10", price="140"),
        txn("dividend", "2025-01-12", "50", account="1", instrument="E"),
        txn("fee", "2025-01-13", "-7", account="2"),
        txn(
            "buy", "2025-01-14", "-1000", account="2", instrument="BOND", quantity="10", price="100"
        ),
        txn(
            "sell", "2025-01-20", "4200", account="1", instrument="A", quantity="32", price="131.25"
        ),
        txn("buy", "2025-01-21", "-600", account="1", instrument="OLD", quantity="6", price="100"),
        txn("transfer_out", "2025-01-24", account="2", instrument="A", quantity="4"),
    ]
    renames = [InstrumentRename(day("2025-01-23"), "OLD", "NEW")]
    insts = [
        instrument("A"),
        instrument("E", EUR),
        instrument("BOND", PLN, AssetClass.TREASURY_BOND),
        instrument("OLD"),
        instrument("NEW"),
    ]
    a = {d.isoformat(): 100 + i for i, d in enumerate(days("2025-01-01", "2025-01-31"))}
    e = {d.isoformat(): 100 + i * 0.5 for i, d in enumerate(days("2025-01-01", "2025-01-31"))}
    n = {d.isoformat(): 90 + i for i, d in enumerate(days("2025-01-22", "2025-01-31"))}
    o = {d.isoformat(): 100 for d in days("2025-01-20", "2025-01-22")}
    bar_map = {"A": bars("A", a), "E": bars("E", e), "NEW": bars("NEW", n), "OLD": bars("OLD", o)}
    fx = rates(
        EUR,
        {d.isoformat(): str(4.3 + i / 100) for i, d in enumerate(days("2024-12-30", "2025-01-31"))},
    )
    return txns, renames, insts, bar_map, fx


def test_snapshot_stream_equals_build_snapshot_on_every_day():
    txns, renames, *_ = _mixed_history()
    stream = SnapshotStream(sorted(txns, key=lambda t: (t.trade_date, t.id)), renames)
    for d in days("2025-01-01", "2025-01-31"):
        stream.advance(d)
        expected = build_snapshot("", txns, d, renames=renames)
        got = stream.snapshot
        assert [(h.account_id, h.instrument_id, h.quantity, h.lots) for h in got.holdings] == [
            (h.account_id, h.instrument_id, h.quantity, h.lots) for h in expected.holdings
        ], d
        assert got.cash == expected.cash, d


def test_series_value_equals_the_public_pipeline_every_day():
    txns, renames, insts, bar_map, fx_rates = _mixed_history()
    fx = InMemoryFxLookup(fx_rates)
    instruments = {i.id: i for i in insts}
    s = build_series(
        txns,
        instruments=instruments,
        bars=bar_map,
        fx=fx,
        base=PLN,
        end=day("2025-01-31"),
        renames=renames,
    )
    for i, d in enumerate(s.dates):
        snapshot = build_snapshot("", txns, d, renames=renames)
        view = MarketView(
            as_of=d,
            instruments=instruments,
            bars={k: tuple(b for b in v if b.date <= d) for k, v in bar_map.items()},
        )
        valued = value_portfolio(snapshot, view, fx, PLN, 5)
        for account in ("1", "2"):
            expected = sum(
                (
                    v.market_value_base
                    for v in valued.valued
                    if v.account_id == account and v.market_value_base is not None
                ),
                Decimal(0),
            ) + sum((c.counted_base for c in valued.cash if c.account_id == account), Decimal(0))
            assert s.accounts[account].values[i] == expected, (d, account)
    # the transfer out of account 2 is a withdrawal at that day's close of A
    close_a = float(bar_map["A"][23].close)
    assert s.accounts["2"].flows[s.index_of(day("2025-01-24"))] == pytest.approx(-4 * close_a)


def test_captures_hold_per_holding_values():
    txns, renames, insts, bar_map, fx_rates = _mixed_history()
    end = day("2025-01-31")
    s = build_series(
        txns,
        instruments={i.id: i for i in insts},
        bars=bar_map,
        fx=InMemoryFxLookup(fx_rates),
        base=PLN,
        end=end,
        renames=renames,
        capture_dates={end, day("2025-01-09")},
    )
    at_end = s.captures[end]
    assert ("1", "NEW") in at_end and ("1", "OLD") not in at_end  # the rename carried the lot
    assert at_end[("2", "BOND")] == Decimal(1000)  # at cost
    assert s.captures[day("2025-01-09")][("1", "A")] == Decimal(42) * bar_map["A"][8].close


def test_empty_history():
    s = series_of([], [], {}, end="2025-01-05")
    assert s.dates == [dt.date(2025, 1, 5)] and s.accounts == {}
