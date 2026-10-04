"""Allocation (port of allocation_test.dart incl. R1 unclassified share and R2 cash history gap)."""

from __future__ import annotations

import math
from dataclasses import replace

import pytest
from inv_portfolio_fixtures import (
    EUR,
    PLN,
    USD,
    bar,
    buy,
    cash_txn,
    d,
    day,
    fx_rate,
    instrument,
    market_view,
    new_id,
)

from finanse.modules.investments.domain import (
    AllocationPlan,
    AssetClass,
    BucketDef,
    BucketMatch,
    ValuedCash,
    ValuedPortfolio,
)
from finanse.modules.investments.portfolio import (
    InMemoryFxLookup,
    allocate,
    build_snapshot,
    matches_bucket,
    matches_cash_bucket,
    value_portfolio,
)

PROFILE = new_id()
ACC = new_id()
IKE = new_id()
VWCE = instrument(
    name="World ETF",
    symbol="VWCE",
    mic="XETR",
    asset_class=AssetClass.ETF,
    tags=["global_equity", "accumulating"],
)
PKN = instrument()  # Orlen, XWAR equity
AAPL = instrument(name="Apple", symbol="AAPL", mic="XNAS", currency=USD)
BOND = instrument(name="EDO bond", symbol="EDO", mic=None, asset_class=AssetClass.TREASURY_BOND)
GOLD = instrument(name="Gold ETC", symbol="GLD", mic="XETR", asset_class=AssetClass.COMMODITY)
MONEY_MARKET = instrument(name="Money market", symbol="MM", mic=None, asset_class=AssetClass.CASH)
AS_OF = "2026-03-10"
FX = InMemoryFxLookup([fx_rate(USD, "2026-03-10", "4.00")])

MARKET = market_view(
    AS_OF,
    instruments=[VWCE, PKN, AAPL, BOND, GOLD, MONEY_MARKET],
    bars=[
        *(bar(i.id, AS_OF, "100") for i in [VWCE, PKN, BOND, GOLD, MONEY_MARKET]),
        bar(AAPL.id, AS_OF, "25"),  # 25 USD x 4.00 = 100 PLN
    ],
)


def value_of(txns):
    snapshot = build_snapshot(PROFILE, txns, day(AS_OF), profile_accounts={ACC, IKE})
    return value_portfolio(snapshot, MARKET, FX, PLN, 5)


def bucket(bucket_id, asset_classes=(), mics=()):
    return BucketDef(id=bucket_id, match=BucketMatch(asset_classes=asset_classes, mics=mics))


# The ARCHITECTURE example plan.
PLAN = AllocationPlan(
    buckets=(
        BucketDef(
            id="global_equity",
            match=BucketMatch(asset_classes={AssetClass.ETF}, tags={"global_equity"}),
        ),
        bucket("pl_equity", {AssetClass.EQUITY}, {"XWAR"}),
        bucket("bonds", {AssetClass.BOND, AssetClass.TREASURY_BOND}),
        bucket("cash", {AssetClass.CASH}),
    ),
    targets={"global_equity": 0.60, "pl_equity": 0.15, "bonds": 0.20, "cash": 0.05},
)

# VWCE 3000, PKN 500, bond 1000, gold 250 (unclassified), cash 250: total 5000.
EXAMPLE_PORTFOLIO = [
    cash_txn(ACC, "2026-01-02", "5000"),
    buy(ACC, VWCE.id, "2026-01-05", "30", "100"),
    buy(ACC, PKN.id, "2026-01-05", "5", "100"),
    buy(ACC, BOND.id, "2026-01-05", "10", "100"),
    buy(ACC, GOLD.id, "2026-01-05", "2.5", "100"),
]


