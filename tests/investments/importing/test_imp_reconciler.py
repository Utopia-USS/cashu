"""Reconciliation of broker positions with a portfolio snapshot (port of reconciler_test)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from imp_support import counter_ids, d, day

from finanse.modules.investments.domain import (
    Currency,
    Holding,
    PortfolioSnapshot,
    TxnSource,
    TxnType,
)
from finanse.modules.investments.importing import (
    BrokerPosition,
    ParsedPosition,
    PositionDiffKind,
    reconcile,
)

ACCOUNT = "acc-1"
OTHER = "acc-2"
NOW = datetime(2026, 2, 1, 9, tzinfo=UTC)


def position(
    instrument_id: str,
    quantity: str,
    *,
    avg_price: str | None = None,
    as_of: str = "2026-01-31",
    currency: Currency = Currency.PLN,
) -> BrokerPosition:
    return BrokerPosition(
        instrument_id=instrument_id,
        quantity=d(quantity),
        currency=currency,
        as_of=day(as_of),
        avg_price=None if avg_price is None else d(avg_price),
    )


def snapshot(as_of: str = "2026-01-31") -> PortfolioSnapshot:
    def holding(account: str, instrument_id: str, quantity: str) -> Holding:
        return Holding(
            account_id=account,
            instrument_id=instrument_id,
            currency=Currency.PLN,
            quantity=d(quantity),
        )

    return PortfolioSnapshot(
        profile_id="p",
        as_of=day(as_of),
        holdings=(
            holding(ACCOUNT, "a", "10"),
            holding(ACCOUNT, "b", "5"),
            holding(ACCOUNT, "c", "3"),
            holding(OTHER, "a", "7"),
        ),
    )


def test_diff_per_instrument_and_proposed_corrections() -> None:
    report = reconcile(
        ACCOUNT,
        [position("a", "10"), position("b", "8", avg_price="20"), position("missing", "4")],
        snapshot(),
        now=NOW,
        txn_id_factory=counter_ids("rec"),
    )
    assert report.account_id == ACCOUNT
    assert report.as_of == day("2026-01-31")
    assert report.warnings == ()
    assert not report.is_clean
    assert [(x.instrument_id, x.kind, x.delta) for x in report.diffs] == [
        ("a", PositionDiffKind.MATCH, d("0")),
        ("b", PositionDiffKind.MISMATCH, d("3")),
        ("missing", PositionDiffKind.MISSING_IN_HISTORY, d("4")),
        ("c", PositionDiffKind.MISSING_AT_BROKER, d("-3")),
    ]
    assert [x.instrument_id for x in report.mismatches] == ["b", "missing", "c"]

    more, unknown_cost, surplus = report.corrections
    assert more.diff.instrument_id == "b"
    assert (more.txn.type, more.txn.quantity, more.txn.price) == (
        TxnType.ADJUSTMENT,
        d("3"),
        d("20"),
    )
    assert more.txn.gross_amount == d("60")
    assert more.txn.note == (
        "Reconciliation: broker reports 8, history gives 5 (+3); cost = broker average price 20"
    )
    assert (unknown_cost.txn.type, unknown_cost.txn.quantity) == (TxnType.ADJUSTMENT, d("4"))
    assert unknown_cost.txn.price is None, "unknown cost, flagged by the lot engine"
    assert unknown_cost.txn.gross_amount == 0
    assert unknown_cost.txn.note.endswith("cost unknown")
    assert surplus.txn.type == TxnType.TRANSFER_OUT, "quantities are never negative"
    assert (surplus.txn.quantity, surplus.txn.price) == (d("3"), None)
    assert surplus.txn.note == "Reconciliation: broker reports 0, history gives 3 (-3)"

    for correction in report.corrections:
        txn = correction.txn
        assert txn.source == TxnSource.RECONCILIATION
        assert txn.account_id == ACCOUNT
        assert txn.trade_date == day("2026-01-31")
        assert txn.cash_amount == 0
        assert txn.import_batch_id is None
    assert [c.txn.id for c in report.corrections] == ["rec-1", "rec-2", "rec-3"]
    assert len({c.txn.dedup_hash for c in report.corrections}) == 3
    assert [c.txn.created_at for c in report.corrections] == [
        NOW,
        NOW + timedelta(milliseconds=1),
        NOW + timedelta(milliseconds=2),
    ]


def test_same_proposal_gets_the_same_dedup_hash() -> None:
    def run():
        return reconcile(
            ACCOUNT, [position("a", "11"), position("b", "5"), position("c", "3")], snapshot()
        )

    assert run().corrections[0].txn.dedup_hash == run().corrections[0].txn.dedup_hash


def test_fully_matching_account_is_clean_and_tolerance_absorbs_rounding() -> None:
    positions = [position("a", "10.00004"), position("b", "5"), position("c", "3")]
    assert reconcile(ACCOUNT, positions, snapshot(), tolerance=d("0.0001")).is_clean
    exact = reconcile(ACCOUNT, positions, snapshot())
    assert [x.instrument_id for x in exact.mismatches] == ["a"]
    assert exact.corrections[0].txn.quantity == d("0.00004")


def test_several_rows_of_one_instrument_are_summed_with_a_weighted_average_price() -> None:
    report = reconcile(
        ACCOUNT,
        [
            position("a", "10"),
            position("b", "4", avg_price="10"),
            position("b", "4", avg_price="20"),
            position("c", "3"),
        ],
        snapshot(),
    )
    (correction,) = report.corrections
    assert correction.diff.broker_quantity == d("8")
    assert correction.txn.quantity == d("3")
    assert correction.txn.price == d("15")


def test_warns_about_date_and_currency_mismatches() -> None:
    report = reconcile(
        ACCOUNT,
        [
            position("a", "10", as_of="2026-01-30"),
            position("b", "5", currency=Currency.EUR),
            position("c", "3"),
        ],
        snapshot("2026-01-29"),
    )
    assert report.as_of == day("2026-01-31")
    assert report.warnings == (
        "Broker positions have 2 different dates; used 2026-01-31",
        "Snapshot is as of 2026-01-29 but broker positions as of 2026-01-31",
        "Currency of b differs: history PLN, broker EUR",
    )


def test_no_positions_every_holding_is_missing_at_the_broker() -> None:
    report = reconcile(ACCOUNT, [], snapshot())
    assert report.as_of == day("2026-01-31")
    assert {x.kind for x in report.diffs} == {PositionDiffKind.MISSING_AT_BROKER}
    assert {c.txn.type for c in report.corrections} == {TxnType.TRANSFER_OUT}
    assert len(report.diffs) == 3, "holdings of other accounts are ignored"


def test_broker_position_from_parsed() -> None:
    parsed = ParsedPosition(
        quantity=d("2"),
        currency=Currency.USD,
        as_of=day("2026-01-31"),
        avg_price=d("5"),
        symbol="X",
    )
    resolved = BrokerPosition.from_parsed(parsed, "inst")
    assert (resolved.instrument_id, resolved.quantity, resolved.avg_price) == (
        "inst",
        d("2"),
        d("5"),
    )
