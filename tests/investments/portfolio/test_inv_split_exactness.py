"""Splits are exact: ratios like 1:3 or 1:15 have no finite decimal, so they are read as fractions and lot
quantities are exact (regression: a 1:3 split left a 3.0E-19 HistoryGap on a later full sell)."""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

import pytest
from inv_portfolio_fixtures import (
    PLN,
    buy,
    d,
    day,
    new_id,
    sell,
    split,
    transfer_out,
)

from cashu.modules.investments.domain import DatedPrice, HistoryGap
from cashu.modules.investments.portfolio import (
    SPLIT_REMAINDER_TOLERANCE,
    build_snapshot,
    last_trade_prices,
    run_lots,
    split_fraction,
)

ACC = new_id()
OTHER = new_id()
X = new_id()

ONE_FOR_THREE = [
    "0.3333333333",  # 10 places
    "0.33333333333333333333",  # 20 places: the real broker history (3.0E-19 gap on 90 shares)
    "0.3333333333333333333333333333",  # Python's default 28-digit Decimal(1) / Decimal(3)
    "0.3333333333000",  # padded with zeros
]
ONE_FOR_FIFTEEN = ["0.0666666667", "0.0666666666"]  # rounded and truncated


def realized_pnl(result) -> Decimal:
    return sum((trade.pnl for trade in result.realized), Decimal(0))


# --- split_fraction -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("ratio", "expected"),
    [
        ("4", Fraction(4)),
        ("1.5", Fraction(3, 2)),
        ("0.5", Fraction(1, 2)),
        ("0.02", Fraction(1, 50)),
        ("0.0002", Fraction(1, 5000)),
        ("0.3333333333", Fraction(1, 3)),
        ("0.33333333333333333333", Fraction(1, 3)),
        ("0.3333333333000", Fraction(1, 3)),
        ("0.6666666667", Fraction(2, 3)),
        ("0.6666666666", Fraction(2, 3)),  # truncated
        ("0.0666666667", Fraction(1, 15)),
        ("2.3333333333", Fraction(7, 3)),
        ("0.0003333333", Fraction(1, 3000)),
        ("0.33333", Fraction(1, 3)),
    ],
)
def test_split_fraction_recovers_the_ratio_a_decimal_stands_for(ratio, expected):
    assert split_fraction(d(ratio)) == expected


@pytest.mark.parametrize(
    "ratio",
    [
        "0.3333",  # 3333/10000 is itself a simple enough fraction: taken as written
        "0.333",
        "1.0456723",  # no simple fraction within its last digit
        "0.0001428571",  # 1:7000 at 10 places: too few digits to tell 1/7000 apart
    ],
)
def test_split_fraction_keeps_other_decimals_exactly_as_written(ratio):
    assert split_fraction(d(ratio)) == Fraction(d(ratio))


# --- reverse splits -----------------------------------------------------------------------------


@pytest.mark.parametrize("ratio", ONE_FOR_THREE)
def test_one_for_three_reverse_split_then_full_sell_leaves_exactly_zero(ratio):
    txns = [
        buy(ACC, X, "2026-01-05", "90", "10"),  # cost 900
        split(ACC, X, "2026-02-02", ratio),  # 30 units at 30
    ]
    (lot,) = run_lots(txns).open_lots
    assert (lot.quantity, lot.unit_cost) == (d("30"), d("30"))

    result = run_lots([*txns, sell(ACC, X, "2026-03-02", "30", "35")])

    assert result.warnings == ()
    assert result.open_lots == ()
    (trade,) = result.realized
    assert (trade.quantity, trade.open_unit_cost, trade.pnl) == (d("30"), d("30"), d("150"))


def test_one_for_three_full_sell_leaves_an_empty_snapshot():
    txns = [
        buy(ACC, X, "2026-01-05", "90", "10"),
        split(ACC, X, "2026-02-02", "0.33333333333333333333"),
        sell(ACC, X, "2026-03-02", "30", "35"),
    ]
    snapshot = build_snapshot(new_id(), txns, day("2026-03-31"))
    assert snapshot.holdings == ()
    assert snapshot.warnings == ()


