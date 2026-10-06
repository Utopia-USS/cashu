"""Valuation (port of valuation_test.dart incl. R2/R4/R12/R14/R15, plus manual and frozen valuation)."""

from __future__ import annotations

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
    manual,
    market_view,
    new_id,
    sell,
    transfer_in,
)

from cashu.modules.investments.domain import (
    AssetClass,
    DatedPrice,
    FrozenValuedAtZero,
    HistoryGap,
    InstrumentStatus,
    LastKnownPriceUsed,
    MissingCostBasis,
    MissingFxRate,
    MissingInstrument,
    MissingManualValuation,
    MissingPrice,
    RealizedCurrencyMismatch,
    StaleFxRate,
    StalePrice,
    ValuationMode,
)
from cashu.modules.investments.portfolio import (
    InMemoryFxLookup,
    build_snapshot,
    last_trade_prices,
    value_portfolio,
)

PROFILE = new_id()
ACC = new_id()
IKE = new_id()
PL_STOCK = instrument()  # Orlen, PKN, XWAR, PLN equity
USD_ETF = instrument(
    name="World ETF", symbol="VT", mic="ARCX", currency=USD, asset_class=AssetClass.ETF
)
STALE = instrument(name="Small cap", symbol="SML")
FUND = instrument(name="Bond fund", symbol=None, mic=None, asset_class=AssetClass.FUND)
AS_OF = "2026-03-10"

# NBP-style rates (PLN per unit). 2026-01-02 is a Friday, 2026-01-04 a Sunday.
FX = InMemoryFxLookup(
    [
        fx_rate(USD, "2026-01-02", "3.90"),
        fx_rate(USD, "2026-01-05", "4.00"),
        fx_rate(USD, "2026-03-10", "4.20"),
        fx_rate(EUR, "2026-01-05", "5.00"),
        fx_rate(EUR, "2026-03-10", "4.00"),
    ]
)


def snapshot_of(txns, at=AS_OF):
    return build_snapshot(PROFILE, txns, day(at), profile_accounts={ACC, IKE})


# Hand-computed: A 10 x 120 = 1200; B 5 x 110 USD x 4.20 = 2310; C (stale) 4 x 50 = 200;
# cash 870 PLN + 100 USD x 4.20 = 1290; total 5000.
TXNS = [
    cash_txn(ACC, "2026-01-02", "2110"),
    cash_txn(ACC, "2026-01-02", "600", currency=USD),
    buy(ACC, PL_STOCK.id, "2026-01-05", "10", "100"),  # cost 1000
    buy(ACC, USD_ETF.id, "2026-01-05", "5", "100", currency=USD),  # 500 USD x 4.00 = 2000
    buy(ACC, STALE.id, "2026-01-05", "4", "60"),  # cost 240
]
MARKET = market_view(
    AS_OF,
    instruments=[PL_STOCK, USD_ETF, STALE],
    bars=[
        bar(PL_STOCK.id, "2026-03-06", "118"),
        bar(PL_STOCK.id, "2026-03-09", "120"),
        bar(USD_ETF.id, "2026-03-10", "110"),
        bar(STALE.id, "2026-02-20", "50"),
    ],
)


def test_market_value_cost_basis_cash_weights_and_stale_weight():
    valued = value_portfolio(snapshot_of(TXNS), MARKET, FX, PLN, 5)

    assert valued.base_currency == PLN
    assert valued.as_of == day(AS_OF)
    assert valued.cash_base == d("1290")
    assert valued.total_base == d("5000")
    assert valued.stale_weight == pytest.approx(0.04)

    a, b, c = valued.valued
    assert a.instrument == PL_STOCK
    assert (a.price, a.price_date, a.is_stale) == (d("120"), day("2026-03-09"), False)
    assert (a.market_value_base, a.cost_basis_base) == (d("1200"), d("1000"))
    assert a.unrealized_pct == pytest.approx(0.2)
    assert a.weight == pytest.approx(0.24)
    assert (a.valuation_mode, a.valued_at_cost, a.valued_manually) == (
        ValuationMode.MARKET,
        False,
        False,
    )

    assert (b.price, b.is_stale) == (d("110"), False)
    assert (b.market_value_base, b.cost_basis_base) == (d("2310"), d("2000"))
    assert b.unrealized_pct == pytest.approx(0.155)
    assert b.weight == pytest.approx(0.462)

    assert (c.price, c.price_date, c.is_stale) == (d("50"), day("2026-02-20"), True)
    assert (c.market_value_base, c.cost_basis_base) == (d("200"), d("240"))
    assert c.unrealized_pct == pytest.approx(-1 / 6)
    assert c.weight == pytest.approx(0.04)

    assert valued.warnings == (
        StalePrice(instrument_id=STALE.id, price_date=day("2026-02-20"), age_days=18),
    )
    assert [(c.currency, c.amount_base) for c in valued.cash] == [(PLN, d("870")), (USD, d("420"))]