def test_weights_drift_and_drift_values_unclassified_holdings_dilute_the_buckets():
    result = allocate(value_of(EXAMPLE_PORTFOLIO), PLAN)

    assert result.total_base == d("5000")
    assert [a.bucket_id for a in result.allocations] == [
        "global_equity",
        "pl_equity",
        "bonds",
        "cash",
    ]
    by_id = {a.bucket_id: a for a in result.allocations}

    pl = by_id["pl_equity"]
    assert pl.value_base == d("500")
    assert pl.weight == pytest.approx(0.10)
    assert pl.target == 0.15
    assert pl.drift_pp == pytest.approx(-5)
    assert pl.drift_rel == pytest.approx(-1 / 3)
    assert pl.drift_value_base == d("-250")  # 500 - 0.15 x 5000

    global_equity = by_id["global_equity"]
    assert (global_equity.value_base, global_equity.drift_value_base) == (d("3000"), d("0"))
    assert global_equity.weight == pytest.approx(0.60)
    assert global_equity.drift_pp == pytest.approx(0, abs=1e-9)

    assert by_id["bonds"].value_base == d("1000")
    assert by_id["cash"].value_base == d("250")
    assert by_id["cash"].weight == pytest.approx(0.05)

    (unclassified,) = result.unclassified
    assert unclassified.instrument == GOLD
    assert result.unclassified_value_base == d("250")
    assert result.unclassified_weight == pytest.approx(0.05)  # R1: rules skip above the limit
    assert result.unallocated_cash_base == d("0")
    assert sum(a.weight for a in result.allocations) == pytest.approx(0.95)
    assert [h.instrument for h in result.holdings_by_bucket["global_equity"]] == [VWCE]
    assert "cash" not in result.holdings_by_bucket  # cash is not a holding
    assert result.allocation("bonds") is by_id["bonds"]
    assert result.allocation("nope") is None


def test_untagged_imported_etf_is_unclassified_r1():
    imported = instrument(
        name="Vanguard FTSE All-World",
        symbol="VWRL",
        mic="XAMS",
        asset_class=AssetClass.ETF,
        needs_classification=True,
    )
    market = replace(
        MARKET,
        instruments={**MARKET.instruments, imported.id: imported},
        bars={**MARKET.bars, imported.id: (bar(imported.id, AS_OF, "100"),)},
    )
    snapshot = build_snapshot(
        PROFILE,
        [cash_txn(ACC, "2026-01-02", "10000"), buy(ACC, imported.id, "2026-01-05", "90", "100")],
        day(AS_OF),
    )
    result = allocate(value_portfolio(snapshot, market, FX, PLN, 5), PLAN)
    # 9000 of 10000 sit in no bucket: global_equity looks 60 pp underweight unless rules check this.
    assert result.unclassified_weight == pytest.approx(0.9)
    assert result.allocation("global_equity").weight == 0.0


def test_the_first_matching_bucket_in_declaration_order_wins():
    portfolio = value_of(
        [
            buy(ACC, PKN.id, "2026-01-05", "1", "100"),
            buy(ACC, AAPL.id, "2026-01-05", "4", "25", currency=USD),
        ]
    )
    specific_first = AllocationPlan(
        buckets=(
            bucket("pl_equity", {AssetClass.EQUITY}, {"XWAR"}),
            bucket("equity", {AssetClass.EQUITY}),
        ),
        targets={"pl_equity": 0.5, "equity": 0.5},
    )
    general_first = AllocationPlan(
        buckets=tuple(reversed(specific_first.buckets)), targets=specific_first.targets
    )

    specific = allocate(portfolio, specific_first)
    assert [h.instrument for h in specific.holdings_by_bucket["pl_equity"]] == [PKN]
    assert [h.instrument for h in specific.holdings_by_bucket["equity"]] == [AAPL]
    assert [a.value_base for a in specific.allocations] == [d("100"), d("400")]

    general = allocate(portfolio, general_first)
    assert [h.instrument for h in general.holdings_by_bucket["equity"]] == [PKN, AAPL]
    assert "pl_equity" not in general.holdings_by_bucket
    assert [(a.bucket_id, a.value_base) for a in general.allocations] == [
        ("equity", d("500")),
        ("pl_equity", d("0")),
    ]


