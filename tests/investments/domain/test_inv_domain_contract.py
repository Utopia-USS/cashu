"""Domain contract: value types, enums, models and portfolio shapes (port of value_types_test.dart and
the portfolio-shape part of contracts_test.dart, plus the Stage 2 additions)."""

from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from finanse.modules.investments import domain
from finanse.modules.investments.domain import (
    ALL_WARNING_TYPES,
    DEFAULT_MAX_FX_AGE_DAYS,
    AccountWrapper,
    AliasNamespace,
    AllocationPlan,
    AllocationResult,
    AssetClass,
    BucketAllocation,
    BucketDef,
    BucketMatch,
    CashHistoryGap,
    Currency,
    DecisionAction,
    FxQuote,
    HistoryGap,
    Holding,
    Instrument,
    InstrumentAlias,
    InstrumentRename,
    InstrumentStatus,
    ManualValuation,
    MarketView,
    MissingInstrument,
    MissingPrice,
    Money,
    OpenLot,
    PortfolioSnapshot,
    PortfolioWarning,
    PriceBar,
    RealizedTrade,
    SignalSeverity,
    SignalStatus,
    Transaction,
    TxnSource,
    TxnType,
    ValuationMode,
    ValuedCash,
    ValuedHolding,
    ValuedPortfolio,
    ValuedRealizedTrade,
    chronological_key,
    default_valuation_mode,
    divided_by,
    placeholder_instrument,
    severity_rank,
)


def d(value: str) -> Decimal:
    return Decimal(value)


def day(iso: str) -> date:
    return date.fromisoformat(iso)


def test_every_exported_name_resolves():
    assert sorted(domain.__all__) == sorted(set(domain.__all__))
    for name in domain.__all__:
        assert getattr(domain, name) is not None, name


# --- currency, money, decimals ------------------------------------------------------------------


def test_currency_normalizes_and_validates_iso_codes():
    assert Currency(" usd ") == Currency.USD
    assert Currency.PLN == "PLN"
    assert {Currency("eur"): 1}["EUR"] == 1  # a str subclass: works as a key next to plain codes
    for bad in ("US", "US1", "", "EURO"):
        with pytest.raises(ValueError):
            Currency(bad)


def test_money_adds_within_one_currency_and_refuses_to_mix():
    total = Money(d("10.50"), Currency.PLN) + Money(d("0.5"), Currency.PLN)
    assert total == Money(d("11"), Currency.PLN)
    assert (-total).amount == d("-11")
    assert (total - Money(d("1"), Currency.PLN)).amount == d("10")
    assert Money.zero(Currency.EUR).amount == 0
    assert str(total) == "11.00 PLN"
    with pytest.raises(ValueError, match="Currency mismatch"):
        total + Money(d("1"), Currency.USD)


def test_divided_by_rounds_half_up_to_the_requested_scale():
    assert divided_by(d("32"), d("3")) == d("10.6666666667")
    assert divided_by(d("2"), d("3"), scale=2) == d("0.67")
    assert divided_by(d("1"), d("8"), scale=2) == d("0.13")  # tie away from zero
    assert divided_by(d("-1"), d("8"), scale=2) == d("-0.13")
    assert divided_by(d("-1"), d("3"), scale=4) == d("-0.3333")
    assert divided_by(d("10"), d("4")) == d("2.5")
    with pytest.raises(ArithmeticError):
        divided_by(d("1"), d("0"))


# --- enums --------------------------------------------------------------------------------------


def test_enum_values_are_snake_case_wire_names_and_round_trip():
    assert TxnType.FX_CONVERSION.value == "fx_conversion"
    assert AssetClass("treasury_bond") is AssetClass.TREASURY_BOND
    assert TxnType.TRANSFER_IN == "transfer_in"
    with pytest.raises(ValueError):
        TxnType("transferIn")
    for enum in (
        AccountWrapper,
        AssetClass,
        TxnType,
        TxnSource,
        ValuationMode,
        InstrumentStatus,
        SignalSeverity,
        SignalStatus,
        DecisionAction,
    ):
        for member in enum:
            assert enum(member.value) is member
            assert member.value == member.value.lower()
            assert member.name.lower() == member.value


