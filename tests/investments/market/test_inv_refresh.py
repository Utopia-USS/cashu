"""MarketDataRefresher over an in-memory store (port of market_data_service_test.dart, R3 and R6).

The refresher only plans and fetches; ``InMemoryMarketData.apply`` plays the persistence layer, so
the "next run" behaviour can be checked like the Dart tests did against a temp database.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from inv_market_support import (
    FETCHED_AT,
    build_instrument,
    d,
    day,
    fake_clock,
    fixture,
    make_http,
    orlen,
    recording,
    respond,
    vwce,
    weekdays,
    yahoo_chart_client,
)

from cashu.modules.investments.domain import (
    AssetClass,
    CalendarDate,
    Currency,
    FxRate,
    Instrument,
    InstrumentAlias,
    InstrumentStatus,
    PriceBar,
    Transaction,
    TxnType,
)
from cashu.modules.investments.market import (
    CompositePriceSource,
    FetchStatus,
    InMemoryMarketData,
    MarketDataRefresher,
    NbpFxSource,
    NoPriceSourceException,
    PriceSource,
    SourceBlockedException,
    SourceException,
    YahooPriceSource,
)
from cashu.modules.investments.portfolio import build_snapshot, value_portfolio

AS_OF = day("2026-10-02")  # a Friday


def weekday_bars(
    instrument: Instrument, start, end, close="10", fetched_at=FETCHED_AT, source="yahoo"
):
    return [
        PriceBar(
            instrument_id=instrument.id,
            date=on,
            close=d(close),
            source=source,
            fetched_at=fetched_at,
        )
        for on in weekdays(start, end)
    ]


class FakePrices(PriceSource):
    """One bar per weekday of the requested range unless scripted otherwise (by symbol)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, CalendarDate, CalendarDate]] = []
        self.script: dict[str, object] = {}

    @property
    def id(self) -> str:
        return "fake"

    def history(self, instrument, start, end):
        self.calls.append((instrument.symbol, start, end))
        custom = self.script.get(instrument.symbol)
        if isinstance(custom, Exception):
            raise custom
        if callable(custom):
            return custom(instrument, start, end)
        return weekday_bars(instrument, start, end)


