"""Stage 1 review findings (R1-R15), the pure portfolio part of each Kompas pipeline scenario.

Each scenario runs the real pipeline ``build_snapshot`` -> ``value_portfolio`` -> ``allocate`` and asserts
the corrected numbers. Rule verdicts live with the rules engine; import-side fixes (R5 cash from gross,
R8 dedup, R9 time-of-day ranking, R10 instrument currency) are represented by the transactions an import
with those fixes stores. R3 and R6 (market data) are covered in ``tests/investments/market``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from inv_portfolio_fixtures import (
    EUR,
    PLN,
    USD,
    build_txn,
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
    CashHistoryGap,
    MissingFxRate,
    MissingPrice,
    PriceBar,
    RealizedCurrencyMismatch,
    StaleFxRate,
    TxnSource,
    TxnType,
)
from finanse.modules.investments.portfolio import (
    InMemoryFxLookup,
    allocate,
    build_snapshot,
    value_portfolio,
)

PROFILE = new_id()
ACCOUNT = new_id()
AS_OF = day("2026-10-01")


def at(y: int, m: int, dd: int, h: int = 0) -> datetime:
    return datetime(y, m, dd, h, tzinfo=UTC)


def daily_bars(instrument_id: str, start: date, end: date, close: str) -> list[PriceBar]:
    """Weekday bars from ``start`` to ``end`` at a flat close."""
    bars, current = [], start
    while current <= end:
        if current.weekday() < 5:
            bars.append(
                PriceBar(instrument_id=instrument_id, date=current, close=d(close), source="test")
            )
        current += timedelta(days=1)
    return bars


def daily_rates(quote, start: date, end: date, rate: str):
    rates, current = [], start
    while current <= end:
        if current.weekday() < 5:
            rates.append(fx_rate(quote, current.isoformat(), rate))
        current += timedelta(days=1)
    return rates


def deposit(trade_date: str, amount: str, currency=PLN, account=ACCOUNT, created_at=None):
    return build_txn(
        account,
        type=TxnType.DEPOSIT,
        trade_date=trade_date,
        quantity=None,
        price=None,
        currency=currency,
        gross_amount=amount,
        cash_amount=amount,
        created_at=created_at,
    )


def run(txns, instruments, bars=(), fx=(), max_fx_age_days=10, last_known_prices=None, plan=None):
    snapshot = build_snapshot(PROFILE, txns, AS_OF)
    market = market_view(AS_OF.isoformat(), instruments=instruments, bars=bars)
    kwargs = {} if last_known_prices is None else {"last_known_prices": last_known_prices}
    valued = value_portfolio(
        snapshot, market, InMemoryFxLookup(fx), PLN, 5, max_fx_age_days=max_fx_age_days, **kwargs
    )
    allocation = None if plan is None else allocate(valued, plan)
    return snapshot, valued, allocation


def holding(valued, symbol):
    return next(v for v in valued.valued if v.instrument.symbol == symbol)


PASSIVE_LIKE = AllocationPlan(
    buckets=(
        BucketDef(id="global_equity", match=BucketMatch(tags={"global_equity"})),
        BucketDef(id="bonds", match=BucketMatch(asset_classes={AssetClass.TREASURY_BOND})),
        BucketDef(id="cash", match=BucketMatch(asset_classes={AssetClass.CASH})),
    ),
    targets={"global_equity": 0.7, "bonds": 0.2, "cash": 0.1},
)


def test_r1_untagged_imported_etf_is_unclassified_and_tagging_fixes_the_direction():
    vwrl = instrument(
        name="Vanguard FTSE All-World UCITS ETF",
        symbol="VWRL",
        asset_class=AssetClass.ETF,
        needs_classification=True,
    )
    txns = [
        deposit("2026-09-01", "10000"),
        build_txn(ACCOUNT, vwrl.id, trade_date="2026-09-02", quantity="90", price="100"),
    ]
    bars = daily_bars(vwrl.id, day("2026-09-02"), AS_OF, "100")

    _, valued, allocation = run(txns, [vwrl], bars, plan=PASSIVE_LIKE)
    assert valued.total_base == d("10000")
    assert [h.instrument.symbol for h in allocation.unclassified] == ["VWRL"]
    assert allocation.unclassified_value_base == d("9000")
    assert allocation.unclassified_weight == pytest.approx(0.9)  # rules skip above 0.02

    tagged = instrument(
        vwrl.id, name=vwrl.name, symbol="VWRL", asset_class=AssetClass.ETF, tags=["global_equity"]
    )
    _, _, after = run(txns, [tagged], bars, plan=PASSIVE_LIKE)
    assert after.unclassified == ()
    global_equity = after.allocation("global_equity")
    assert global_equity.weight == pytest.approx(0.9)
    assert global_equity.drift_pp == pytest.approx(20.0)  # overweight, not "70 pp underweight"
    assert global_equity.drift_value_base == d("2000")


def test_r1_a_small_unclassified_share_stays_small():
    vwrl = instrument(symbol="VWRL", asset_class=AssetClass.ETF, tags=["global_equity"])
    gold = instrument(symbol="GLD", asset_class=AssetClass.COMMODITY)
    txns = [
        deposit("2026-09-01", "10000"),
        build_txn(ACCOUNT, vwrl.id, trade_date="2026-09-02", quantity="70", price="100"),
        build_txn(ACCOUNT, gold.id, trade_date="2026-09-02", quantity="1", price="100"),
    ]
    bars = [
        *daily_bars(vwrl.id, day("2026-09-02"), AS_OF, "100"),
        *daily_bars(gold.id, day("2026-09-02"), AS_OF, "100"),
    ]
    _, _, allocation = run(txns, [vwrl, gold], bars, plan=PASSIVE_LIKE)
    assert allocation.unclassified_value_base == d("100")
    assert allocation.unclassified_weight == pytest.approx(0.01)
    assert allocation.allocation("global_equity").weight == pytest.approx(0.7)


def test_r2_negative_cash_counts_as_zero_and_weights_are_real():
    aaa = instrument(name="AAA SA", symbol="AAA")
    bbb = instrument(name="BBB SA", symbol="BBB")
    plan = AllocationPlan(
        buckets=(
            BucketDef(id="stocks", match=BucketMatch(asset_classes={AssetClass.EQUITY})),
            BucketDef(id="cash", match=BucketMatch(asset_classes={AssetClass.CASH})),
        ),
        targets={"stocks": 0.95, "cash": 0.05},
    )
    snapshot, valued, allocation = run(
        [
            deposit("2026-09-01", "70000", created_at=at(2026, 9, 1)),
            build_txn(ACCOUNT, aaa.id, trade_date="2026-09-02", quantity="100", price="600"),
            build_txn(ACCOUNT, bbb.id, trade_date="2026-09-03", quantity="100", price="400"),
        ],
        [aaa, bbb],
        [
            *daily_bars(aaa.id, day("2026-09-02"), AS_OF, "600"),
            *daily_bars(bbb.id, day("2026-09-03"), AS_OF, "400"),
        ],
        plan=plan,
    )
    assert snapshot.warnings == (
        CashHistoryGap(account_id=ACCOUNT, currency=PLN, amount=d("-30000"), as_of=AS_OF),
    )
    assert valued.cash[0].amount_base == d("-30000")
    assert valued.cash_base == d("0")
    assert valued.total_base == d("100000")
    assert holding(valued, "AAA").weight == 0.6  # a real 60 % position
    assert holding(valued, "BBB").weight == 0.4  # not the old 57 %
    assert allocation.allocation("cash").cash_history_gap is True
    assert allocation.allocation("stocks").cash_history_gap is False


def _r4_history(pkn, aapl):
    return [
        deposit("2026-09-01", "50200", currency=USD, created_at=at(2026, 9, 1)),
        deposit("2026-09-01", "1000", created_at=at(2026, 9, 1, 1)),
        build_txn(ACCOUNT, pkn.id, trade_date="2026-09-02", created_at=at(2026, 9, 2)),
        build_txn(
            ACCOUNT,
            aapl.id,
            trade_date="2026-09-02",
            quantity="1",
            price="200",
            currency=USD,
            created_at=at(2026, 9, 2, 1),
        ),
    ]


def _r4_setup():
    pkn = instrument()
    aapl = instrument(name="Apple", symbol="AAPL", mic="XNAS", currency=USD)
    bars = [
        *daily_bars(pkn.id, day("2026-09-02"), AS_OF, "100"),
        *daily_bars(aapl.id, day("2026-09-02"), AS_OF, "100"),  # AAPL down 50 % from cost
    ]
    return pkn, aapl, bars


def _expect_usd_left_out(valued):
    assert valued.missing_fx_currencies == {USD}
    assert valued.total_base == d("1000")  # PKN only; the USD amounts are unknown, not zero
    aapl = holding(valued, "AAPL")
    assert (aapl.missing_fx_currency, aapl.market_value_base, aapl.weight) == (USD, None, None)
    assert next(c for c in valued.cash if c.currency == USD).amount_base is None


def test_r4_no_usd_rate_leaves_usd_amounts_out_and_names_the_currency():
    pkn, aapl, bars = _r4_setup()
    _, valued, _ = run(_r4_history(pkn, aapl), [pkn, aapl], bars)
    _expect_usd_left_out(valued)
    assert MissingFxRate(currency=USD, base=PLN, date=AS_OF) in valued.warnings


def test_r14_a_usd_rate_older_than_max_fx_age_days_counts_as_missing():
    pkn, aapl, bars = _r4_setup()
    stale = daily_rates(USD, day("2026-08-25"), day("2026-09-15"), "4.00")  # 16 days before as_of
    _, valued, _ = run(_r4_history(pkn, aapl), [pkn, aapl], bars, fx=stale)
    _expect_usd_left_out(valued)
    assert (
        StaleFxRate(currency=USD, base=PLN, date=AS_OF, rate_date=day("2026-09-15"), age_days=16)
        in valued.warnings
    )

    loose = run(_r4_history(pkn, aapl), [pkn, aapl], bars, fx=stale, max_fx_age_days=20)[1]
    assert loose.missing_fx_currencies == frozenset()
    # PKN 1000 + AAPL 1 x 100 x 4 = 400 + USD cash 50000 x 4 = 200000 + PLN cash 0.
    assert loose.total_base == d("201400")
    assert holding(loose, "PKN").weight == pytest.approx(1000 / 201400)
    assert holding(loose, "AAPL").unrealized_pct == pytest.approx(-0.5)


def test_r5_cash_derived_across_currencies_values_correctly():
    # The fixed generic CSV import stores buy 10 @ 100 USD settled in PLN at fx 4.0 as -4000 PLN.
    usd_stock = instrument(name="US stock", symbol="USS", mic="XNAS", currency=USD)
    txns = [
        deposit("2026-09-01", "10000"),
        build_txn(
            ACCOUNT,
            usd_stock.id,
            trade_date="2026-09-02",
            quantity="10",
            price="100",
            currency=USD,
            cash_amount="-4000",
            cash_currency=PLN,
            fx_rate="4.0",
        ),
    ]
    rates = daily_rates(USD, day("2026-08-25"), AS_OF, "4.00")
    _, valued, _ = run(
        txns, [usd_stock], daily_bars(usd_stock.id, day("2026-09-02"), AS_OF, "100"), fx=rates
    )
    assert valued.cash_base == d("6000")
    assert valued.total_base == d("10000")
    assert valued.cash[0].amount_base / valued.total_base == d("0.6")


def test_r8_every_partial_fill_counts_once():
    # What the fixed dedup stores from two overlapping exports: fill A (5 @ 60) and fill B (7 @ 61).
    pkn = instrument()
    txns = [
        deposit("2026-09-01", "5000"),
        build_txn(ACCOUNT, pkn.id, trade_date="2026-09-02", quantity="5", price="60"),
        build_txn(ACCOUNT, pkn.id, trade_date="2026-09-02", quantity="7", price="61"),
    ]
    _, valued, _ = run(txns, [pkn], daily_bars(pkn.id, day("2026-09-02"), AS_OF, "60"))
    h = holding(valued, "PKN")
    assert h.holding.quantity == d("12")
    assert h.cost_basis_base == d("727")
    assert valued.cash_base == d("4273")


def test_r9_same_day_rows_follow_their_import_rank_not_the_file_order():
    # The fixed import ranks the 10:00 buy before the 15:00 sell (created_at increasing).
    pkn = instrument()
    sell = build_txn(
        ACCOUNT,
        pkn.id,
        type=TxnType.SELL,
        trade_date="2026-09-02",
        quantity="10",
        price="71",
        cash_amount="710",
        created_at=at(2026, 9, 2, 15),
    )
    buy = build_txn(
        ACCOUNT,
        pkn.id,
        trade_date="2026-09-02",
        quantity="10",
        price="60",
        created_at=at(2026, 9, 2, 10),
    )
    snapshot, valued, _ = run(
        [sell, buy], [pkn], daily_bars(pkn.id, day("2026-09-01"), AS_OF, "70")
    )
    assert snapshot.holdings == ()
    assert snapshot.warnings == ()  # no HistoryGap
    assert snapshot.realized[0].pnl == d("110")
    assert valued.cash_base == d("110")


def test_r10_an_instrument_in_its_trade_currency_values_at_cost():
    # The fixed resolver creates AAPL in USD (from the priced buy, not the PLN tax / dividend rows).
    aapl = instrument(name="Apple", symbol="AAPL", mic=None, currency=USD)
    txns = [
        deposit("2026-09-01", "1500", currency=USD),
        build_txn(
            ACCOUNT, aapl.id, trade_date="2026-09-02", quantity="10", price="150", currency=USD
        ),
        build_txn(
            ACCOUNT,
            aapl.id,
            type=TxnType.DIVIDEND,
            trade_date="2026-09-10",
            quantity=None,
            price=None,
            gross_amount="20",
            cash_amount="20",
        ),
        build_txn(
            ACCOUNT,
            aapl.id,
            type=TxnType.TAX,
            trade_date="2026-09-10",
            quantity=None,
            price=None,
            gross_amount="3",
            cash_amount="-3",
        ),
    ]
    _, valued, _ = run(
        txns,
        [aapl],
        daily_bars(aapl.id, day("2026-09-02"), AS_OF, "150"),
        fx=daily_rates(USD, day("2026-08-25"), AS_OF, "4.00"),
    )
    h = holding(valued, "AAPL")
    assert (h.price, h.price_currency) == (d("150"), USD)
    assert h.market_value_base == d("6000")
    assert h.cost_basis_base == d("6000")
    assert h.unrealized_pct == 0.0
    assert valued.cash_base == d("17")  # 20 - 3 PLN; USD cash 0


def test_r11_the_fallback_price_is_split_once_across_accounts():
    a, b = new_id(), new_id()
    fund = instrument(name="Fund", symbol="FND", mic=None, asset_class=AssetClass.FUND)
    as_of = day("2026-03-01")

    def split_on(account, on):
        return build_txn(
            account,
            fund.id,
            type=TxnType.SPLIT,
            trade_date=on,
            quantity=None,
            price=None,
            cash_amount="0",
            split_ratio="2",
            created_at=datetime.fromisoformat(on).replace(tzinfo=UTC),
        )

    txns = [
        deposit("2026-01-02", "1000", account=a, created_at=at(2026, 1, 2)),
        deposit("2026-01-02", "1000", account=b, created_at=at(2026, 1, 2)),
        build_txn(a, fund.id, trade_date="2026-01-10", created_at=at(2026, 1, 10)),
        build_txn(b, fund.id, trade_date="2026-01-10", created_at=at(2026, 1, 10)),
        split_on(a, "2026-02-02"),
        split_on(b, "2026-02-03"),
    ]
    snapshot = build_snapshot(PROFILE, txns, as_of)
    valued = value_portfolio(
        snapshot, market_view("2026-03-01", instruments=[fund]), InMemoryFxLookup([]), PLN, 5
    )
    assert snapshot.last_trade_prices[fund.id].price == d("50")
    assert [(v.holding.quantity, v.market_value_base) for v in valued.valued] == [
        (d("20"), d("1000")),
        (d("20"), d("1000")),
    ]
    assert valued.total_base == d("2000")  # was 1000: 20 + 20 units at a double-split 25


def test_r12_a_pln_sell_of_a_eur_lot_has_no_mixed_pnl_and_a_base_result_at_trade_date_fx():
    etf = instrument(name="EUR ETF", symbol="EXX", mic="XETR", currency=EUR)
    as_of = day("2026-03-01")
    txns = [
        build_txn(ACCOUNT, etf.id, currency=EUR, created_at=at(2026, 1, 5)),  # 10 @ 100 EUR
        build_txn(
            ACCOUNT,
            etf.id,
            type=TxnType.SELL,
            trade_date="2026-02-16",
            price="440",
            cash_amount="4400",
            created_at=at(2026, 2, 16),
        ),
    ]
    snapshot = build_snapshot(PROFILE, txns, as_of)
    valued = value_portfolio(
        snapshot,
        market_view("2026-03-01", instruments=[etf]),
        InMemoryFxLookup([fx_rate(EUR, "2026-01-05", "4.30"), fx_rate(EUR, "2026-02-16", "4.25")]),
        PLN,
        5,
    )
    (trade,) = snapshot.realized
    assert (trade.currency, trade.cost_currency, trade.pnl) == (PLN, EUR, None)
    assert snapshot.realized_pnl_by_currency == {}  # was {PLN: 3400} = 4400 PLN - 1000 EUR
    assert valued.realized[0].pnl_base == d("100")  # 4400 PLN - 1000 EUR x 4.30
    assert valued.realized_pnl_base == d("100")
    assert len([w for w in snapshot.warnings if isinstance(w, RealizedCurrencyMismatch)]) == 1


def _r13_history(fund, transferred=None):
    txns = [
        deposit("2026-01-02", "1000", created_at=at(2026, 1, 2)),
        build_txn(ACCOUNT, fund.id, created_at=at(2026, 1, 5)),  # 10 @ 100
        build_txn(  # reconciliation adds 2 units at the broker's average cost
            ACCOUNT,
            fund.id,
            type=TxnType.ADJUSTMENT,
            trade_date="2026-09-30",
            quantity="2",
            price="75",
            gross_amount="0",
            cash_amount="0",
            source=TxnSource.RECONCILIATION,
            created_at=at(2026, 9, 30),
        ),
    ]
    if transferred is not None:
        txns.append(
            build_txn(
                ACCOUNT,
                transferred.id,
                type=TxnType.TRANSFER_IN,
                trade_date="2026-02-01",
                quantity="5",
                price="80",
                gross_amount="0",
                cash_amount="0",
                created_at=at(2026, 2, 1),
            )
        )
    return txns


def test_r13_the_fallback_is_the_last_market_trade_not_the_reconciliation_cost():
    fund = instrument(name="Bond fund", symbol="FND", mic=None, asset_class=AssetClass.FUND)
    _, valued, _ = run(_r13_history(fund), [fund])
    h = holding(valued, "FND")
    assert (h.price, h.price_date, h.is_stale) == (d("100"), day("2026-01-05"), True)
    assert h.market_value_base == d("1200")  # 12 x 100, not 12 x 75 = 900
    assert h.cost_basis_base == d("1150")  # 1000 + 2 x 75


def test_r13_a_transfer_in_value_is_no_price():
    fund = instrument(name="Bond fund", symbol="FND", mic=None, asset_class=AssetClass.FUND)
    other = instrument(name="Other fund", symbol="OTH", mic=None, asset_class=AssetClass.FUND)
    _, valued, _ = run(_r13_history(fund, other), [fund, other])
    h = holding(valued, "OTH")
    assert (h.price, h.market_value_base) == (None, None)
    assert MissingPrice(instrument_id=other.id, as_of=AS_OF) in valued.warnings


def test_r15_the_price_currency_is_the_instruments_not_the_lots():
    eur_etf = instrument(name="EUR ETF", symbol="EXX", mic="XETR", currency=EUR)
    txns = [
        deposit("2026-09-01", "1000"),
        build_txn(ACCOUNT, eur_etf.id, trade_date="2026-09-02", quantity="2", price="400"),
    ]
    _, valued, _ = run(
        txns,
        [eur_etf],
        [PriceBar(instrument_id=eur_etf.id, date=AS_OF, close=d("112.4"), source="test")],
        fx=daily_rates(EUR, day("2026-09-01"), AS_OF, "4.25"),
    )
    h = holding(valued, "EXX")
    assert (h.price, h.price_currency, h.holding.currency) == (d("112.4"), EUR, PLN)
    assert h.market_value_base == d("955.400")