def test_raw_cash_goes_to_the_first_bucket_matching_cash_in_its_currency():
    portfolio = value_of(
        [
            cash_txn(ACC, "2026-01-02", "350"),
            cash_txn(IKE, "2026-01-02", "100", currency=USD),  # 400 PLN
            buy(ACC, PKN.id, "2026-01-05", "1", "100"),
            buy(ACC, MONEY_MARKET.id, "2026-01-05", "1", "100"),
        ]
    )

    catch_all_last = allocate(
        portfolio,
        AllocationPlan(
            buckets=(bucket("cash", {AssetClass.CASH}), bucket("everything")),
            targets={"cash": 0.1, "everything": 0.9},
        ),
    )
    # The money-market fund (asset class cash) is matched like any instrument.
    assert [(a.bucket_id, a.value_base) for a in catch_all_last.allocations] == [
        ("cash", d("650")),  # 150 PLN + 400 PLN from USD + the 100 PLN money-market fund
        ("everything", d("100")),
    ]
    assert catch_all_last.total_base == d("750")

    # A catch-all matches cash too; declared first it takes everything (the loader warns about that).
    catch_all_first = allocate(
        portfolio,
        AllocationPlan(
            buckets=(bucket("everything"), bucket("cash", {AssetClass.CASH})),
            targets={"everything": 0.9, "cash": 0.1},
        ),
    )
    assert [a.value_base for a in catch_all_first.allocations] == [d("750"), d("0")]

    by_currency = allocate(
        portfolio,
        AllocationPlan(
            buckets=(
                bucket("stocks", {AssetClass.EQUITY}),
                BucketDef(
                    id="pln_cash",
                    match=BucketMatch(asset_classes={AssetClass.CASH}, currencies={PLN}),
                ),
                BucketDef(
                    id="usd_cash",
                    match=BucketMatch(asset_classes={AssetClass.CASH}, currencies={USD}),
                ),
            ),
            targets={"stocks": 0.5, "pln_cash": 0.25, "usd_cash": 0.25},
        ),
    )
    assert [(a.bucket_id, a.value_base) for a in by_currency.allocations] == [
        ("stocks", d("100")),
        ("pln_cash", d("250")),  # 150 raw PLN cash + the PLN money-market fund
        ("usd_cash", d("400")),
    ]

    no_cash_bucket = allocate(
        portfolio,
        AllocationPlan(buckets=(bucket("stocks", {AssetClass.EQUITY}),), targets={"stocks": 1.0}),
    )
    assert no_cash_bucket.unallocated_cash_base == d("550")
    assert [h.instrument for h in no_cash_bucket.unclassified] == [MONEY_MARKET]
    assert no_cash_bucket.total_base == d("750")
    assert no_cash_bucket.allocations[0].weight == pytest.approx(100 / 750)


def test_bucket_without_target_target_without_bucket_and_duplicate_bucket_ids():
    result = allocate(
        value_of(
            [
                cash_txn(ACC, "2026-01-02", "2000"),
                buy(ACC, PKN.id, "2026-01-05", "10", "100"),
                buy(ACC, VWCE.id, "2026-01-05", "10", "100"),
            ]
        ),
        AllocationPlan(
            buckets=(
                bucket("pl", {AssetClass.EQUITY}),
                bucket("pl", {AssetClass.ETF}),  # duplicate id: one bucket, an alternative match
                bucket("empty", {AssetClass.CRYPTO}),
            ),
            targets={"pl": 0.5, "bonds": 0.5},
        ),
    )

    assert [a.bucket_id for a in result.allocations] == ["pl", "empty", "bonds"]
    pl, empty, bonds = result.allocations
    assert (pl.value_base, pl.weight, pl.drift_rel, pl.drift_value_base) == (
        d("2000"),
        1.0,
        1.0,
        d("1000"),
    )
    assert (empty.target, empty.weight, empty.drift_rel) == (0.0, 0.0, 0.0)
    assert (bonds.value_base, bonds.drift_rel, bonds.drift_value_base) == (d("0"), -1.0, d("-1000"))
    assert result.unclassified == ()

    overweight_untargeted = allocate(
        value_of([cash_txn(ACC, "2026-01-02", "100"), buy(ACC, PKN.id, "2026-01-05", "1", "100")]),
        AllocationPlan(buckets=(bucket("pl", {AssetClass.EQUITY}),), targets={}),
    )
    (only,) = overweight_untargeted.allocations
    assert only.drift_rel == math.inf
    assert only.drift_value_base == d("100")