def test_stage_2_enum_additions():
    assert AssetClass.CLAIM.value == "claim"
    assert [m.value for m in ValuationMode] == ["market", "cost", "manual"]
    assert [m.value for m in InstrumentStatus] == ["active", "delisted", "frozen"]


def test_default_valuation_modes_and_severity_order():
    assert default_valuation_mode(AssetClass.TREASURY_BOND) == ValuationMode.COST
    assert default_valuation_mode(AssetClass.CLAIM) == ValuationMode.MANUAL
    assert default_valuation_mode(AssetClass.ETF) == ValuationMode.MARKET
    assert severity_rank(SignalSeverity.INFO) < severity_rank(SignalSeverity.ACTION)
    assert DEFAULT_MAX_FX_AGE_DAYS == 10


# --- models -------------------------------------------------------------------------------------


def instrument(**kwargs) -> Instrument:
    base = {"id": "i1", "name": "Orlen", "currency": Currency.PLN, "asset_class": AssetClass.EQUITY}
    return Instrument(**{**base, **kwargs})


def test_instrument_alias_prefers_a_confirmed_alias_over_a_guess():
    pkn = instrument(
        aliases=[
            InstrumentAlias(AliasNamespace.STOOQ, "pkn_guess", guessed=True),
            InstrumentAlias(AliasNamespace.STOOQ, "pkn"),
            InstrumentAlias(AliasNamespace.YAHOO, "PKN.WA", guessed=True),
        ]
    )
    assert pkn.alias(AliasNamespace.STOOQ) == "pkn"
    assert pkn.alias(AliasNamespace.YAHOO) == "PKN.WA"
    assert pkn.alias(AliasNamespace.ISIN) is None
    assert str(pkn.aliases[0]) == "stooq:pkn_guess (guessed)"
    assert isinstance(pkn.aliases, tuple)  # lists are frozen into tuples


def test_instrument_defaults_and_immutability():
    pkn = instrument(tags=["pl"])
    assert pkn.valuation_mode == ValuationMode.MARKET
    assert pkn.status == InstrumentStatus.ACTIVE
    assert pkn.fetches_market_data is True
    assert pkn.tags == ("pl",)
    assert pkn.label == "Orlen"
    assert instrument(symbol="PKN").label == "PKN"
    assert instrument(asset_class=AssetClass.TREASURY_BOND).valuation_mode == ValuationMode.COST
    # An explicit mode wins over the asset-class default and survives replace().
    explicit = instrument(asset_class=AssetClass.TREASURY_BOND, valuation_mode=ValuationMode.MANUAL)
    assert replace(explicit, name="EDO").valuation_mode == ValuationMode.MANUAL
    assert instrument(status=InstrumentStatus.DELISTED).fetches_market_data is False
    with pytest.raises(FrozenInstanceError):
        pkn.name = "x"  # type: ignore[misc]
    placeholder = placeholder_instrument("x", Currency.USD)
    assert (placeholder.asset_class, placeholder.needs_classification) == (AssetClass.OTHER, True)


def txn(txn_id: str, trade_date: str = "2026-01-05", created_at: datetime | None = None, **kwargs):
    base = {
        "id": txn_id,
        "account_id": "a",
        "type": TxnType.BUY,
        "trade_date": day(trade_date),
        "currency": Currency.PLN,
        "gross_amount": d("1000"),
        "cash_amount": d("-1000"),
        "cash_currency": Currency.PLN,
        "instrument_id": "i1",
        "quantity": d("10"),
        "price": d("100"),
    }
    if created_at is not None:
        base["created_at"] = created_at
    return Transaction(**{**base, **kwargs})