@pytest.mark.parametrize("ratio", ONE_FOR_FIFTEEN)
def test_chained_one_for_fifteen_and_one_for_fifty_with_cash_in_lieu_close_exactly(ratio):
    txns = [
        buy(ACC, X, "2026-01-05", "1002", "2"),  # cost 2004
        split(ACC, X, "2026-02-02", ratio),  # 66.8 units at 30
        sell(ACC, X, "2026-02-03", "0.8", "31"),  # cash in lieu: proceeds 24.8, cost 24
    ]
    assert [lot.quantity for lot in run_lots(txns).open_lots] == [d("66")]

    txns += [
        split(ACC, X, "2026-03-02", "0.02"),  # 1:50 -> 1.32 units at 1500
        sell(ACC, X, "2026-03-03", "0.32", "1600"),  # cash in lieu: proceeds 512, cost 480
    ]
    (lot,) = run_lots(txns).open_lots
    assert (lot.quantity, lot.unit_cost) == (d("1"), d("1500"))

    result = run_lots([*txns, sell(ACC, X, "2026-04-01", "1", "1600")])

    assert result.warnings == ()
    assert result.open_lots == ()
    assert [trade.pnl for trade in result.realized] == [d("0.8"), d("32"), d("100")]
    assert realized_pnl(result) == d("2136.8") - d("2004")  # all proceeds - all cost


def test_cash_in_lieu_of_a_fraction_with_no_finite_decimal_leaves_whole_shares():
    txns = [
        buy(ACC, X, "2026-01-05", "1000", "1"),  # cost 1000
        split(ACC, X, "2026-02-02", "0.0666666667"),  # 1:15 -> 200/3 units at 15
    ]
    (lot,) = run_lots(txns).open_lots
    assert lot.quantity == d("66.666666666666666667")  # reported with 20 significant digits
    assert lot.unit_cost == d("15")

    # The broker sells the fraction (2/3 unit) as a rounded decimal: the lot keeps exactly 66 units.
    txns.append(sell(ACC, X, "2026-02-03", "0.6666666667", "15"))
    result = run_lots(txns)
    (lot,) = result.open_lots
    assert (lot.quantity, lot.unit_cost) == (d("66"), d("15"))
    (trade,) = result.realized
    assert (trade.quantity, trade.open_unit_cost) == (d("0.6666666667"), d("15"))
    assert trade.pnl == d("0.6666666667") * 15 - 10  # cost of exactly 2/3 unit

    txns += [
        split(ACC, X, "2026-03-02", "0.02"),  # 1.32 units at 750
        sell(ACC, X, "2026-03-03", "0.32", "800"),
        sell(ACC, X, "2026-04-01", "1", "800"),
    ]
    result = run_lots(txns)
    assert result.warnings == ()
    assert result.open_lots == ()
    proceeds = d("0.6666666667") * 15 + d("0.32") * 800 + 800
    assert realized_pnl(result) == proceeds - 1000


@pytest.mark.parametrize("quantity", ["0.4666666667", "0.4666666666", "0.46666666666666666667"])
def test_a_whole_position_with_no_finite_decimal_is_closed_by_the_brokers_decimal(quantity):
    txns = [
        buy(ACC, X, "2026-01-05", "7", "10"),  # cost 70
        split(ACC, X, "2026-02-02", "0.0666666667"),  # 7/15 units at 150
    ]
    sold = run_lots([*txns, sell(ACC, X, "2026-03-02", quantity, "160")])
    assert sold.warnings == ()
    assert sold.open_lots == ()
    (trade,) = sold.realized
    assert trade.quantity == d(quantity)
    assert trade.open_unit_cost == d("150")
    assert trade.pnl == d(quantity) * 160 - 70  # the whole exact cost is released

    moved = run_lots([*txns, transfer_out(ACC, X, "2026-03-02", quantity)])
    assert moved.warnings == ()
    assert moved.open_lots == ()


def test_split_dust_tolerance_is_tiny_and_explicit():
    assert Fraction(1, 10**9) == SPLIT_REMAINDER_TOLERANCE
    txns = [
        buy(ACC, X, "2026-01-05", "7", "10"),
        split(ACC, X, "2026-02-02", "0.0666666667"),  # 7/15 = 0.4666...
    ]

    # 6.7E-10 left: within the tolerance, the lot is closed.
    assert run_lots([*txns, sell(ACC, X, "2026-03-02", "0.4666666660", "160")]).open_lots == ()

    # 1.7E-9 left: beyond it, the dust stays visible.
    (lot,) = run_lots([*txns, sell(ACC, X, "2026-03-02", "0.466666665", "160")]).open_lots
    assert lot.quantity == d("1.6666666666666666667E-9")

    # Sold 3.3E-7 too much at 6 places: a history gap, not silently forgiven.
    over = sell(ACC, X, "2026-03-02", "0.466667", "160")
    result = run_lots([*txns, over])
    assert result.open_lots == ()
    assert result.warnings == (
        HistoryGap(
            account_id=ACC,
            instrument_id=X,
            date=day("2026-03-02"),
            shortfall=d("3.3333333333333333333E-7"),
            txn_id=over.id,
        ),
    )


