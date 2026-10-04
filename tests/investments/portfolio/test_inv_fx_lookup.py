"""In-memory FX lookup (port of fx_lookup_test.dart; the repository-backed loader is a later wave)."""

from __future__ import annotations

from inv_portfolio_fixtures import (
    EUR,
    GBP,
    PLN,
    USD,
    buy,
    cash_txn,
    d,
    day,
    fx_rate,
    instrument,
    market_view,
    new_id,
)

from finanse.modules.investments.domain import Currency, FxLookup, FxQuote
from finanse.modules.investments.portfolio import (
    InMemoryFxLookup,
    build_snapshot,
    convert,
    fx_currencies_for,
)

CHF = Currency.CHF

# 2026-01-02 is a Friday, 2026-01-05 a Monday.
FX = InMemoryFxLookup(
    [
        fx_rate(USD, "2026-01-02", "4.00"),
        fx_rate(USD, "2026-01-05", "4.10"),
        fx_rate(EUR, "2026-01-02", "5.00"),
        fx_rate(EUR, "2026-01-05", "4.92"),
    ]
)


def test_is_an_fx_lookup():
    assert isinstance(FX, FxLookup)


def test_identity_for_equal_currencies_also_without_any_stored_rate():
    assert FX.rate_on_or_before(PLN, day("2020-01-01")) == d("1")
    assert FX.rate_on_or_before(CHF, day("2020-01-01"), base=CHF) == d("1")
    assert FX.quote_on_or_before(PLN, day("2020-01-01")) == FxQuote(
        rate=d("1"), date=day("2020-01-01")
    )


def test_newest_rate_on_or_before_the_date_and_none_before_the_first():
    assert FX.rate_on_or_before(USD, day("2026-01-02")) == d("4.00")
    assert FX.rate_on_or_before(USD, day("2026-01-04")) == d("4.00")  # weekend uses Friday
    assert FX.rate_on_or_before(USD, day("2026-01-05")) == d("4.10")
    assert FX.rate_on_or_before(USD, day("2026-06-30")) == d("4.10")
    assert FX.rate_on_or_before(USD, day("2026-01-01")) is None
    assert FX.rate_on_or_before(GBP, day("2026-01-05")) is None


def test_inverse_and_cross_rates():
    assert FX.rate_on_or_before(PLN, day("2026-01-02"), base=USD) == d("0.25")
    assert FX.rate_on_or_before(USD, day("2026-01-02"), base=EUR) == d("0.8")  # 4.00 / 5.00
    assert FX.rate_on_or_before(EUR, day("2026-01-05"), base=USD) == d("1.2")  # 4.92 / 4.10
    assert FX.rate_on_or_before(GBP, day("2026-01-05"), base=USD) is None


def test_quote_dates_inverse_keeps_the_stored_date_cross_takes_the_older_leg():
    fx = InMemoryFxLookup(
        [
            fx_rate(USD, "2026-01-02", "4.00"),
            fx_rate(EUR, "2026-01-02", "5.00"),
            fx_rate(EUR, "2026-01-07", "4.80"),
        ]
    )
    assert fx.quote_on_or_before(PLN, day("2026-01-09"), base=USD) == FxQuote(
        rate=d("0.25"), date=day("2026-01-02")
    )
    cross = fx.quote_on_or_before(USD, day("2026-01-09"), base=EUR)
    assert cross == FxQuote(rate=d("0.8333333333"), date=day("2026-01-02"))
    assert cross.age_days(day("2026-01-09")) == 7


def test_convert_ignores_non_positive_rates_and_the_last_rate_of_a_day_wins():
    lookup = InMemoryFxLookup(
        [
            fx_rate(USD, "2026-01-02", "3.90"),
            fx_rate(USD, "2026-01-02", "4.00"),
            fx_rate(USD, "2026-01-05", "0"),
        ]
    )
    assert lookup.rate_on_or_before(USD, day("2026-01-05")) == d("4.00")
    assert convert(lookup, d("25"), USD, PLN, day("2026-01-05")) == d("100")
    assert convert(lookup, d("25"), GBP, PLN, day("2026-01-05")) is None


def test_fx_currencies_for_lists_every_currency_valuation_needs_from_the_oldest_lot():
    account = new_id()
    usd_etf = instrument(currency=USD, symbol="VT", mic="ARCX")
    eur_fund = instrument(currency=EUR, symbol="FND", mic=None)
    snapshot = build_snapshot(
        new_id(),
        [
            buy(account, usd_etf.id, "2026-01-05", "1", "100", currency=USD),
            buy(account, eur_fund.id, "2026-02-05", "1", "100", currency=PLN),
            cash_txn(account, "2026-02-02", "50", currency=GBP),
        ],
        day("2026-03-31"),
    )
    currencies, oldest = fx_currencies_for(
        snapshot, market_view("2026-03-31", instruments=[usd_etf, eur_fund]), CHF
    )
    assert currencies == {USD, PLN, EUR, GBP, CHF}
    assert oldest == day("2026-01-05")