def test_negative_cash_counts_as_zero_and_flags_its_bucket_r2():
    valued = value_of(
        [
            cash_txn(ACC, "2026-01-02", "1000"),
            buy(ACC, PKN.id, "2026-01-05", "30", "100"),  # 3000 PLN: 2000 of deposits are missing
            cash_txn(IKE, "2026-01-02", "500"),
        ]
    )
    assert [c.amount_base for c in valued.cash] == [d("-2000"), d("500")]
    result = allocate(valued, PLAN)
    assert result.total_base == d("3500")  # PKN 3000 + IKE cash 500; the negative balance is 0
    cash = result.allocation("cash")
    assert (cash.value_base, cash.cash_history_gap) == (d("500"), True)
    assert [a.bucket_id for a in result.allocations if a.cash_history_gap] == ["cash"]


def test_holdings_without_a_price_are_classified_but_add_no_value():
    unpriced = instrument(name="Unpriced", symbol="UNP")
    view = market_view(AS_OF, instruments=[PKN, unpriced], bars=[bar(PKN.id, AS_OF, "100")])
    portfolio = value_portfolio(
        build_snapshot(
            PROFILE,
            [
                cash_txn(ACC, "2026-01-02", "200"),
                buy(ACC, PKN.id, "2026-01-05", "1", "100"),
                buy(ACC, unpriced.id, "2026-01-05", "1", "100"),
            ],
            day(AS_OF),
        ),
        view,
        FX,
        PLN,
        5,
        last_known_prices={},  # no fallback to the trade price
    )

    result = allocate(
        portfolio,
        AllocationPlan(buckets=(bucket("equity", {AssetClass.EQUITY}),), targets={"equity": 1}),
    )

    assert len(result.holdings_by_bucket["equity"]) == 2
    assert result.allocations[0].value_base == d("100")
    assert result.total_base == d(
        "100"
    )  # cash is 0 after both buys; only the priced holding counts


def test_the_account_filter_allocates_only_the_given_accounts():
    portfolio = value_of(
        [
            cash_txn(ACC, "2026-01-02", "1000"),
            cash_txn(IKE, "2026-01-02", "400"),
            buy(ACC, PKN.id, "2026-01-05", "10", "100"),
            buy(IKE, VWCE.id, "2026-01-05", "3", "100"),
        ]
    )

    result = allocate(portfolio, PLAN, account_ids={IKE})

    assert result.total_base == d("400")
    by_id = {a.bucket_id: a for a in result.allocations}
    assert by_id["global_equity"].weight == pytest.approx(0.75)
    assert by_id["cash"].value_base == d("100")
    assert by_id["pl_equity"].value_base == d("0")
    assert allocate(portfolio, PLAN).total_base == d("1400")