def test_remainders_with_a_finite_decimal_are_never_snapped():
    (lot,) = run_lots(
        [buy(ACC, X, "2026-01-05", "1", "10"), sell(ACC, X, "2026-02-02", "0.9999999999", "11")]
    ).open_lots
    assert lot.quantity == d("1E-10")

    over = sell(ACC, X, "2026-02-02", "1.0000000001", "11")
    result = run_lots([buy(ACC, X, "2026-01-05", "1", "10"), over])
    assert [(w.txn_id, w.shortfall) for w in result.warnings] == [(over.id, d("1E-10"))]


# --- forward splits -----------------------------------------------------------------------------


def test_three_for_one_and_two_for_one_forward_splits_keep_the_cost_and_close_exactly():
    txns = [
        buy(ACC, X, "2026-01-05", "7", "33", fee="1"),  # cost 232
        split(ACC, X, "2026-02-02", "3"),  # 21 units
        split(ACC, X, "2026-03-02", "2"),  # 42 units
    ]
    (lot,) = run_lots(txns).open_lots
    assert lot.quantity == d("42")
    assert lot.unit_cost == d("5.5238095238")  # 232 / 42, rounded only for display

    result = run_lots(
        [
            *txns,
            sell(ACC, X, "2026-04-01", "21", "6"),
            sell(ACC, X, "2026-04-02", "21", "6"),
        ]
    )
    assert result.warnings == ()
    assert result.open_lots == ()
    assert [trade.pnl for trade in result.realized] == [d("10"), d("10")]  # 126 - 116 each


def test_three_for_two_split_of_an_odd_quantity():
    txns = [buy(ACC, X, "2026-01-05", "7", "15"), split(ACC, X, "2026-02-02", "1.5")]
    (lot,) = run_lots(txns).open_lots
    assert (lot.quantity, lot.unit_cost) == (d("10.5"), d("10"))
    result = run_lots([*txns, sell(ACC, X, "2026-03-02", "10.5", "12")])
    assert (result.warnings, result.open_lots) == ((), ())
    assert realized_pnl(result) == d("21")


# --- cost basis -----------------------------------------------------------------------------------


def test_splits_leave_the_total_cost_basis_unchanged():
    txns = [
        buy(ACC, X, "2026-01-05", "30", "10"),  # cost 300
        buy(ACC, X, "2026-01-06", "60", "12", fee="3"),  # cost 723
    ]

    def cost_basis(history):
        return sum((lot.cost_basis for lot in run_lots(history).open_lots), Decimal(0))

    assert cost_basis(txns) == d("1023")
    txns.append(split(ACC, X, "2026-02-02", "0.3333333333"))  # 10 at 30, 20 at 36.15
    assert [(lot.quantity, lot.unit_cost) for lot in run_lots(txns).open_lots] == [
        (d("10"), d("30")),
        (d("20"), d("36.15")),
    ]
    assert cost_basis(txns) == d("1023")
    txns.append(split(ACC, X, "2026-03-02", "3"))  # back to 30 at 10, 60 at 12.05
    assert cost_basis(txns) == d("1023")

    result = run_lots([*txns, sell(ACC, X, "2026-04-01", "90", "13")])
    assert (result.warnings, result.open_lots) == ((), ())
    assert realized_pnl(result) == d("1170") - d("1023")


# --- last trade prices ----------------------------------------------------------------------------


def test_last_trade_price_divides_by_the_exact_fraction_and_dedups_by_it():
    txns = [
        buy(ACC, X, "2026-01-05", "3", "10"),
        buy(OTHER, X, "2026-01-05", "3", "10"),
        split(ACC, X, "2026-02-02", "0.3333333333"),
        # The same 1:3 split booked two days later in another account, written with more digits.
        split(OTHER, X, "2026-02-04", "0.33333333333333333333"),
    ]
    assert last_trade_prices(txns)[X] == DatedPrice(
        date=day("2026-01-05"), price=d("30"), currency=PLN
    )
