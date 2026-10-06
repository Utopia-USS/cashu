"""Snapshot builder, restrict_snapshot and last trade prices (port of snapshot_builder_test.dart)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

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
)

from cashu.modules.investments.domain import (
    CashBalance,
    CashHistoryGap,
    DatedPrice,
    HistoryGap,
    InstrumentRename,
    MissingInstrument,
    MixedLotCurrencies,
    PortfolioSnapshot,
    TxnSource,
    TxnType,
)
from cashu.modules.investments.portfolio import (
    build_snapshot,
    last_trade_prices,
    restrict_snapshot,
)

PROFILE = new_id()
IKE = new_id()
REGULAR = new_id()
FOREIGN = new_id()  # an account of another profile
X = new_id()
Y = new_id()
PROFILE_ACCOUNTS = {IKE, REGULAR}


def test_holdings_cash_deposits_and_realized_trades_as_of_a_date():
    txns = [
        cash_txn(IKE, "2026-01-02", "5000"),
        cash_txn(REGULAR, "2026-01-02", "1000"),
        buy(IKE, X, "2026-01-05", "10", "100"),
        buy(IKE, X, "2026-01-20", "10", "110"),
        buy(REGULAR, X, "2026-01-06", "2", "100"),
        buy(IKE, Y, "2026-01-07", "5", "40"),
        sell(IKE, Y, "2026-02-02", "5", "50"),  # y fully closed in IKE
        sell(IKE, X, "2026-03-02", "4", "120"),
        buy(IKE, X, "2026-04-01", "100", "1"),  # after as_of
    ]

    snapshot = build_snapshot(PROFILE, txns, day("2026-03-31"), profile_accounts=PROFILE_ACCOUNTS)

    assert snapshot.profile_id == PROFILE
    assert snapshot.as_of == day("2026-03-31")
    assert [(h.account_id, h.instrument_id, h.quantity) for h in snapshot.holdings] == [
        (IKE, X, d("16")),
        (REGULAR, X, d("2")),
    ]
    ike_x = snapshot.holdings[0]
    assert [lot.quantity for lot in ike_x.lots] == [d("6"), d("10")]
    assert ike_x.cost_basis == d("1700")  # 6 * 100 + 10 * 110
    assert ike_x.average_cost == d("106.25")
    assert ike_x.currency == PLN
    assert len(snapshot.holdings_of(X)) == 2
    assert snapshot.cash == (
        CashBalance(account_id=IKE, currency=PLN, amount=d("3430")),  # 5000-1000-1100-200+250+480
        CashBalance(account_id=REGULAR, currency=PLN, amount=d("800")),
    )
    assert [dep.account_id for dep in snapshot.deposits] == [IKE, REGULAR]
    assert [(t.instrument_id, t.pnl) for t in snapshot.realized] == [(Y, d("50")), (X, d("80"))]
    assert snapshot.realized_pnl_by_currency == {PLN: d("130")}
    assert snapshot.warnings == ()


def test_account_filter_and_foreign_accounts_restrict_the_transactions():
    txns = [
        buy(IKE, X, "2026-01-05", "10", "100"),
        buy(REGULAR, X, "2026-01-06", "2", "100"),
        buy(FOREIGN, X, "2026-01-06", "7", "100"),
        buy(new_id(), X, "2026-01-06", "9", "100"),  # account not passed in
    ]

    all_accounts = build_snapshot(
        PROFILE, txns, day("2026-03-31"), profile_accounts=PROFILE_ACCOUNTS
    )
    assert [h.account_id for h in all_accounts.holdings] == [IKE, REGULAR]

    only_regular = build_snapshot(
        PROFILE,
        txns,
        day("2026-03-31"),
        profile_accounts=PROFILE_ACCOUNTS,
        account_ids={REGULAR},
    )
    assert [h.account_id for h in only_regular.holdings] == [REGULAR]
    assert [c.account_id for c in only_regular.cash] == [REGULAR]

    # Without profile_accounts every account in the transactions belongs to the profile.
    assert len(build_snapshot(PROFILE, txns, day("2026-03-31")).holdings) == 4


def test_lot_engine_warnings_are_kept_and_mixed_lot_currencies_flagged():
    txns = [
        buy(IKE, X, "2026-01-05", "1", "100"),
        buy(IKE, X, "2026-01-06", "1", "25", currency=USD),
        sell(REGULAR, Y, "2026-01-07", "3", "10"),
    ]

    snapshot = build_snapshot(PROFILE, txns, day("2026-03-31"), profile_accounts=PROFILE_ACCOUNTS)

    gap, mixed, *cash_gaps = snapshot.warnings
    assert isinstance(gap, HistoryGap) and gap.shortfall == d("3")
    assert mixed == MixedLotCurrencies(
        account_id=IKE, instrument_id=X, currencies=frozenset({PLN, USD})
    )
    # Buys without deposits leave negative cash: deposits are missing from the history (R2).
    assert cash_gaps == [
        CashHistoryGap(account_id=IKE, currency=PLN, amount=d("-100"), as_of=day("2026-03-31")),
        CashHistoryGap(account_id=IKE, currency=USD, amount=d("-25"), as_of=day("2026-03-31")),
    ]
    (holding,) = snapshot.holdings
    assert holding.currency == PLN
    assert holding.cost_basis is None  # never summed across currencies (R12)
    assert holding.average_cost is None


def test_restrict_snapshot_drops_other_accounts_and_keeps_global_warnings():
    txns = [
        cash_txn(IKE, "2026-01-02", "100"),
        cash_txn(REGULAR, "2026-01-02", "100"),
        buy(IKE, X, "2026-01-05", "1", "50"),
        buy(REGULAR, X, "2026-01-05", "1", "50"),
        sell(IKE, X, "2026-01-06", "1", "60"),
        sell(REGULAR, Y, "2026-01-07", "3", "10"),  # gap in REGULAR
    ]
    snapshot = build_snapshot(PROFILE, txns, day("2026-03-31"), profile_accounts=PROFILE_ACCOUNTS)
    with_global_warning = replace(
        snapshot, warnings=(*snapshot.warnings, MissingInstrument(instrument_id=Y))
    )

    restricted = restrict_snapshot(with_global_warning, {IKE})

    assert restricted.holdings == ()  # x was sold in IKE
    assert [c.account_id for c in restricted.cash] == [IKE]
    assert [dep.account_id for dep in restricted.deposits] == [IKE]
    assert [t.account_id for t in restricted.realized] == [IKE]
    assert restricted.warnings == (MissingInstrument(instrument_id=Y),)
    assert len(restrict_snapshot(with_global_warning, {REGULAR}).warnings) == 2
    (gap,) = [w for w in snapshot.warnings if isinstance(w, HistoryGap)]
    assert gap.account_id == REGULAR
    assert MissingInstrument(instrument_id=Y).account_id is None


def test_snapshot_with_a_rename_carries_lots_and_the_last_trade_price():
    z = new_id()
    txns = [buy(IKE, X, "2026-01-05", "10", "100"), sell(IKE, z, "2026-03-02", "2", "130")]
    rename = InstrumentRename(date=day("2026-02-01"), old_instrument_id=X, new_instrument_id=z)

    before = build_snapshot(PROFILE, txns, day("2026-01-31"), renames=[rename])
    assert [(h.instrument_id, h.quantity) for h in before.holdings] == [(X, d("10"))]

    after = build_snapshot(PROFILE, txns, day("2026-02-15"), renames=[rename])
    assert [(h.instrument_id, h.quantity) for h in after.holdings] == [(z, d("10"))]
    assert after.last_trade_prices == {
        X: DatedPrice(date=day("2026-01-05"), price=d("100"), currency=PLN),
        z: DatedPrice(date=day("2026-01-05"), price=d("100"), currency=PLN),
    }

    later = build_snapshot(PROFILE, txns, day("2026-03-31"), renames=[rename])
    assert [(h.instrument_id, h.quantity) for h in later.holdings] == [(z, d("8"))]
    assert later.realized[0].pnl == d("60")
    assert later.last_trade_prices[z].price == d("130")
    assert [w.kind for w in later.warnings] == ["cash_history_gap"]  # no deposits in this test


# --- last trade prices --------------------------------------------------------------------------


def test_newest_positive_trade_price_split_adjusted_once_up_to_as_of():
    txns = [
        buy(IKE, X, "2026-01-05", "10", "100"),
        sell(REGULAR, X, "2026-02-02", "1", "120"),
        transfer_in(IKE, X, "2026-02-03", "5", price="0"),  # no price information
        split(IKE, X, "2026-03-02", "2"),
        split(REGULAR, X, "2026-03-02", "2"),  # the same split in the other account
        buy(IKE, Y, "2026-01-05", "1", "30", currency=USD),
    ]

    assert last_trade_prices(txns) == {
        X: DatedPrice(date=day("2026-02-02"), price=d("60"), currency=PLN),
        Y: DatedPrice(date=day("2026-01-05"), price=d("30"), currency=USD),
    }
    assert last_trade_prices(txns, as_of=day("2026-01-31"))[X].price == d("100")
    assert last_trade_prices(txns, account_ids={IKE})[X].price == d("50")  # 100 / 2


def test_only_buy_and_sell_prices_count_r13():
    txns = [
        buy(IKE, X, "2026-01-05", "10", "100"),
        transfer_in(IKE, X, "2026-02-03", "5", price="80"),  # transfer value, not a market price
        build_txn(
            IKE,
            X,
            type=TxnType.ADJUSTMENT,
            trade_date="2026-03-01",
            quantity="2",
            price="75",  # the broker's average cost
            gross_amount="0",
            cash_amount="0",
            source=TxnSource.RECONCILIATION,
            created_at=datetime(2026, 3, 1, tzinfo=UTC),
        ),
        build_txn(
            IKE,
            Y,
            trade_date="2026-03-01",
            quantity="1",
            price="9",
            source=TxnSource.RECONCILIATION,
            created_at=datetime(2026, 3, 1, tzinfo=UTC),
        ),
        transfer_in(IKE, Y, "2026-03-02", "1", price="12"),
    ]

    assert last_trade_prices(txns) == {
        X: DatedPrice(date=day("2026-01-05"), price=d("100"), currency=PLN)
    }


def test_split_booked_on_different_days_in_two_accounts_is_applied_once_r11():
    txns = [
        buy(IKE, X, "2026-01-10", "10", "100"),
        buy(REGULAR, X, "2026-01-10", "10", "100"),
        split(IKE, X, "2026-02-02", "2"),
        split(REGULAR, X, "2026-02-03", "2"),
    ]
    assert last_trade_prices(txns)[X] == DatedPrice(
        date=day("2026-01-10"), price=d("50"), currency=PLN
    )

    # A post-split trade between the two bookings is not halved by the late booking.
    with_trade = [*txns[:3], buy(IKE, X, "2026-02-02", "1", "51"), txns[3]]
    assert last_trade_prices(with_trade)[X].price == d("51")

    # A second split (different ratio, or the same ratio much later) is a new corporate action.
    two_splits = [*txns, split(IKE, X, "2026-02-04", "3"), split(IKE, X, "2026-09-01", "2")]
    assert last_trade_prices(two_splits)[X].price == d("8.3333333334")  # 100/2/3/2 rounded per step


def test_snapshot_has_the_last_trade_prices_of_its_transactions():
    snapshot = build_snapshot(
        PROFILE,
        [buy(IKE, X, "2026-01-05", "1", "100"), buy(IKE, X, "2026-04-01", "1", "200")],
        day("2026-03-31"),
    )
    assert snapshot.last_trade_prices == {
        X: DatedPrice(date=day("2026-01-05"), price=d("100"), currency=PLN)
    }
    assert isinstance(snapshot, PortfolioSnapshot)