class FakeFx:
    """One rate (4) per weekday unless scripted otherwise."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, CalendarDate, CalendarDate]] = []
        self.script: dict[Currency, object] = {}

    @property
    def id(self) -> str:
        return "nbp"

    def rates(self, quote, start, end):
        self.calls.append((quote, start, end))
        custom = self.script.get(quote)
        if isinstance(custom, Exception):
            raise custom
        if custom is not None:
            return list(custom)
        return [
            FxRate(quote=quote, date=on, rate=d("4"), source="nbp", fetched_at=FETCHED_AT)
            for on in weekdays(start, end)
        ]


def seed(symbol: str, **kwargs) -> Instrument:
    return build_instrument(name=symbol, symbol=symbol, **kwargs)


@pytest.fixture
def prices():
    return FakePrices()


@pytest.fixture
def fx():
    return FakeFx()


@pytest.fixture
def refresher(prices, fx):
    return MarketDataRefresher(prices, fx)


def test_an_instrument_without_stored_bars_is_backfilled_from_as_of_minus_400_days(
    prices, refresher
):
    pkn = seed("PKN")
    store = InMemoryMarketData()
    report = refresher.refresh(store, [pkn], [], AS_OF)

    assert prices.calls == [("PKN", day("2025-08-28"), AS_OF)]
    (result,) = report.instruments
    assert result.status == FetchStatus.OK
    assert result.source == "yahoo"
    assert (result.start, result.end) == (day("2025-08-28"), AS_OF)
    assert result.replace_from is None
    store.apply(report)
    assert result.bar_count == len(store.bars[pkn.id])
    assert store.last_bar_date(pkn.id) == AS_OF
    assert store.first_bar_date(pkn.id) == day("2025-08-28")


def test_incremental_refetches_from_the_last_stored_bar_replacing_it(prices, refresher):
    pkn = seed("PKN")
    store = InMemoryMarketData(
        [
            PriceBar(instrument_id=pkn.id, date=day("2026-09-29"), close=d("9"), source="yahoo"),
            # Stored while the session was still open; the refresh replaces it with the final close.
            PriceBar(instrument_id=pkn.id, date=day("2026-09-30"), close=d("9.5"), source="yahoo"),
        ]
    )
    report = refresher.refresh(store, [pkn], [], AS_OF)

    assert prices.calls == [("PKN", day("2026-09-30"), AS_OF)]
    assert report.instruments[0].bar_count == 3  # 30 Sep (replaced), 1 Oct, 2 Oct
    store.apply(report)
    assert store.bars[pkn.id][day("2026-09-30")].close == d("10")
    assert store.bars[pkn.id][day("2026-09-29")].close == d("9")


def test_refetch_days_zero_starts_after_the_last_bar_and_up_to_date_makes_no_request(prices, fx):
    strict = MarketDataRefresher(prices, fx, refetch_days=0)
    pkn = seed("PKN")
    store = InMemoryMarketData(weekday_bars(pkn, day("2026-09-28"), day("2026-09-30")))
    strict.refresh(store, [pkn], [], AS_OF)
    assert prices.calls == [("PKN", day("2026-10-01"), AS_OF)]

    prices.calls.clear()
    store.upsert_bars(weekday_bars(pkn, AS_OF, AS_OF))
    report = strict.refresh(store, [pkn], [], AS_OF)
    assert prices.calls == []
    assert report.instruments[0].status == FetchStatus.OK
    assert "up to date" in report.instruments[0].message


def test_with_stored_bars_beyond_as_of_nothing_is_requested(prices, refresher):
    pkn = seed("PKN")
    store = InMemoryMarketData(weekday_bars(pkn, day("2026-10-05"), day("2026-10-05")))
    report = refresher.refresh(store, [pkn], [], AS_OF)
    assert prices.calls == []
    assert report.instruments[0].start is None


def test_one_failing_instrument_never_aborts_the_others(prices, refresher):
    failing, blocked, buggy = seed("FAIL"), seed("BLOCK"), seed("BUG")
    empty, bond, good = seed("EMPTY"), seed("EDO"), seed("GOOD")
    prices.script.update(
        {
            "FAIL": SourceException("yahoo", "HTTP 503", retryable=True),
            "BLOCK": SourceBlockedException("stooq", "bot page"),
            "BUG": RuntimeError("parser bug"),
            "EMPTY": lambda *_: [],
            "EDO": NoPriceSourceException("composite", "no stooq / yahoo alias"),
        }
    )
    store = InMemoryMarketData()

    report = refresher.refresh(store, [failing, blocked, buggy, empty, bond, good], [], AS_OF)

    assert [(i.label, i.status) for i in report.instruments] == [
        ("FAIL", FetchStatus.ERROR),
        ("BLOCK", FetchStatus.ERROR),
        ("BUG", FetchStatus.ERROR),
        ("EMPTY", FetchStatus.NO_DATA),
        ("EDO", FetchStatus.NO_DATA),
        ("GOOD", FetchStatus.OK),
    ]
    assert report.instruments[0].message == "yahoo: HTTP 503"
    assert report.instruments[2].message == "RuntimeError: parser bug"
    assert report.instruments[4].message == "no stooq / yahoo alias"
    assert report.has_errors
    assert report.error_messages == [
        f"prices FAIL ({failing.id}): yahoo: HTTP 503",
        f"prices BLOCK ({blocked.id}): stooq: bot page",
        f"prices BUG ({buggy.id}): RuntimeError: parser bug",
    ]
    store.apply(report)
    assert store.last_bar_date(good.id) == AS_OF
    assert store.last_bar_date(failing.id) is None
    stats = report.to_stats()
    assert (stats["instruments_error"], stats["instruments_no_data"], stats["instruments_ok"]) == (
        3,
        2,
        1,
    )


def test_bars_outside_the_range_or_for_another_instrument_are_dropped(prices, refresher):
    pkn, other = seed("PKN"), seed("OTHER")
    prices.script["PKN"] = lambda i, start, end: [
        *weekday_bars(i, day("2026-10-05"), day("2026-10-05")),  # after as_of
        *weekday_bars(other, AS_OF, AS_OF),  # wrong instrument
        *weekday_bars(i, AS_OF, AS_OF),
    ]
    store = InMemoryMarketData(
        [PriceBar(instrument_id=pkn.id, date=AS_OF, close=d("1"), source="x")]
    )
    report = refresher.refresh(store, [pkn], [], AS_OF)
    assert report.instruments[0].bar_count == 1
    store.apply(report)
    assert store.last_bar_date(other.id) is None


def test_duplicate_instruments_are_fetched_once(prices, refresher):
    pkn = seed("PKN")
    report = refresher.refresh(InMemoryMarketData(), [pkn, pkn], [], AS_OF)
    assert len(prices.calls) == 1
    assert len(report.instruments) == 1


def test_delisted_and_frozen_instruments_are_not_fetched(prices, refresher):
    delisted = seed("GONE", status=InstrumentStatus.DELISTED)
    frozen = seed("FRZ", status=InstrumentStatus.FROZEN)
    report = refresher.refresh(InMemoryMarketData(), [delisted, frozen], [], AS_OF)
    assert prices.calls == []
    assert [(i.status, i.message) for i in report.instruments] == [
        (FetchStatus.SKIPPED, "not fetched: instrument is delisted"),
        (FetchStatus.SKIPPED, "not fetched: instrument is frozen"),
    ]
    assert report.to_stats()["instruments_skipped"] == 2
    assert not report.has_errors


# --- fx -----------------------------------------------------------------------------------------


def test_fx_backfills_an_empty_currency_refetches_from_the_last_rate_and_skips_pln(fx, refresher):
    store = InMemoryMarketData(
        rates=[FxRate(quote=Currency.EUR, date=day("2026-09-30"), rate=d("4.3"), source="nbp")]
    )
    report = refresher.refresh(
        store, [], [Currency.USD, Currency.EUR, Currency.PLN, Currency.USD], AS_OF
    )
    assert fx.calls == [
        ("USD", day("2025-08-28"), AS_OF),
        ("EUR", day("2026-09-30"), AS_OF),
    ]
    assert [(f.currency, f.status) for f in report.fx] == [
        (Currency.USD, FetchStatus.OK),
        (Currency.EUR, FetchStatus.OK),
    ]
    assert report.fx[-1].rate_count == 3
    assert report.fx[-1].source == "nbp"
    store.apply(report)
    assert store.fx_lookup().rate_on_or_before(Currency.USD, AS_OF) == d("4")


def test_fx_history_from_backfills_older_rates_once_from_a_week_before(fx, refresher):
    lot_date = day("2024-03-10")  # a Sunday, long before as_of - 400 days
    store = InMemoryMarketData()
    first = refresher.refresh(
        store, [], [Currency.USD], AS_OF, fx_history_from={Currency.USD: lot_date}
    )

    assert fx.calls == [
        ("USD", day("2025-08-28"), AS_OF),
        ("USD", day("2024-03-03"), day("2025-08-27")),
    ]
    assert first.fx[0].status == FetchStatus.OK
    assert first.fx[0].start == day("2024-03-03")
    store.apply(first)
    quote = store.fx_lookup().quote_on_or_before(Currency.USD, lot_date)
    assert quote is not None and quote.date == day("2024-03-08")
    assert store.first_rate_date(Currency.USD) == day("2024-03-04")

    # Covered now: the next run only re-fetches the last stored day.
    fx.calls.clear()
    refresher.refresh(store, [], [Currency.USD], AS_OF, fx_history_from={Currency.USD: lot_date})
    assert fx.calls == [("USD", AS_OF, AS_OF)]


def test_fx_history_inside_the_backfill_window_needs_no_second_request(fx, refresher):
    report = refresher.refresh(
        InMemoryMarketData(),
        [],
        [Currency.USD],
        AS_OF,
        fx_history_from={Currency.USD: day("2026-06-01")},
    )
    assert len(fx.calls) == 1
    assert report.fx[0].start == day("2025-08-28")


def test_a_failing_currency_is_reported_and_the_others_still_refresh(fx, refresher):
    fx.script[Currency.USD] = SourceException("nbp", "HTTP 400 limit")
    fx.script[Currency.CHF] = []
    store = InMemoryMarketData()
    report = refresher.refresh(store, [], [Currency.USD, Currency.CHF, Currency.EUR], AS_OF)
    assert [f.status for f in report.fx] == [FetchStatus.ERROR, FetchStatus.NO_DATA, FetchStatus.OK]
    assert report.error_messages == ["fx USD: nbp: HTTP 400 limit"]
    assert report.to_stats()["fx_error"] == 1
    store.apply(report)
    assert store.last_rate_date(Currency.EUR) == AS_OF


# --- end to end over recorded responses ---------------------------------------------------------


def test_end_to_end_composite_and_nbp_through_market_http():
    requests = []

    def handler(request):
        host = request.url.host
        if host == "stooq.pl":
            return respond(fixture("stooq_challenge.html"), 200, "text/html; charset=utf-8")
        if host == "query1.finance.yahoo.com":
            return respond(fixture("yahoo_vwce_de.json"))
        if "/usd/" in request.url.path:
            return respond(fixture("nbp_usd.json"))
        return respond(fixture("nbp_no_data_404.txt"), 404, "text/plain")

    market = make_http(recording(requests, handler))
    real = MarketDataRefresher(
        CompositePriceSource.standard(market, clock=fake_clock),
        NbpFxSource(market, clock=fake_clock),
    )
    etf, pkn = vwce(), orlen()
    store = InMemoryMarketData(
        [
            PriceBar(instrument_id=etf.id, date=day("2026-09-14"), close=d("1"), source="yahoo"),
            PriceBar(instrument_id=pkn.id, date=day("2026-09-14"), close=d("1"), source="stooq"),
        ],
        [FxRate(quote=Currency.USD, date=day("2026-09-14"), rate=d("1"), source="nbp")],
    )

    report = real.refresh(store, [etf, pkn], [Currency.USD, Currency.EUR], day("2026-09-25"))
    store.apply(report)

    etf_result, pkn_result = report.instruments
    assert (etf_result.status, etf_result.source, etf_result.bar_count) == (
        FetchStatus.OK,
        "yahoo",
        4,
    )
    assert etf_result.currency == Currency.EUR
    # PKN (XWAR, PLN): stooq first -> bot page -> yahoo, but the mock answers with the EUR-quoted VWCE
    # fixture for any symbol: a quote currency mismatch is an error and nothing is stored (R3).
    assert (pkn_result.status, pkn_result.source, pkn_result.bar_count) == (
        FetchStatus.ERROR,
        None,
        0,
    )
    assert (
        'quote currency EUR for "PKN.WA" differs from the instrument currency PLN'
        in pkn_result.message
    )
    assert store.last_bar_date(pkn.id) == day("2026-09-14")
    assert len([r for r in requests if r.url.host == "stooq.pl"]) == 1
    assert store.bars[etf.id][day("2026-09-14")].close == d("166.22")
    assert [f.status for f in report.fx] == [FetchStatus.OK, FetchStatus.NO_DATA]
    assert store.fx_lookup().rate_on_or_before(Currency.USD, day("2026-09-14")) == d("3.7607")


# --- R3: GBp listing through Yahoo, the refresher and valuation ---------------------------------


def _vusa(currency: Currency) -> Instrument:
    return build_instrument(
        name="Vanguard S&P 500 UCITS ETF",
        symbol="VUSA",
        mic="XLON",
        currency=currency,
        asset_class=AssetClass.ETF,
        aliases=[InstrumentAlias("yahoo", "VUSA.L", guessed=True)],
    )


def _buy_history(account: str, instrument: Instrument, currency: Currency) -> list[Transaction]:
    return [
        Transaction(
            id=str(uuid4()),
            account_id=account,
            type=TxnType.DEPOSIT,
            trade_date=day("2026-09-01"),
            currency=currency,
            gross_amount=d("1000"),
            cash_amount=d("1000"),
            cash_currency=currency,
        ),
        Transaction(
            id=str(uuid4()),
            account_id=account,
            type=TxnType.BUY,
            trade_date=day("2026-09-02"),
            instrument_id=instrument.id,
            quantity=d("10"),
            price=d("95"),
            currency=currency,
            gross_amount=d("950"),
            cash_amount=d("-950"),
            cash_currency=currency,
        ),
    ]


def _daily_rates(quote: Currency, start, end, rate: str) -> list[FxRate]:
    return [
        FxRate(quote=quote, date=on, rate=d(rate), source="test") for on in weekdays(start, end)
    ]


def _yahoo_gbp_refresher() -> MarketDataRefresher:
    client = recording([], lambda _: respond(fixture("yahoo_vusa_l_gbp_synthetic.json")))
    return MarketDataRefresher(YahooPriceSource(make_http(client), clock=fake_clock), FakeFx())


def test_r3_gbp_closes_are_stored_in_gbp_and_valued_correctly():
    as_of = day("2026-09-17")  # the fixture's last session
    vusa = _vusa(Currency.GBP)
    store = InMemoryMarketData(rates=_daily_rates(Currency.GBP, day("2026-09-01"), as_of, "5.00"))

    report = _yahoo_gbp_refresher().refresh(store, [vusa], [], as_of)
    assert report.instruments[0].status == FetchStatus.OK
    assert report.instruments[0].currency == Currency.GBP
    store.apply(report)
    assert [b.close for b in store.market_view(as_of, [vusa]).series(vusa.id)] == [
        d("95.125"),
        d("94.88"),
        d("95.0125"),
        d("95.3"),
    ]

    snapshot = build_snapshot("profile", _buy_history("acc", vusa, Currency.GBP), as_of)
    valued = value_portfolio(
        snapshot, store.market_view(as_of, [vusa]), store.fx_lookup(), Currency.PLN, 5
    )
    (holding,) = valued.valued
    assert (holding.price, holding.price_currency) == (d("95.3"), Currency.GBP)
    assert holding.market_value_base == d("4765")  # 10 x 95.3 GBP x 5.00, not x100
    assert holding.cost_basis_base == d("4750")  # 950 GBP x 5.00
    assert holding.unrealized_pct == pytest.approx(15 / 4750)
    assert valued.total_base == d("5015")  # + 50 GBP cash x 5.00


def test_r3_a_listing_in_another_currency_is_rejected_and_only_the_trade_price_is_known():
    as_of = day("2026-09-17")
    wrong = _vusa(Currency.USD)  # created from a USD row, alias guessed to the LSE line
    store = InMemoryMarketData(rates=_daily_rates(Currency.USD, day("2026-09-01"), as_of, "4.00"))

    report = _yahoo_gbp_refresher().refresh(store, [wrong], [], as_of)
    (fetch,) = report.instruments
    assert fetch.status == FetchStatus.ERROR
    assert (
        'quote currency GBP for "VUSA.L" differs from the instrument currency USD' in fetch.message
    )
    store.apply(report)
    assert store.last_bar_date(wrong.id) is None  # no mismatched bar is stored

    snapshot = build_snapshot("profile", _buy_history("acc", wrong, Currency.USD), as_of)
    valued = value_portfolio(
        snapshot, store.market_view(as_of, [wrong]), store.fx_lookup(), Currency.PLN, 5
    )
    (holding,) = valued.valued
    assert (holding.price, holding.is_stale) == (d("95"), True)  # only the last trade price


# --- R6: splits ---------------------------------------------------------------------------------

SPLIT_DAY = day("2026-09-30")
BEFORE_SPLIT = datetime(2026, 9, 1, tzinfo=UTC)  # when the old bars were stored


def _splitter(aliases=()) -> Instrument:
    return build_instrument(
        name="Splitter", symbol="SPLT", mic="XNAS", currency=Currency.USD, aliases=aliases
    )


def _store_with_old_bars(instrument: Instrument) -> InMemoryMarketData:
    """Unadjusted closes (400) for 2026-06-01 .. 2026-09-29, fetched before the split."""
    return InMemoryMarketData(
        weekday_bars(
            instrument, day("2026-06-01"), day("2026-09-29"), close="400", fetched_at=BEFORE_SPLIT
        )
    )


def test_r6_a_split_reported_by_yahoo_refetches_and_replaces_the_stored_window():
    requests = []
    yahoo = YahooPriceSource(
        make_http(yahoo_chart_client(requests, lambda _: "100", splits=[(SPLIT_DAY, 4, 1)])),
        clock=fake_clock,
    )
    real = MarketDataRefresher(yahoo, FakeFx())
    splt = _splitter([InstrumentAlias("yahoo", "SPLT")])
    store = _store_with_old_bars(splt)

    report = real.refresh(store, [splt], [], AS_OF)

    (result,) = report.instruments
    assert result.status == FetchStatus.OK
    assert result.refetched_for_split is True
    assert (
        result.message
        == "split 4:1 on 2026-09-30 reported by the source: re-fetched the stored window"
    )
    assert result.start == day("2026-06-01")  # the oldest stored bar
    assert result.replace_from == day("2026-06-01")
    assert len(requests) == 2  # the incremental window, then the full stored window
    store.apply(report)
    stored = store.market_view(AS_OF, [splt]).series(splt.id)
    assert stored[0].date == day("2026-06-01")
    assert stored[-1].date == AS_OF
    assert {b.close for b in stored} == {d("100")}  # no unadjusted 400 close is left
    assert all(b.currency == Currency.USD for b in stored)

    # The next run: the split is outside the incremental window and the bars are adjusted.
    requests.clear()
    again = real.refresh(store, [splt], [], AS_OF)
    assert again.instruments[0].refetched_for_split is False
    assert len(requests) == 1


def test_r6_a_split_transaction_after_unadjusted_bars_refetches_for_a_source_without_events(
    prices, refresher
):
    splt = _splitter()
    store = _store_with_old_bars(splt)
    prices.script["SPLT"] = lambda i, start, end: weekday_bars(i, start, end, close="100")

    report = refresher.refresh(store, [splt], [], AS_OF, split_dates={splt.id: SPLIT_DAY})

    assert prices.calls == [("SPLT", day("2026-06-01"), AS_OF)]  # straight to the full window
    (result,) = report.instruments
    assert (result.status, result.refetched_for_split) == (FetchStatus.OK, True)
    assert result.message == "split transaction on 2026-09-30: re-fetched the stored window"
    store.apply(report)
    assert {b.close for b in store.bars[splt.id].values()} == {d("100")}

    # Bars are now fetched after the split: the same split transaction triggers nothing more.
    prices.calls.clear()
    refresher.refresh(store, [splt], [], AS_OF, split_dates={splt.id: SPLIT_DAY})
    assert prices.calls == [("SPLT", AS_OF, AS_OF)]


def test_r6_a_split_before_every_bar_needs_no_refetch_and_a_failed_refetch_keeps_bars(
    prices, refresher
):
    splt = _splitter()
    refresher.refresh(
        _store_with_old_bars(splt), [splt], [], AS_OF, split_dates={splt.id: day("2026-05-01")}
    )
    assert prices.calls[0][1] == day("2026-09-29")  # incremental only

    fresh = _splitter()
    store = _store_with_old_bars(fresh)
    prices.script["SPLT"] = lambda *_: []
    report = refresher.refresh(store, [fresh], [], AS_OF, split_dates={fresh.id: SPLIT_DAY})
    (result,) = report.instruments
    assert result.status == FetchStatus.ERROR
    assert "returned no bars; stored bars kept" in result.message
    store.apply(report)
    assert store.bars[fresh.id][day("2026-06-01")].close == d("400")


def test_r6_valuation_after_the_refetch_uses_adjusted_prices_and_split_quantities():
    requests = []
    yahoo = YahooPriceSource(
        make_http(yahoo_chart_client(requests, lambda _: "100", splits=[(SPLIT_DAY, 4, 1)])),
        clock=fake_clock,
    )
    splt = _splitter([InstrumentAlias("yahoo", "SPLT")])
    store = _store_with_old_bars(splt)
    store.upsert_rates(_daily_rates(Currency.USD, day("2026-05-25"), AS_OF, "4.00"))
    store.apply(MarketDataRefresher(yahoo, FakeFx()).refresh(store, [splt], [], AS_OF))
    txns = [
        Transaction(
            id="t1",
            account_id="acc",
            type=TxnType.DEPOSIT,
            trade_date=day("2026-06-01"),
            currency=Currency.USD,
            gross_amount=d("4000"),
            cash_amount=d("4000"),
            cash_currency=Currency.USD,
            created_at=datetime(2026, 6, 1, tzinfo=UTC),
        ),
        Transaction(
            id="t2",
            account_id="acc",
            type=TxnType.BUY,
            trade_date=day("2026-06-01"),
            instrument_id=splt.id,
            quantity=d("10"),
            price=d("400"),
            currency=Currency.USD,
            gross_amount=d("4000"),
            cash_amount=d("-4000"),
            cash_currency=Currency.USD,
            created_at=datetime(2026, 6, 1, 1, tzinfo=UTC),
        ),
        Transaction(
            id="t3",
            account_id="acc",
            type=TxnType.SPLIT,
            trade_date=SPLIT_DAY,
            instrument_id=splt.id,
            currency=Currency.USD,
            gross_amount=Decimal(0),
            cash_amount=Decimal(0),
            cash_currency=Currency.USD,
            split_ratio=d("4"),
        ),
    ]
    snapshot = build_snapshot("profile", txns, AS_OF)
    market = store.market_view(AS_OF, [splt])
    valued = value_portfolio(snapshot, market, store.fx_lookup(), Currency.PLN, 5)
    (holding,) = valued.valued
    assert holding.holding.quantity == d("40")
    assert holding.market_value_base == d("16000")  # 40 x 100 USD x 4.00
    assert holding.cost_basis_base == d("16000")  # 4000 USD x 4.00
    window = market.last_bars(splt.id, 60)
    high = max(b.close for b in window)
    assert (high - window[-1].close) / high == 0  # no false "75 % below its high"
    assert window[-1].date - window[0].date < timedelta(days=90)