def test_a_hand_built_portfolio_allocates_its_listed_cash_filtered_by_account():
    snapshot = build_snapshot(
        PROFILE,
        [cash_txn(ACC, "2026-01-02", "300"), cash_txn(IKE, "2026-01-02", "50", currency=USD)],
        day(AS_OF),
    )
    hand_built = ValuedPortfolio(
        snapshot=snapshot,
        base_currency=PLN,
        cash=(
            ValuedCash(cash=snapshot.cash[0], amount_base=d("300")),
            ValuedCash(cash=snapshot.cash[1], amount_base=d("200")),  # 50 USD x 4.00
        ),
        cash_base=d("500"),
        total_base=d("500"),
        stale_weight=0,
    )
    cash_only = AllocationPlan(buckets=(bucket("cash", {AssetClass.CASH}),), targets={"cash": 1})

    assert allocate(hand_built, cash_only).allocations[0].value_base == d("500")
    assert allocate(hand_built, cash_only, account_ids={ACC}).allocations[0].value_base == d("300")
    assert allocate(hand_built, cash_only, account_ids={IKE}).allocations[0].value_base == d("200")


# --- matches_bucket -----------------------------------------------------------------------------

TAGGED = instrument(
    symbol="IWDA",
    mic="xams",
    currency=EUR,
    asset_class=AssetClass.ETF,
    tags=["Global_Equity", "accumulating", "developed"],
)


def test_an_empty_match_accepts_every_instrument():
    assert matches_bucket(BucketMatch(), TAGGED)
    assert matches_bucket(BucketMatch(), PKN)


def test_a_set_criterion_matches_any_of_its_elements():
    bonds = BucketMatch(asset_classes={AssetClass.BOND, AssetClass.TREASURY_BOND})
    assert matches_bucket(bonds, BOND)
    assert not matches_bucket(bonds, PKN)
    assert matches_bucket(BucketMatch(mics={"XWAR", "XAMS"}), TAGGED)  # case-insensitive
    assert not matches_bucket(BucketMatch(mics={"XWAR"}), BOND)  # no mic
    assert matches_bucket(BucketMatch(currencies={USD, EUR}), TAGGED)
    assert not matches_bucket(BucketMatch(currencies={USD}), PKN)
    assert matches_bucket(BucketMatch(instrument_ids={PKN.id, BOND.id}), PKN)
    assert not matches_bucket(BucketMatch(instrument_ids={BOND.id}), PKN)


def test_tags_must_all_be_present_case_insensitive():
    assert matches_bucket(BucketMatch(tags={"global_equity", "accumulating"}), TAGGED)
    assert not matches_bucket(BucketMatch(tags={"global_equity", "distributing"}), TAGGED)
    assert not matches_bucket(BucketMatch(tags={"global_equity"}), PKN)


def test_every_set_criterion_must_hold():
    etf_with_tag = BucketMatch(asset_classes={AssetClass.ETF}, tags={"global_equity"})
    assert matches_bucket(etf_with_tag, TAGGED)
    assert matches_bucket(etf_with_tag, VWCE)
    assert not matches_bucket(etf_with_tag, GOLD)  # wrong asset class
    assert not matches_bucket(etf_with_tag, replace(TAGGED, tags=("developed",)))
    assert not matches_bucket(etf_with_tag, replace(TAGGED, asset_class=AssetClass.FUND))
    pl_equity = BucketMatch(asset_classes={AssetClass.EQUITY}, mics={"XWAR"}, currencies={PLN})
    assert matches_bucket(pl_equity, PKN)
    assert not matches_bucket(pl_equity, AAPL)


def test_raw_cash_matches_buckets_taking_cash_and_no_instrument_only_criteria():
    assert matches_cash_bucket(BucketMatch(asset_classes={AssetClass.CASH}), USD)
    assert matches_cash_bucket(BucketMatch(), PLN)
    assert not matches_cash_bucket(BucketMatch(asset_classes={AssetClass.ETF}), PLN)
    assert matches_cash_bucket(BucketMatch(currencies={PLN}), PLN)
    assert not matches_cash_bucket(BucketMatch(asset_classes={AssetClass.CASH}, tags={"x"}), PLN)
    assert not matches_cash_bucket(
        BucketMatch(asset_classes={AssetClass.CASH}, currencies={PLN}), USD
    )