def test_cost_basis_uses_the_rate_on_or_before_each_lot_date():
    valued = value_portfolio(
        snapshot_of(
            [
                buy(ACC, USD_ETF.id, "2026-01-04", "1", "100", currency=USD),  # 100 x 3.90 (Friday)
                buy(ACC, USD_ETF.id, "2026-01-05", "1", "100", currency=USD),  # 100 x 4.00
            ]
        ),
        MARKET,
        FX,
        PLN,
        5,
    )
    (holding,) = valued.valued
    assert holding.cost_basis_base == d("790")
    assert holding.market_value_base == d("924")  # 2 x 110 x 4.20


def test_a_price_is_stale_only_when_older_than_max_price_age_days():
    snapshot = snapshot_of([buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100")])

    def value_with_bar_on(on: str):
        view = market_view(AS_OF, instruments=[PL_STOCK], bars=[bar(PL_STOCK.id, on, "100")])
        return value_portfolio(snapshot, view, FX, PLN, 5).valued[0]

    assert value_with_bar_on("2026-03-05").is_stale is False  # 5 days
    assert value_with_bar_on("2026-03-04").is_stale is True  # 6 days
    assert value_with_bar_on("2026-03-04").market_value_base == d(
        "100"
    )  # still valued and weighted


def test_bars_after_the_snapshot_date_are_ignored():
    valued = value_portfolio(
        snapshot_of([buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100")]),
        market_view(
            "2026-03-20",
            instruments=[PL_STOCK],
            bars=[bar(PL_STOCK.id, "2026-03-09", "120"), bar(PL_STOCK.id, "2026-03-11", "999")],
        ),
        FX,
        PLN,
        5,
    )
    assert valued.valued[0].price == d("120")


def test_a_missing_price_excludes_the_holding_from_totals_and_weights():
    all_bars = [b for series in MARKET.bars.values() for b in series]
    valued = value_portfolio(
        snapshot_of([*TXNS, buy(ACC, FUND.id, "2026-01-05", "10", "25")]),
        market_view(AS_OF, instruments=[PL_STOCK, USD_ETF, STALE, FUND], bars=all_bars),
        FX,
        PLN,
        5,
        last_known_prices={},  # no fallback: the fund has no price at all
    )
    missing = valued.valued[-1]
    assert missing.instrument_id == FUND.id
    assert (missing.price, missing.price_date, missing.market_value_base, missing.weight) == (
        None,
        None,
        None,
        None,
    )
    assert missing.is_stale is True
    assert missing.cost_basis_base == d("250")
    assert valued.cash_base == d("1040")  # the fund purchase left 250 PLN less cash
    assert valued.total_base == d("4750")
    assert MissingPrice(instrument_id=FUND.id, as_of=day(AS_OF)) in valued.warnings


def test_without_bars_the_last_known_price_is_used_and_flagged_stale():
    fund_txns = [
        cash_txn(ACC, "2026-01-02", "550"),
        buy(ACC, FUND.id, "2026-01-05", "10", "25"),
        buy(ACC, FUND.id, "2026-02-15", "10", "30"),
    ]
    snapshot = snapshot_of(fund_txns)
    view = market_view(AS_OF, instruments=[FUND])

    assert snapshot.last_trade_prices == {
        FUND.id: DatedPrice(date=day("2026-02-15"), price=d("30"), currency=PLN)
    }
    valued = value_portfolio(snapshot, view, FX, PLN, 5)
    explicit = value_portfolio(
        snapshot, view, FX, PLN, 5, last_known_prices=last_trade_prices(fund_txns)
    )
    assert explicit == valued

    (holding,) = valued.valued
    assert (holding.price, holding.price_date, holding.is_stale) == (
        d("30"),
        day("2026-02-15"),
        True,
    )
    assert holding.market_value_base == d("600")
    assert valued.stale_weight == 1.0  # cash is 0, the fund is the whole portfolio
    assert valued.warnings == (
        LastKnownPriceUsed(instrument_id=FUND.id, price_date=day("2026-02-15"), price=d("30")),
    )

    # A "last known" price dated after the snapshot is not used.
    future = {FUND.id: DatedPrice(date=day("2026-04-01"), price=d("31"), currency=PLN)}
    none = value_portfolio(snapshot, view, FX, PLN, 5, last_known_prices=future)
    assert none.valued[0].market_value_base is None
    assert none.warnings == (MissingPrice(instrument_id=FUND.id, as_of=day(AS_OF)),)


def test_instruments_valued_at_cost_use_the_cost_basis_and_are_never_stale():
    bond = instrument(
        name="EDO0536", symbol="EDO0536", mic=None, asset_class=AssetClass.TREASURY_BOND
    )
    usd_bond = instrument(
        name="US T-Bill",
        symbol=None,
        mic=None,
        currency=USD,
        asset_class=AssetClass.BOND,
        valuation_mode=ValuationMode.COST,
    )
    unknown = instrument(name="COI", symbol=None, mic=None, asset_class=AssetClass.TREASURY_BOND)
    assert bond.valuation_mode == ValuationMode.COST
    assert PL_STOCK.valuation_mode == ValuationMode.MARKET
    snapshot = snapshot_of(
        [
            cash_txn(ACC, "2026-01-02", "1500"),
            buy(ACC, bond.id, "2026-01-05", "10", "100"),  # cost 1000 PLN
            buy(ACC, bond.id, "2026-02-02", "5", "100"),  # cost 500 PLN
            buy(ACC, usd_bond.id, "2026-01-05", "1", "100", currency=USD),  # 100 USD x 4.00 = 400
            transfer_in(ACC, unknown.id, "2026-01-05", "3"),  # unknown cost
        ]
    )
    # A stray bar of a cost-valued instrument is ignored.
    view = market_view(
        AS_OF, instruments=[bond, usd_bond, unknown], bars=[bar(bond.id, "2026-01-10", "90")]
    )

    valued = value_portfolio(snapshot, view, FX, PLN, 5)

    b, u, x = valued.valued
    assert (b.market_value_base, b.cost_basis_base, b.price, b.price_date) == (
        d("1500"),
        d("1500"),
        d("100"),
        None,
    )
    assert (b.is_stale, b.valued_at_cost, b.unrealized_pct) == (False, True, 0.0)
    assert (u.market_value_base, u.is_stale, u.valued_at_cost) == (d("400"), False, True)
    assert (x.market_value_base, x.price, x.is_stale, x.valued_at_cost, x.weight) == (
        None,
        None,
        True,
        True,
        None,
    )
    # Cash 1500 - 1500 PLN = 0, -100 USD x 4.20 = -420 counted as 0 (cash history gap, R2);
    # total 1500 + 400 = 1900.
    assert [(c.amount_base, c.counted_base) for c in valued.cash] == [(d("-420"), d("0"))]
    assert valued.total_base == d("1900")
    assert valued.stale_weight == 0
    assert valued.warnings == (MissingCostBasis(account_id=ACC, instrument_id=unknown.id),)
    assert valued.warnings[0].account_id == ACC


def test_missing_fx_rates_leave_the_amounts_out_with_warnings_r4():
    no_usd = InMemoryFxLookup([])
    valued = value_portfolio(
        snapshot_of(
            [
                cash_txn(ACC, "2026-01-02", "100", currency=USD),
                cash_txn(ACC, "2026-01-02", "100"),
                buy(ACC, USD_ETF.id, "2026-01-05", "1", "50", currency=USD),
                buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100"),
            ]
        ),
        MARKET,
        no_usd,
        PLN,
        5,
    )
    etf, stock = valued.valued
    assert etf.price == d("110")
    assert (etf.market_value_base, etf.cost_basis_base, etf.weight, etf.unrealized_pct) == (
        None,
        None,
        None,
        None,
    )
    assert stock.weight == 1.0  # PLN cash is 0, USD cash cannot be converted
    assert valued.cash_base == d("0")
    (usd_cash,) = valued.cash
    assert usd_cash.amount_base is None
    assert usd_cash.cash.amount == d("50")
    assert valued.warnings == (
        MissingFxRate(currency=USD, base=PLN, date=day(AS_OF)),
        MissingFxRate(currency=USD, base=PLN, date=day("2026-01-05")),
    )
    # The gap is visible on the holding and the portfolio, so weight rules can skip.
    assert (etf.missing_fx_currency, etf.price_currency) == (USD, USD)
    assert stock.missing_fx_currency is None
    assert valued.missing_fx_currencies == {USD}


def test_an_fx_rate_older_than_max_fx_age_days_counts_as_missing_r14():
    # The newest USD rate is from 2026-02-20, 18 days before as_of; cost basis rates are fresh.
    old_usd = InMemoryFxLookup(
        [fx_rate(USD, "2026-01-05", "4.00"), fx_rate(USD, "2026-02-20", "4.10")]
    )
    snapshot = snapshot_of(
        [
            cash_txn(ACC, "2026-01-02", "600", currency=USD),
            buy(ACC, USD_ETF.id, "2026-01-05", "5", "100", currency=USD),
            cash_txn(ACC, "2026-01-02", "1000"),
            buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100"),
        ]
    )

    valued = value_portfolio(snapshot, MARKET, old_usd, PLN, 5)
    etf, stock = valued.valued
    assert (etf.market_value_base, etf.weight, etf.missing_fx_currency) == (None, None, USD)
    assert etf.cost_basis_base == d("2000")  # the trade-date rate of 2026-01-05 is fresh
    assert next(c for c in valued.cash if c.currency == USD).amount_base is None
    assert valued.missing_fx_currencies == {USD}
    assert valued.total_base == d("1020")  # PKN 120 + 900 PLN cash
    assert stock.weight == pytest.approx(120 / 1020)
    assert (
        StaleFxRate(
            currency=USD, base=PLN, date=day(AS_OF), rate_date=day("2026-02-20"), age_days=18
        )
        in valued.warnings
    )
    assert not [w for w in valued.warnings if isinstance(w, MissingFxRate)]

    # A looser limit accepts the same rate.
    loose = value_portfolio(snapshot, MARKET, old_usd, PLN, 5, max_fx_age_days=20)
    assert loose.missing_fx_currencies == frozenset()
    assert loose.valued[0].market_value_base == d("2255")  # 5 x 110 x 4.10


def test_price_currency_names_the_currency_of_the_price_r15():
    eur_listed = instrument(name="EUR ETF", symbol="EXX", mic="XETR", currency=EUR)
    mixed_bond = instrument(
        name="Mixed bond",
        symbol=None,
        mic=None,
        asset_class=AssetClass.BOND,
        valuation_mode=ValuationMode.COST,
    )
    valued = value_portfolio(
        snapshot_of(
            [
                cash_txn(ACC, "2026-01-02", "10000"),
                buy(ACC, eur_listed.id, "2026-01-05", "2", "400"),  # lot booked in PLN
                buy(ACC, FUND.id, "2026-01-05", "1", "30", currency=USD),
                buy(ACC, mixed_bond.id, "2026-01-05", "1", "100"),  # 100 PLN
                buy(ACC, mixed_bond.id, "2026-01-05", "1", "50", currency=USD),  # 50 USD x 4.00
            ]
        ),
        market_view(
            AS_OF,
            instruments=[eur_listed, FUND, mixed_bond],
            bars=[bar(eur_listed.id, "2026-03-10", "101")],
        ),
        FX,
        PLN,
        5,
    )
    etf, fund_holding, bond = valued.valued
    assert (etf.price, etf.price_currency, etf.market_value_base) == (d("101"), EUR, d("808"))
    assert etf.holding.currency == PLN  # the lot currency differs from the price currency
    assert (fund_holding.price, fund_holding.price_currency) == (d("30"), USD)  # last trade price
    # Lots in PLN and USD: no average cost in one lot currency, so the price is in the base currency.
    assert bond.holding.average_cost is None
    assert (bond.price, bond.price_currency, bond.market_value_base) == (d("150"), PLN, d("300"))


def test_realized_trades_keep_currencies_apart_and_get_a_base_result_r12():
    eur_etf = instrument(name="EUR ETF", symbol="EXX", mic="XETR", currency=EUR)
    buy_eur = buy(ACC, eur_etf.id, "2026-01-05", "10", "100", currency=EUR)  # 1000 EUR
    sell_pln = sell(ACC, eur_etf.id, "2026-03-10", "10", "440")  # 4400 PLN
    same_pln = [
        buy(ACC, PL_STOCK.id, "2026-01-05", "2", "100"),
        sell(ACC, PL_STOCK.id, "2026-03-10", "2", "130"),
    ]
    snapshot = snapshot_of([buy_eur, sell_pln, *same_pln])

    mixed = next(t for t in snapshot.realized if t.instrument_id == eur_etf.id)
    assert (mixed.currency, mixed.cost_currency, mixed.pnl) == (PLN, EUR, None)
    assert (mixed.proceeds, mixed.cost) == (d("4400"), d("1000"))
    assert snapshot.realized_pnl_by_currency == {PLN: d("60")}  # the mixed trade is never summed
    assert (
        RealizedCurrencyMismatch(
            account_id=ACC,
            instrument_id=eur_etf.id,
            txn_id=sell_pln.id,
            date=day("2026-03-10"),
            sale_currency=PLN,
            lot_currencies=frozenset({EUR}),
        )
        in snapshot.warnings
    )

    valued = value_portfolio(
        snapshot, market_view(AS_OF, instruments=[eur_etf, PL_STOCK]), FX, PLN, 5
    )
    base = next(t for t in valued.realized if t.trade.instrument_id == eur_etf.id)
    # Proceeds 4400 PLN; cost 1000 EUR at the buy-date rate 5.00 = 5000 PLN.
    assert (base.proceeds_base, base.cost_base, base.pnl_base) == (d("4400"), d("5000"), d("-600"))
    assert valued.realized_pnl_base == d("-540")  # -600 + 60


def test_an_unknown_cost_basis_keeps_the_market_value_but_no_cost_numbers():
    valued = value_portfolio(
        snapshot_of([transfer_in(ACC, PL_STOCK.id, "2026-01-05", "10")]), MARKET, FX, PLN, 5
    )
    (holding,) = valued.valued
    assert holding.holding.has_unknown_cost is True
    assert holding.market_value_base == d("1200")
    assert holding.cost_basis_base is None
    assert holding.unrealized_pct is None
    assert holding.weight == 1.0


def test_an_instrument_missing_from_the_market_view_gets_a_placeholder():
    valued = value_portfolio(
        snapshot_of([buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100")]),
        market_view(AS_OF, bars=[bar(PL_STOCK.id, "2026-03-09", "120")]),
        FX,
        PLN,
        5,
    )
    placeholder = valued.valued[0].instrument
    assert placeholder.id == PL_STOCK.id
    assert placeholder.asset_class == AssetClass.OTHER
    assert placeholder.needs_classification is True
    assert valued.valued[0].market_value_base == d("120")
    assert valued.warnings == (MissingInstrument(instrument_id=PL_STOCK.id),)


def test_a_non_pln_base_currency_converts_through_pln_cross_rates():
    valued = value_portfolio(
        snapshot_of(
            [
                buy(ACC, PL_STOCK.id, "2026-01-05", "10", "100"),  # 1000 PLN / 5.00 = 200 EUR
                buy(ACC, USD_ETF.id, "2026-01-05", "5", "100", currency=USD),  # 500x4.00/5.00 = 400
                cash_txn(ACC, "2026-01-02", "1000"),
                cash_txn(ACC, "2026-01-02", "500", currency=USD),
            ]
        ),
        MARKET,
        FX,
        EUR,
        5,
    )
    a, b = valued.valued
    assert (a.market_value_base, a.cost_basis_base) == (d("300"), d("200"))  # 1200 / 4.00
    assert (b.market_value_base, b.cost_basis_base) == (d("577.5"), d("400"))  # 550 x 4.20 / 4.00
    assert valued.cash_base == d("0")  # PLN 0 and USD 0 left after the buys
    assert valued.total_base == d("877.5")


def test_the_account_filter_values_only_the_given_accounts():
    snapshot = snapshot_of(
        [
            cash_txn(ACC, "2026-01-02", "1000"),
            cash_txn(IKE, "2026-01-02", "500"),
            buy(ACC, PL_STOCK.id, "2026-01-05", "5", "100"),
            buy(IKE, PL_STOCK.id, "2026-01-05", "2", "100"),
            sell(IKE, STALE.id, "2026-01-06", "1", "10"),  # gap in IKE
        ]
    )

    valued = value_portfolio(snapshot, MARKET, FX, PLN, 5, account_ids={IKE})

    (holding,) = valued.valued
    assert holding.account_id == IKE
    assert holding.market_value_base == d("240")
    assert valued.cash_base == d("310")  # 500 - 200 + 10
    assert valued.total_base == d("550")
    assert [h.account_id for h in valued.snapshot.holdings] == [IKE]
    (gap,) = valued.snapshot.warnings
    assert isinstance(gap, HistoryGap)
    assert value_portfolio(snapshot, MARKET, FX, PLN, 5, account_ids={ACC}).snapshot.warnings == ()


def test_an_empty_portfolio_has_a_zero_total_and_no_stale_weight():
    valued = value_portfolio(snapshot_of([]), MARKET, FX, PLN, 5)
    assert valued.total_base == d("0")
    assert valued.stale_weight == 0
    assert valued.valued == ()


# --- Stage 2: manual valuation and frozen instruments ------------------------------------------


def test_manual_mode_uses_the_newest_valuation_on_or_before_the_date_and_is_never_stale():
    claim = instrument(name="Exchange claim", symbol=None, mic=None, asset_class=AssetClass.CLAIM)
    assert claim.valuation_mode == ValuationMode.MANUAL  # default for claims
    snapshot = snapshot_of(
        [transfer_in(ACC, claim.id, "2026-01-05", "1000", price="0.4")]  # cost 400 PLN
    )
    view = market_view(
        AS_OF,
        instruments=[claim],
        bars=[bar(claim.id, "2026-03-09", "999")],  # bars are ignored in manual mode
        manual_valuations=[
            manual(claim.id, "2025-12-01", "0.30"),
            manual(claim.id, "2026-02-01", "0.25", USD),  # 1000 x 0.25 USD x 4.20 = 1050 PLN
            manual(claim.id, "2026-04-01", "0.90"),  # after as_of
        ],
    )

    valued = value_portfolio(snapshot, view, FX, PLN, 5)

    (holding,) = valued.valued
    assert (holding.price, holding.price_currency, holding.price_date) == (
        d("0.25"),
        USD,
        day("2026-02-01"),
    )
    assert holding.market_value_base == d("1050")
    assert holding.cost_basis_base == d("400")
    assert (holding.is_stale, holding.valued_manually, holding.valued_at_cost) == (
        False,
        True,
        False,
    )
    assert holding.weight == 1.0
    assert valued.stale_weight == 0
    assert valued.warnings == ()


def test_manual_mode_without_a_valuation_excludes_the_holding():
    private_fund = instrument(
        name="Private fund", symbol=None, mic=None, valuation_mode=ValuationMode.MANUAL
    )
    snapshot = snapshot_of(
        [cash_txn(ACC, "2026-01-02", "1000"), buy(ACC, private_fund.id, "2026-01-05", "1", "500")]
    )
    view = market_view(
        AS_OF,
        instruments=[private_fund],
        manual_valuations=[manual(private_fund.id, "2026-04-01", "600")],  # only after as_of
    )

    valued = value_portfolio(snapshot, view, FX, PLN, 5)

    (holding,) = valued.valued
    assert (holding.price, holding.market_value_base, holding.weight) == (None, None, None)
    assert holding.is_stale is True  # no price at all, like an unpriced market holding
    assert valued.total_base == d("500")  # cash only
    assert valued.warnings == (
        MissingManualValuation(instrument_id=private_fund.id, as_of=day(AS_OF)),
    )


def test_a_frozen_instrument_defaults_to_manual_zero_until_a_valuation_is_set():
    frozen_adr = instrument(
        name="Frozen ADR", symbol="FRZ", mic="XNAS", currency=USD, status=InstrumentStatus.FROZEN
    )
    assert frozen_adr.valuation_mode == ValuationMode.MARKET  # configured mode stays
    assert frozen_adr.fetches_market_data is False
    snapshot = snapshot_of(
        [
            cash_txn(ACC, "2026-01-02", "1000"),
            buy(ACC, frozen_adr.id, "2026-01-05", "10", "20", currency=USD),  # 200 USD x 4.00 = 800
            cash_txn(ACC, "2026-01-02", "200", currency=USD),
        ]
    )
    view = market_view(
        AS_OF, instruments=[frozen_adr], bars=[bar(frozen_adr.id, "2026-03-09", "21")]
    )

    # No rates at all: a value of exactly 0 needs none, so weights stay computable.
    no_fx = value_portfolio(snapshot, view, InMemoryFxLookup([]), PLN, 5)
    (zero,) = no_fx.valued
    assert (zero.price, zero.price_currency, zero.price_date) == (d("0"), USD, None)
    assert (zero.market_value_base, zero.valued_manually, zero.is_stale) == (d("0"), True, False)
    assert zero.missing_fx_currency is None
    assert no_fx.warnings == (
        FrozenValuedAtZero(instrument_id=frozen_adr.id),
        MissingFxRate(currency=USD, base=PLN, date=day("2026-01-05")),
    )

    zero_fx = value_portfolio(snapshot, view, FX, PLN, 5)
    (holding,) = zero_fx.valued
    assert holding.market_value_base == d("0")
    assert holding.cost_basis_base == d("800")
    assert holding.unrealized_pct == pytest.approx(-1.0)
    assert holding.weight == 0.0
    assert zero_fx.total_base == d("1000")

    # A manual valuation set by the owner replaces the default 0.
    valued_later = value_portfolio(
        snapshot,
        market_view(
            AS_OF,
            instruments=[frozen_adr],
            manual_valuations=[manual(frozen_adr.id, "2026-03-01", "5", USD)],
        ),
        FX,
        PLN,
        5,
    )
    (set_by_owner,) = valued_later.valued
    assert set_by_owner.market_value_base == d("210")  # 10 x 5 USD x 4.20
    assert set_by_owner.price_date == day("2026-03-01")
    assert valued_later.warnings == ()


def test_a_delisted_instrument_keeps_its_valuation_mode():
    delisted = instrument(name="Gone", symbol="GON", status=InstrumentStatus.DELISTED)
    assert delisted.fetches_market_data is False
    snapshot = snapshot_of(
        [cash_txn(ACC, "2026-01-02", "100"), buy(ACC, delisted.id, "2026-01-05", "1", "100")]
    )
    valued = value_portfolio(
        snapshot,
        market_view(AS_OF, instruments=[delisted], bars=[bar(delisted.id, "2026-01-20", "80")]),
        FX,
        PLN,
        5,
    )
    (holding,) = valued.valued
    assert (holding.valuation_mode, holding.price, holding.is_stale) == (
        ValuationMode.MARKET,
        d("80"),
        True,
    )