def test_transaction_defaults_and_value_equality():
    a, b = txn("t1"), txn("t1")
    assert a == b
    assert (a.fee, a.tax, a.source) == (0, 0, TxnSource.IMPORT)
    assert replace(a, type=TxnType.SELL) != a
    with pytest.raises(ValueError):
        txn("t2", quantity=d("-1"))
    with pytest.raises(ValueError):
        txn("t3", gross_amount=d("-1"))


def test_chronological_key_orders_by_trade_date_created_at_then_id():
    t0 = datetime(2026, 1, 1, 10, tzinfo=UTC)
    late = txn("a", trade_date="2026-01-06", created_at=t0)
    second = txn("b", created_at=t0 + timedelta(microseconds=1))
    first = txn("c", created_at=t0)
    first_tie = txn("d", created_at=t0)
    ordered = sorted([late, second, first_tie, first], key=chronological_key)
    assert [t.id for t in ordered] == ["c", "d", "b", "a"]


def test_stage_2_reference_types():
    valuation = ManualValuation(
        instrument_id="i1", as_of=day("2026-01-01"), unit_value=d("0"), currency=Currency.USD
    )
    assert valuation.unit_value == 0
    rename = InstrumentRename(
        date=day("2026-02-01"), old_instrument_id="old", new_instrument_id="new"
    )
    assert (rename.old_instrument_id, rename.new_instrument_id) == ("old", "new")


# --- portfolio shapes ---------------------------------------------------------------------------


def lot(quantity: str, cost: str | None, currency: Currency = Currency.PLN) -> OpenLot:
    return OpenLot(
        account_id="a",
        instrument_id="i",
        open_txn_id="t",
        open_date=day("2026-01-05"),
        quantity=d(quantity),
        unit_cost=None if cost is None else d(cost),
        currency=currency,
    )


def test_holding_getters_sum_lot_costs_and_flag_unknown_or_mixed_costs():
    known = Holding("a", "i", Currency.PLN, d("3"), (lot("1", "10"), lot("2", "11")))
    unknown = Holding("a", "i", Currency.PLN, d("1"), (lot("1", None),))
    mixed = Holding("a", "i", Currency.PLN, d("2"), (lot("1", "10"), lot("1", "3", Currency.USD)))
    assert known.cost_basis == d("32")
    assert known.average_cost == d("10.6666666667")
    assert known.has_unknown_cost is False
    assert (unknown.cost_basis, unknown.average_cost, unknown.has_unknown_cost) == (
        None,
        None,
        True,
    )
    assert mixed.has_mixed_currencies is True
    assert (mixed.cost_basis, mixed.average_cost) == (None, None)


def test_market_view_window_getters_and_manual_valuations():
    bars = tuple(
        PriceBar(instrument_id="i", date=day(f"2026-01-0{n}"), close=Decimal(n), source="stooq")
        for n in range(1, 6)
    )
    view = MarketView(
        as_of=day("2026-01-05"),
        bars={"i": bars},
        manual_valuations={
            "i": (
                ManualValuation("i", day("2025-12-01"), d("1"), Currency.PLN),
                ManualValuation("i", day("2026-01-03"), d("2"), Currency.PLN),
                ManualValuation("i", day("2026-02-01"), d("3"), Currency.PLN),
            )
        },
    )
    assert view.last_bar("i").close == 5
    assert [b.close for b in view.last_bars("i", 2)] == [4, 5]
    assert len(view.last_bars("i", 10)) == 5
    assert view.series("none") == ()
    assert view.last_bar("none") is None
    assert view.manual_valuation("i").unit_value == 2
    assert view.manual_valuation("i", day("2026-03-01")).unit_value == 3
    assert view.manual_valuation("i", day("2025-01-01")) is None
    assert view.instrument("none") is None


