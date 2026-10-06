"""FIFO lot engine (port of the Kompas lot_engine_test.dart, plus renames)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Context, localcontext

from inv_portfolio_fixtures import (
    PLN,
    USD,
    build_txn,
    buy,
    cash_txn,
    d,
    day,
    new_id,
    sell,
    split,
    transfer_in,
    transfer_out,
)

from cashu.modules.investments.domain import (
    CashBalance,
    DatedAmount,
    HistoryGap,
    InstrumentRename,
    InvalidTransaction,
    Money,
    OpenLot,
    RealizedTrade,
    Transaction,
    TxnSource,
    TxnType,
    UnknownCostBasis,
)
from cashu.modules.investments.portfolio import run_lots

ACC = new_id()
OTHER = new_id()
X = new_id()
Y = new_id()


# --- FIFO ---------------------------------------------------------------------------------------


def test_partial_sell_consumes_oldest_lot_first_and_splits_the_next():
    buy1 = buy(ACC, X, "2026-01-05", "10", "100", fee="5")  # cost 1005, unit 100.5
    buy2 = buy(ACC, X, "2026-02-02", "10", "120", fee="5")  # cost 1205, unit 120.5
    sale = sell(ACC, X, "2026-03-02", "15", "130", fee="6")  # proceeds 1950 - 6 = 1944

    result = run_lots([sale, buy2, buy1])  # input order does not matter

    assert result.warnings == ()
    assert result.realized == (
        RealizedTrade(
            account_id=ACC,
            instrument_id=X,
            open_txn_id=buy1.id,
            close_txn_id=sale.id,
            open_date=day("2026-01-05"),
            close_date=day("2026-03-02"),
            quantity=d("10"),
            open_unit_cost=d("100.5"),
            close_unit_price=d("129.6"),
            currency=PLN,
            pnl=d("291"),  # 1944 * 10/15 = 1296 - 1005
        ),
        RealizedTrade(
            account_id=ACC,
            instrument_id=X,
            open_txn_id=buy2.id,
            close_txn_id=sale.id,
            open_date=day("2026-02-02"),
            close_date=day("2026-03-02"),
            quantity=d("5"),
            open_unit_cost=d("120.5"),
            close_unit_price=d("129.6"),
            currency=PLN,
            pnl=d("45.5"),  # 1944 - 1296 = 648 - 1205 * 5/10
        ),
    )
    assert [t.holding_days for t in result.realized] == [56, 28]
    assert result.open_lots == (
        OpenLot(
            account_id=ACC,
            instrument_id=X,
            open_txn_id=buy2.id,
            open_date=day("2026-02-02"),
            quantity=d("5"),
            unit_cost=d("120.5"),
            currency=PLN,
        ),
    )


def test_rounded_partial_costs_never_lose_money():
    lot = buy(ACC, X, "2026-01-05", "3", "100", fee="1")  # cost 301
    first = sell(ACC, X, "2026-02-02", "1", "110")
    rest = sell(ACC, X, "2026-03-02", "2", "110")

    after_first = run_lots([lot, first])
    (trade,) = after_first.realized
    assert trade.open_unit_cost == d("100.3333333333")
    assert trade.pnl == d("9.6666666667")  # 110 - 301/3 rounded
    (open_lot,) = after_first.open_lots
    assert open_lot.quantity == d("2")
    assert open_lot.unit_cost == d("100.3333333334")  # 200.6666666667 / 2

    result = run_lots([lot, first, rest])
    assert result.open_lots == ()
    assert sum(t.pnl for t in result.realized) == d("29")  # 330 proceeds - 301 cost, exact


def test_fees_and_taxes_go_into_cost_on_buys_and_reduce_proceeds_on_sells():
    result = run_lots(
        [
            buy(ACC, X, "2026-01-05", "10", "50", fee="2", tax="3"),  # cost 505
            sell(ACC, X, "2026-02-02", "10", "60", fee="2", tax="4"),  # proceeds 594
        ]
    )
    (trade,) = result.realized
    assert trade.open_unit_cost == d("50.5")
    assert trade.close_unit_price == d("59.4")
    assert trade.pnl == d("89")
    assert result.cash == (CashBalance(account_id=ACC, currency=PLN, amount=d("89")),)


def test_same_day_transactions_keep_their_created_at_order():
    morning_buy = buy(ACC, X, "2026-01-05", "10", "100")
    evening_sell = sell(ACC, X, "2026-01-05", "10", "110")

    assert run_lots([evening_sell, morning_buy]).warnings == ()
    # The same rows with the sell created first: the sell has nothing to match.
    sell_first = replace(evening_sell, created_at=datetime(2025, 1, 1, tzinfo=UTC))
    (warning,) = run_lots([sell_first, morning_buy]).warnings
    assert isinstance(warning, HistoryGap)


def test_naive_and_aware_created_at_can_be_mixed():
    morning_buy = replace(
        buy(ACC, X, "2026-01-05", "10", "100"),
        created_at=datetime(2026, 1, 5, 9).replace(tzinfo=None),  # noqa: DTZ001
    )
    evening_sell = sell(ACC, X, "2026-01-05", "10", "110")
    evening_sell = replace(evening_sell, created_at=datetime(2026, 1, 5, 15, tzinfo=UTC))
    assert run_lots([evening_sell, morning_buy]).warnings == ()


def test_instruments_are_matched_separately():
    result = run_lots(
        [
            buy(ACC, X, "2026-01-05", "10", "100"),
            buy(ACC, Y, "2026-01-06", "4", "25"),
            sell(ACC, Y, "2026-02-02", "4", "30"),
        ]
    )
    assert result.open_lots[0].instrument_id == X
    assert len(result.open_lots) == 1
    (trade,) = result.realized
    assert trade.instrument_id == Y
    assert trade.pnl == d("20")


# --- multiple accounts --------------------------------------------------------------------------


def test_lots_cash_and_gaps_are_kept_per_account():
    result = run_lots(
        [
            cash_txn(ACC, "2026-01-02", "2000"),
            cash_txn(OTHER, "2026-01-02", "1500"),
            buy(ACC, X, "2026-01-05", "10", "100"),
            buy(OTHER, X, "2026-01-05", "5", "200"),
            sell(ACC, X, "2026-02-02", "12", "110"),  # account ACC holds only 10
        ]
    )
    (lot,) = result.open_lots
    assert lot.account_id == OTHER
    assert lot.quantity == d("5")
    (trade,) = result.realized
    assert trade.quantity == d("10")
    assert trade.pnl == d("100")  # 1320 * 10/12 = 1100 - 1000
    (gap,) = result.warnings
    assert isinstance(gap, HistoryGap)
    assert gap.account_id == ACC
    assert gap.shortfall == d("2")
    assert result.cash == (
        CashBalance(account_id=ACC, currency=PLN, amount=d("2320")),  # 2000 - 1000 + 1320
        CashBalance(account_id=OTHER, currency=PLN, amount=d("500")),
    )


def test_the_account_filter_keeps_only_the_given_accounts():
    result = run_lots(
        [buy(ACC, X, "2026-01-05", "10", "100"), buy(OTHER, X, "2026-01-05", "5", "200")],
        account_ids={OTHER},
    )
    assert [lot.account_id for lot in result.open_lots] == [OTHER]
    assert [c.account_id for c in result.cash] == [OTHER]


# --- splits -------------------------------------------------------------------------------------


def test_split_multiplies_open_quantities_and_divides_unit_cost():
    result = run_lots(
        [
            buy(ACC, X, "2026-01-05", "10", "400"),  # cost 4000
            split(ACC, X, "2026-02-02", "4"),  # 40 units at 100
            sell(ACC, X, "2026-03-02", "20", "120"),  # proceeds 2400, cost 2000
        ]
    )
    (trade,) = result.realized
    assert trade.open_unit_cost == d("100")
    assert trade.pnl == d("400")
    (lot,) = result.open_lots
    assert lot.quantity == d("20")
    assert lot.unit_cost == d("100")
    assert lot.open_date == day("2026-01-05")


def test_reverse_split_touches_only_its_account():
    result = run_lots(
        [
            buy(ACC, X, "2026-01-05", "10", "10"),
            buy(OTHER, X, "2026-01-05", "10", "10"),
            split(ACC, X, "2026-02-02", "0.5"),
        ]
    )
    assert [(lot.account_id, lot.quantity, lot.unit_cost) for lot in result.open_lots] == [
        (ACC, d("5"), d("20")),
        (OTHER, d("10"), d("10")),
    ]


def test_split_without_a_ratio_is_ignored_with_a_warning():
    bad = replace(split(ACC, X, "2026-02-02", "4"), split_ratio=d("0"))
    result = run_lots([buy(ACC, X, "2026-01-05", "10", "10"), bad])
    assert result.open_lots[0].quantity == d("10")
    (warning,) = result.warnings
    assert isinstance(warning, InvalidTransaction)
    assert warning.txn_id == bad.id


# --- transfers ----------------------------------------------------------------------------------


def test_transfer_in_without_price_opens_a_lot_with_unknown_cost():
    incoming = transfer_in(ACC, X, "2026-01-05", "10")
    sale = sell(ACC, X, "2026-02-02", "4", "50")

    result = run_lots([incoming, sale])

    assert result.warnings == (
        UnknownCostBasis(
            account_id=ACC, instrument_id=X, txn_id=incoming.id, date=day("2026-01-05")
        ),
    )
    (lot,) = result.open_lots
    assert lot.quantity == d("6")
    assert lot.unit_cost is None
    assert lot.cost_basis is None
    (trade,) = result.realized
    assert trade.open_unit_cost is None
    assert trade.pnl is None
    assert trade.close_unit_price == d("50")


def test_transfer_in_with_price_uses_it_as_cost_and_zero_counts_as_unknown():
    priced = run_lots([transfer_in(ACC, X, "2026-01-05", "10", price="80")])
    assert priced.warnings == ()
    assert priced.open_lots[0].unit_cost == d("80")

    zero = run_lots([transfer_in(ACC, X, "2026-01-05", "10", price="0")])
    (warning,) = zero.warnings
    assert isinstance(warning, UnknownCostBasis)
    assert zero.open_lots[0].unit_cost is None


def test_transfer_out_consumes_fifo_without_realizing():
    result = run_lots(
        [
            buy(ACC, X, "2026-01-05", "10", "100"),
            buy(ACC, X, "2026-01-06", "10", "200"),
            transfer_out(ACC, X, "2026-02-02", "12"),
        ]
    )
    assert result.realized == ()
    (lot,) = result.open_lots
    assert lot.quantity == d("8")
    assert lot.unit_cost == d("200")


def test_adjustment_adds_units_like_a_transfer_in():
    adjustment = replace(
        transfer_in(ACC, X, "2026-01-05", "3"),
        type=TxnType.ADJUSTMENT,
        source=TxnSource.RECONCILIATION,
    )
    result = run_lots([adjustment])
    assert result.open_lots[0].quantity == d("3")
    (warning,) = result.warnings
    assert isinstance(warning, UnknownCostBasis)


# --- incomplete history -------------------------------------------------------------------------


def test_selling_more_than_held_records_history_gap_and_never_raises():
    lot = buy(ACC, X, "2026-01-05", "5", "8")  # cost 40
    sale = sell(ACC, X, "2026-02-02", "8", "10")  # proceeds 80, 50 for the 5 matched units

    result = run_lots([lot, sale])

    (trade,) = result.realized
    assert trade.quantity == d("5")
    assert trade.pnl == d("10")
    assert result.open_lots == ()
    assert result.warnings == (
        HistoryGap(
            account_id=ACC,
            instrument_id=X,
            date=day("2026-02-02"),
            shortfall=d("3"),
            txn_id=sale.id,
        ),
    )
    assert result.cash[0].amount == d("40")  # -40 + 80: cash follows cash_amount regardless


def test_selling_with_nothing_held_and_transferring_out_too_much_are_gaps():
    result = run_lots(
        [
            sell(ACC, X, "2026-01-05", "8", "10"),
            buy(ACC, Y, "2026-01-05", "1", "10"),
            transfer_out(ACC, Y, "2026-01-06", "3"),
        ]
    )
    assert result.realized == ()
    assert result.open_lots == ()
    assert [w.shortfall for w in result.warnings] == [d("8"), d("2")]


def test_rows_missing_instrument_or_quantity_skip_lots_but_count_for_cash():
    no_quantity = build_txn(
        ACC, X, type=TxnType.SELL, quantity=None, gross_amount="50", cash_amount="50"
    )
    orphan = Transaction(
        id=new_id(),
        account_id=ACC,
        type=TxnType.BUY,
        trade_date=day("2026-01-06"),
        quantity=d("1"),
        price=d("10"),
        currency=PLN,
        gross_amount=d("10"),
        cash_amount=d("-10"),
        cash_currency=PLN,
        source=TxnSource.MANUAL,
    )

    result = run_lots([no_quantity, orphan])

    assert result.open_lots == ()
    assert [w.reason for w in result.warnings] == ["missing or zero quantity", "missing instrument"]
    assert result.cash[0].amount == d("40")


# --- cash and deposits --------------------------------------------------------------------------


def test_cash_per_currency_deposits_oldest_first_zero_balances_dropped():
    result = run_lots(
        [
            cash_txn(ACC, "2026-02-01", "500"),
            cash_txn(ACC, "2026-01-01", "1000"),
            cash_txn(ACC, "2026-01-15", "200", currency=USD),
            cash_txn(ACC, "2026-01-20", "-200", type=TxnType.WITHDRAWAL, currency=USD),
            cash_txn(ACC, "2026-01-21", "12.5", type=TxnType.DIVIDEND),
            cash_txn(ACC, "2026-01-22", "-2.5", type=TxnType.FEE),
        ]
    )
    assert result.cash == (CashBalance(account_id=ACC, currency=PLN, amount=d("1510")),)
    assert result.deposits == (
        DatedAmount(account_id=ACC, date=day("2026-01-01"), amount=Money(d("1000"), PLN)),
        DatedAmount(account_id=ACC, date=day("2026-01-15"), amount=Money(d("200"), USD)),
        DatedAmount(account_id=ACC, date=day("2026-02-01"), amount=Money(d("500"), PLN)),
    )


def test_foreign_buy_settled_in_pln_moves_pln_cash_and_keeps_the_lot_in_usd():
    usd_buy = replace(
        buy(ACC, X, "2026-01-05", "2", "100", currency=USD),
        cash_amount=d("-800"),
        cash_currency=PLN,
        fx_rate=d("4"),
    )
    result = run_lots([usd_buy])
    (lot,) = result.open_lots
    assert lot.currency == USD
    assert lot.unit_cost == d("100")
    assert result.cash == (CashBalance(account_id=ACC, currency=PLN, amount=d("-800")),)


def test_large_amounts_stay_exact():
    # 18 significant digits per factor: the default 28-digit decimal context would round products.
    quantity, buy_price, sell_price = (
        "123456789.123456789",
        "98765432.987654321",
        "98765433.987654321",
    )
    with localcontext(Context(prec=100)):
        cost = d(quantity) * d(buy_price)
        proceeds = d(quantity) * d(sell_price)
        opened = replace(
            buy(ACC, X, "2026-01-05", "1", "1"),
            quantity=d(quantity),
            price=d(buy_price),
            gross_amount=cost,
            cash_amount=-cost,
        )
        closed = replace(
            sell(ACC, X, "2026-02-02", "1", "1"),
            quantity=d(quantity),
            price=d(sell_price),
            gross_amount=proceeds,
            cash_amount=proceeds,
        )

    result = run_lots([opened, closed])

    (trade,) = result.realized
    assert trade.pnl == d(quantity)  # (sell - buy price) * quantity, exact to the last digit
    assert result.cash[0].amount == d(quantity)


# --- renames (Stage 2: a rename carries lots, it is not a sell plus a buy) ---------------------


def test_rename_carries_lots_with_cost_and_open_date_to_the_new_instrument():
    old_buy = buy(ACC, X, "2026-01-05", "10", "100", fee="5")  # cost 1005
    other_buy = buy(OTHER, X, "2026-01-06", "4", "50")  # cost 200
    rename = InstrumentRename(date=day("2026-03-01"), old_instrument_id=X, new_instrument_id=Y)
    later_sale = sell(ACC, Y, "2026-04-01", "4", "120")

    result = run_lots([old_buy, other_buy, later_sale], renames=[rename])

    assert result.warnings == ()
    assert [
        (lot.account_id, lot.instrument_id, lot.quantity, lot.open_date) for lot in result.open_lots
    ] == [
        (ACC, Y, d("6"), day("2026-01-05")),
        (OTHER, Y, d("4"), day("2026-01-06")),
    ]
    assert result.open_lots[0].unit_cost == d("100.5")
    (trade,) = result.realized
    assert trade.instrument_id == Y
    assert trade.open_txn_id == old_buy.id
    assert trade.open_date == day("2026-01-05")
    assert trade.pnl == d("78")  # 480 - 4 * 100.5


def test_rows_naming_the_old_instrument_after_a_rename_count_for_the_new_one():
    rename = InstrumentRename(date=day("2026-03-01"), old_instrument_id=X, new_instrument_id=Y)
    result = run_lots(
        [
            buy(ACC, X, "2026-01-05", "10", "100"),
            sell(ACC, X, "2026-03-01", "3", "110"),  # same day as the rename: already Y
            split(ACC, X, "2026-03-02", "2"),
        ],
        renames=[rename],
    )
    assert result.warnings == ()
    (lot,) = result.open_lots
    assert (lot.instrument_id, lot.quantity, lot.unit_cost) == (Y, d("14"), d("50"))
    assert result.realized[0].instrument_id == Y


def test_rename_merges_with_lots_already_held_in_the_new_instrument_fifo_by_open_date():
    early = buy(ACC, X, "2026-01-05", "1", "10")
    middle = buy(ACC, Y, "2026-01-10", "1", "20")
    late = buy(ACC, X, "2026-01-15", "1", "30")
    rename = InstrumentRename(date=day("2026-02-01"), old_instrument_id=X, new_instrument_id=Y)

    result = run_lots([early, middle, late], renames=[rename])

    assert [lot.open_txn_id for lot in result.open_lots] == [early.id, middle.id, late.id]
    assert {lot.instrument_id for lot in result.open_lots} == {Y}


def test_chained_renames_and_a_rename_before_any_lot():
    z = new_id()
    result = run_lots(
        [buy(ACC, X, "2026-01-05", "2", "10"), sell(ACC, X, "2026-06-01", "1", "12")],
        renames=[
            InstrumentRename(date=day("2026-02-01"), old_instrument_id=X, new_instrument_id=Y),
            InstrumentRename(date=day("2026-03-01"), old_instrument_id=Y, new_instrument_id=z),
            InstrumentRename(
                date=day("2025-01-01"), old_instrument_id=new_id(), new_instrument_id=X
            ),
        ],
    )
    assert [(lot.instrument_id, lot.quantity) for lot in result.open_lots] == [(z, d("1"))]
    assert result.realized[0].instrument_id == z
    assert result.realized[0].pnl == d("2")
