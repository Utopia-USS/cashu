"""Dedup hashes (R8), chronological ranking (R9) and amount derivation (R5)."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta

import pytest
from imp_support import d, day, parsed_txn

from finanse.modules.investments.domain import Currency, Transaction, TxnType
from finanse.modules.investments.importing import (
    AmountError,
    DedupInput,
    chronological_ranks,
    created_at_stamps,
    dedup_hash,
    dedup_hashes,
    derive_amounts,
    is_newest_first,
)
from finanse.modules.investments.importing.cash import (
    cash_from_gross,
    gross_from_cash,
    signed_cash,
    to_cash_currency,
    to_trade_currency,
)
from finanse.modules.investments.importing.dedup import (
    decimal_key,
    parsed_dedup_inputs,
    reconciliation_hash,
)

ACCOUNT = "acc-1"


def buy(
    *,
    ref: str | None = None,
    quantity: str = "10",
    price: str = "62.5",
    gross: str = "625",
    cash: str = "-628.13",
    trade_date: str = "2026-01-07",
    instrument: str | None = "inst-1",
    currency: str = "PLN",
) -> DedupInput:
    return DedupInput(
        trade_date=day(trade_date),
        type=TxnType.BUY,
        gross_amount=d(gross),
        cash_amount=d(cash),
        external_ref=ref,
        instrument_key=instrument,
        quantity=d(quantity),
        price=d(price),
        currency=currency,
    )


# --- R8 dedup ----------------------------------------------------------------------------------


def test_external_ref_hash_uses_ref_and_fill_identity_not_amounts_or_dates() -> None:
    base = dedup_hash(buy(ref="R-1"), account_id=ACCOUNT, broker_id="xtb")
    assert len(base) == 64 and base == base.lower()
    same = buy(ref=" R-1 ", cash="-628.10", gross="625.01", trade_date="2026-01-08")
    assert dedup_hash(same, account_id=ACCOUNT, broker_id="xtb") == base, "re-export rounding"
    assert dedup_hash(buy(ref="R-1"), account_id="acc-2", broker_id="xtb") != base
    assert dedup_hash(buy(ref="R-1"), account_id=ACCOUNT, broker_id="mbank") != base
    assert dedup_hash(buy(ref="R-2"), account_id=ACCOUNT, broker_id="xtb") != base
    assert dedup_hash(buy(ref="R-1", quantity="5"), account_id=ACCOUNT, broker_id="xtb") != base
    assert dedup_hash(buy(ref="R-1", price="63"), account_id=ACCOUNT, broker_id="xtb") != base
    assert (
        dedup_hash(buy(ref="R-1", instrument="other"), account_id=ACCOUNT, broker_id="xtb") != base
    )
    assert dedup_hash(buy(ref="R-1", currency="USD"), account_id=ACCOUNT, broker_id="xtb") != base
    blank_ref = dedup_hash(buy(ref="  "), account_id=ACCOUNT, broker_id="xtb")
    assert blank_ref == dedup_hash(buy(), account_id=ACCOUNT, broker_id="xtb"), "blank ref = none"


def test_content_hash_every_field_matters_decimals_by_value_broker_does_not() -> None:
    base = dedup_hash(buy(), account_id=ACCOUNT, broker_id="generic_csv")
    assert dedup_hash(buy(), account_id=ACCOUNT, broker_id="xtb") == base
    assert (
        dedup_hash(buy(price="62.500", cash="-628.130"), account_id=ACCOUNT, broker_id="x") == base
    )
    for changed in (
        buy(trade_date="2026-01-08"),
        buy(quantity="11"),
        buy(price="62.6"),
        buy(gross="626"),
        buy(cash="-628.14"),
        buy(instrument=None),
    ):
        assert dedup_hash(changed, account_id=ACCOUNT, broker_id="x") != base
    sell = DedupInput(
        trade_date=day("2026-01-07"),
        type=TxnType.SELL,
        gross_amount=d("625"),
        cash_amount=d("-628.13"),
        instrument_key="inst-1",
        quantity=d("10"),
        price=d("62.5"),
    )
    assert dedup_hash(sell, account_id=ACCOUNT, broker_id="x") != base


def test_identical_rows_of_one_file_get_distinct_hashes_stable_on_reimport() -> None:
    rows = [buy(), buy(quantity="5"), buy()]
    first = dedup_hashes(rows, account_id=ACCOUNT, broker_id="generic_csv")
    assert len(set(first)) == 3, "both identical buys import"
    assert first[0] == dedup_hash(buy(), account_id=ACCOUNT, broker_id="generic_csv")
    assert first[2] == dedup_hash(buy(), account_id=ACCOUNT, broker_id="generic_csv", occurrence=1)
    assert dedup_hashes(rows, account_id=ACCOUNT, broker_id="generic_csv") == first


def test_partial_fills_sharing_a_ref_dedup_independently_of_order_and_overlap_r8() -> None:
    fill_a = buy(ref="ORDER-1", quantity="5")
    fill_b = buy(ref="ORDER-1", quantity="7")
    export1 = dedup_hashes([fill_a], account_id=ACCOUNT, broker_id="xtb")
    export2 = dedup_hashes([fill_b, fill_a], account_id=ACCOUNT, broker_id="xtb")  # newest first
    assert export2[1] == export1[0], "fill A is recognized as already imported"
    assert export2[0] != export1[0], "fill B is new"
    twice = dedup_hashes([fill_a, fill_b, fill_a], account_id=ACCOUNT, broker_id="xtb")
    assert len(set(twice)) == 3
    assert set(dedup_hashes([fill_a, fill_a, fill_b], account_id=ACCOUNT, broker_id="xtb")) == set(
        twice
    )


def test_fx_legs_sharing_a_ref_stay_apart_by_currency() -> None:
    def leg(currency: str, cash: str) -> DedupInput:
        return DedupInput(
            trade_date=day("2026-02-02"),
            type=TxnType.FX_CONVERSION,
            gross_amount=abs(d(cash)),
            cash_amount=d(cash),
            external_ref="FX-1",
            currency=currency,
        )

    pln_only = dedup_hashes([leg("PLN", "-400")], account_id=ACCOUNT, broker_id="x")
    both = dedup_hashes([leg("USD", "100"), leg("PLN", "-400")], account_id=ACCOUNT, broker_id="x")
    assert both[1] == pln_only[0]
    assert both[0] != both[1]


def test_inputs_from_transactions_and_parsed_rows() -> None:
    txn = Transaction(
        id="t1",
        account_id=ACCOUNT,
        type=TxnType.BUY,
        trade_date=day("2026-01-07"),
        currency=Currency.PLN,
        gross_amount=d("625"),
        cash_amount=d("-628.13"),
        cash_currency=Currency.PLN,
        instrument_id="inst-1",
        quantity=d("10"),
        price=d("62.5"),
        external_ref="R",
    )
    from_txn = DedupInput.from_transaction(txn)
    assert from_txn.instrument_key == "inst-1" and from_txn.external_ref == "R"
    parsed = parsed_txn(TxnType.BUY, quantity="10", price="62.5", gross="625", cash="-628.13")
    (from_parsed,) = parsed_dedup_inputs([parsed], ["inst-1"])
    assert from_parsed.instrument_key == "inst-1"
    with pytest.raises(ValueError):
        parsed_dedup_inputs([parsed], [])


def test_decimal_key_and_reconciliation_hash() -> None:
    assert decimal_key(d("10.50")) == "10.5"
    assert decimal_key(d("1E+1")) == "10"
    assert decimal_key(d("-0.00")) == "0"
    assert decimal_key(d("123456789012345678901234567890.123456789")) == (
        "123456789012345678901234567890.123456789"
    ), "no context rounding"
    assert decimal_key(None) == ""
    first = reconciliation_hash(ACCOUNT, "i", day("2026-01-31"), TxnType.ADJUSTMENT, d("2.0"))
    assert first == reconciliation_hash(ACCOUNT, "i", day("2026-01-31"), TxnType.ADJUSTMENT, d("2"))
    assert first != reconciliation_hash(
        ACCOUNT, "i", day("2026-01-31"), TxnType.TRANSFER_OUT, d("2")
    )


# --- R9 ordering -------------------------------------------------------------------------------


def row(ref: str, trade_date: str, at: time | None = None):
    return parsed_txn(TxnType.BUY, trade_date=trade_date, trade_time=at, external_ref=ref)


def ordered(rows) -> list[str]:
    ranks = chronological_ranks(rows)
    return [r.external_ref for _, r in sorted(zip(ranks, rows, strict=True), key=lambda p: p[0])]


def test_newest_first_file_keeps_same_day_order_via_reversal() -> None:
    rows = [row("r3", "2026-01-08"), row("r2", "2026-01-07"), row("r1", "2026-01-07")]
    assert is_newest_first(rows)
    assert ordered(rows) == ["r1", "r2", "r3"]


def test_single_day_newest_first_file_is_ordered_by_time_of_day_r9() -> None:
    rows = [row("r2", "2026-09-02", time(15)), row("r1", "2026-09-02", time(10))]
    assert is_newest_first(rows)
    assert ordered(rows) == ["r1", "r2"]


def test_times_order_rows_of_a_date_untimed_dates_keep_direction_aware_file_order() -> None:
    rows = [
        row("b2", "2026-09-03", time(9)),
        row("a1", "2026-09-01"),
        row("a2", "2026-09-01"),
        row("b1", "2026-09-03", time(8)),
        row("c1", "2026-09-04"),
    ]
    assert not is_newest_first(rows)
    assert ordered(rows) == ["a1", "a2", "b1", "b2", "c1"]


def test_a_date_mixing_timed_and_untimed_rows_uses_file_order() -> None:
    rows = [row("x1", "2026-09-01", time(15)), row("x2", "2026-09-01"), row("x3", "2026-09-02")]
    assert ordered(rows) == ["x1", "x2", "x3"]


def test_created_at_stamps_are_strictly_increasing_in_chronological_order() -> None:
    rows = [row("r2", "2026-09-02", time(15)), row("r1", "2026-09-02", time(10))]
    base = datetime(2026, 9, 3, tzinfo=UTC)
    stamps = created_at_stamps(rows, base)
    assert stamps == (base + timedelta(milliseconds=1), base)
    assert chronological_ranks([]) == () and not is_newest_first([row("a", "2026-01-01")])


# --- R5 amounts --------------------------------------------------------------------------------


def test_derive_cash_across_currencies_uses_fx_rate_r5() -> None:
    usd, pln = Currency.USD, Currency.PLN
    amounts = derive_amounts(
        txn_type=TxnType.BUY,
        currency=usd,
        cash_currency=pln,
        quantity=d("10"),
        price=d("100"),
        fee=d("1"),
        fx_rate=d("4.0"),
    )
    assert (amounts.gross_amount, amounts.cash_amount) == (d("1000"), d("-4004"))
    with pytest.raises(AmountError, match="fx_rate"):
        derive_amounts(
            txn_type=TxnType.BUY, currency=usd, cash_currency=pln, quantity=d("1"), price=d("1")
        )
    dividend = derive_amounts(
        txn_type=TxnType.DIVIDEND, currency=usd, cash_currency=pln, cash=d("40"), fx_rate=d("4")
    )
    assert dividend.gross_amount == d("10")
    with pytest.raises(AmountError, match="gross_amount is empty"):
        derive_amounts(txn_type=TxnType.DIVIDEND, currency=usd, cash_currency=pln, cash=d("40"))


def test_derive_amount_rules() -> None:
    pln = Currency.PLN
    fee_only = derive_amounts(txn_type=TxnType.FEE, currency=pln, cash_currency=pln, fee=d("2"))
    assert (fee_only.gross_amount, fee_only.cash_amount) == (d("0"), d("-2"))
    split = derive_amounts(txn_type=TxnType.SPLIT, currency=pln, cash_currency=pln)
    assert (split.gross_amount, split.cash_amount) == (d("0"), d("0"))
    with pytest.raises(AmountError, match="no amount"):
        derive_amounts(txn_type=TxnType.BUY, currency=pln, cash_currency=pln)
    with pytest.raises(AmountError, match="fx_conversion rows need a cash_amount"):
        derive_amounts(
            txn_type=TxnType.FX_CONVERSION, currency=pln, cash_currency=pln, gross=d("5")
        )
    assert gross_from_cash(TxnType.SELL, d("98"), d("1"), d("1")) == d("100")
    assert gross_from_cash(TxnType.BUY, d("-102"), d("1"), d("1")) == d("100")
    with pytest.raises(AmountError, match="exceed"):
        gross_from_cash(TxnType.BUY, d("-1"), d("2"), d("0"))
    assert cash_from_gross(TxnType.DEPOSIT, d("5"), d("0"), d("0")) == d("5")
    assert cash_from_gross(TxnType.TRANSFER_IN, d("5"), d("0"), d("0")) == d("0")
    assert to_cash_currency(d("0"), Currency.USD, pln, None) == d("0"), "zero needs no rate"
    assert to_trade_currency(d("10"), Currency.USD, pln, d("3")) == d("3.3333333333")


def test_signed_cash() -> None:
    assert signed_cash(TxnType.BUY, d("5"), absolute=True) == d("-5")
    assert signed_cash(TxnType.SELL, d("-5"), absolute=True) == d("5")
    assert signed_cash(TxnType.TRANSFER_IN, d("-5"), absolute=True) == d("-5")
    assert signed_cash(TxnType.BUY, d("5"), absolute=False) == d("5")
    with pytest.raises(AmountError):
        signed_cash(TxnType.FX_CONVERSION, d("5"), absolute=True)