def test_realized_trade_getters_and_history_gap_message():
    trade = RealizedTrade(
        account_id="a",
        instrument_id="i",
        open_txn_id="o",
        close_txn_id="c",
        open_date=day("2025-01-01"),
        close_date=day("2026-01-01"),
        quantity=d("2"),
        close_unit_price=d("12"),
        open_unit_cost=d("10"),
        pnl=d("4"),
        currency=Currency.PLN,
    )
    gap = HistoryGap(
        account_id="a", instrument_id="i", date=day("2026-01-01"), shortfall=d("3"), txn_id="c"
    )
    assert trade.holding_days == 365
    assert trade.cost_currency == Currency.PLN  # defaults to the sale currency
    assert (trade.proceeds, trade.cost) == (d("24"), d("20"))
    assert "needs 3 more units" in gap.message
    assert str(gap) == gap.message


def test_warnings_have_unique_kinds_value_equality_and_account_scope():
    kinds = [w.kind for w in ALL_WARNING_TYPES]
    assert len(kinds) == len(set(kinds))
    assert all(issubclass(w, PortfolioWarning) for w in ALL_WARNING_TYPES)
    gap = CashHistoryGap(
        account_id="a", currency=Currency.PLN, amount=d("-1"), as_of=day("2026-01-01")
    )
    assert gap.account_id == "a"
    assert MissingInstrument(instrument_id="i").account_id is None
    assert MissingPrice("i", day("2026-01-01")) == MissingPrice("i", day("2026-01-01"))
    assert len({MissingPrice("i", day("2026-01-01")), MissingPrice("i", day("2026-01-01"))}) == 1


def test_valued_shapes_getters():
    holding = Holding("a", "i", Currency.PLN, d("1"), (lot("1", "10"),))
    valued = ValuedHolding(
        holding=holding,
        instrument=instrument(id="i"),
        is_stale=False,
        valuation_mode=ValuationMode.COST,
    )
    assert (valued.account_id, valued.instrument_id) == ("a", "i")
    assert (valued.valued_at_cost, valued.valued_manually) == (True, False)
    negative = ValuedCash(cash=domain.CashBalance("a", Currency.PLN, d("-5")), amount_base=d("-5"))
    no_rate = ValuedCash(cash=domain.CashBalance("a", Currency.USD, d("5")))
    assert (negative.counted_base, no_rate.counted_base) == (0, 0)
    assert ValuedRealizedTrade(trade=None, proceeds_base=d("5"), cost_base=d("3")).pnl_base == 2  # type: ignore[arg-type]
    snapshot = PortfolioSnapshot(profile_id="p", as_of=day("2026-01-01"))
    portfolio = ValuedPortfolio(
        snapshot=snapshot,
        base_currency=Currency.PLN,
        cash_base=d("0"),
        total_base=d("0"),
        stale_weight=0.0,
        realized=(ValuedRealizedTrade(trade=None, proceeds_base=d("5")),),  # type: ignore[arg-type]
    )
    assert (portfolio.profile_id, portfolio.as_of) == ("p", day("2026-01-01"))
    assert portfolio.realized_pnl_base is None  # one unknown result makes the sum unknown
    assert FxQuote(rate=d("4"), date=day("2026-01-02")).age_days(day("2026-01-12")) == 10


def test_bucket_contract_normalizes_sets_and_allocation_result_helpers():
    match = BucketMatch(asset_classes=[AssetClass.ETF], tags=["global_equity"])
    assert match.asset_classes == frozenset({AssetClass.ETF})
    assert match.is_empty is False
    assert BucketMatch().is_empty is True
    plan = AllocationPlan(buckets=[BucketDef(id="x", match=match)], targets={"x": 1.0})
    assert isinstance(plan.buckets, tuple)
    assert BucketDef(id="all").match.is_empty
    allocation = BucketAllocation("x", 0.5, 1.0, -50.0, -0.5, d("50"), d("-50"))
    result = AllocationResult(
        total_base=d("100"),
        unclassified_value_base=d("25"),
        unallocated_cash_base=d("0"),
        allocations=(allocation,),
    )
    assert result.unclassified_weight == 0.25
    assert result.allocation("x") is allocation
    assert AllocationResult(d("0"), d("0"), d("0")).unclassified_weight == 0.0
