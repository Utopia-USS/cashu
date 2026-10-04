"""Yahoo chart source (port of yahoo_price_source_test.dart incl. R3 quote currency and R6 splits)."""

from __future__ import annotations

import json

import httpx
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
    utc,
    vwce,
)

from finanse.modules.investments.domain import AssetClass, Currency, InstrumentAlias, PriceBar
from finanse.modules.investments.market import (
    NoPriceSourceException,
    QuoteCurrencyMismatchException,
    SourceBlockedException,
    SourceException,
    SplitEvent,
    YahooPriceSource,
    exchange_date,
)

FROM, TO = day("2026-09-14"), day("2026-09-25")


def chart(gmtoffset, timestamps, closes, volumes=None, currency=None, events=None) -> str:
    """A minimal chart response; ``currency`` is omitted from ``meta`` when None (no check)."""
    meta = {"symbol": "TEST", "gmtoffset": gmtoffset, "priceHint": 2}
    if currency is not None:
        meta["currency"] = currency
    result = {
        "meta": meta,
        "timestamp": timestamps,
        "indicators": {
            "quote": [
                {
                    "open": closes,
                    "high": closes,
                    "low": closes,
                    "close": closes,
                    "volume": volumes if volumes is not None else [1 for _ in closes],
                }
            ]
        },
    }
    if events is not None:
        result["events"] = events
    return json.dumps({"chart": {"result": [result], "error": None}})


class Yahoo:
    def __init__(self, body: str, status: int = 200, content_type: str = "application/json"):
        self.requests: list[httpx.Request] = []
        client = recording(self.requests, lambda _: respond(body, status, content_type))
        self.source = YahooPriceSource(make_http(client), clock=fake_clock)


def failure(yahoo: Yahoo) -> SourceException:
    with pytest.raises(SourceException) as caught:
        yahoo.source.history(vwce(), FROM, TO)
    return caught.value


def test_parses_the_recorded_xetra_response_into_exchange_dates_and_exact_prices():
    etf = vwce()
    yahoo = Yahoo(fixture("yahoo_vwce_de.json"))
    bars = yahoo.source.history(etf, FROM, TO)

    (request,) = yahoo.requests
    assert request.url.host == "query1.finance.yahoo.com"
    assert request.url.path == "/v8/finance/chart/VWCE.DE"
    assert dict(request.url.params) == {
        "period1": str(utc(2026, 9, 13)),  # one day of slack on each side for any UTC offset
        "period2": str(utc(2026, 9, 27)),
        "interval": "1d",
        "events": "split",  # R6: split events come with the bars
    }
    assert request.headers["User-Agent"] == YahooPriceSource.DEFAULT_USER_AGENT
    assert request.headers["User-Agent"].startswith("Mozilla/5.0")

    assert [str(b.date) for b in bars] == ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]
    assert bars[0] == PriceBar(
        instrument_id=etf.id,
        date=day("2026-09-14"),
        open=d("166.06"),
        high=d("166.4"),
        low=d("165.68"),
        close=d("166.22"),
        volume=221018,
        source="yahoo",
        fetched_at=FETCHED_AT,
        currency=Currency.EUR,  # meta.currency, recorded on the bar (R3)
    )
    assert [b.close for b in bars] == [d("166.22"), d("165.36"), d("166.3"), d("167.66")]
    assert str(bars[2].close) == "166.3"


def test_parses_the_recorded_nasdaq_response():
    aapl = build_instrument(
        name="Apple",
        symbol="AAPL",
        mic="XNAS",
        currency=Currency.USD,
        aliases=[InstrumentAlias("yahoo", "AAPL")],
    )
    bars = Yahoo(fixture("yahoo_aapl.json")).source.history(aapl, FROM, TO)
    assert [str(b.date) for b in bars] == ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]
    assert [b.close for b in bars] == [d("333.08"), d("331.34"), d("332.41"), d("337")]
    assert bars[0].volume == 39269100


# --- exchange calendar date ---------------------------------------------------------------------


def test_a_session_opening_before_midnight_utc_belongs_to_the_next_local_day():
    # 10:00 AEDT on 6 Oct is 23:00 UTC on 5 Oct (Sydney, +11 h).
    assert exchange_date(utc(2026, 10, 5, 23), 39600) == day("2026-10-06")


def test_tokyo_new_york_and_warsaw_opens():
    assert exchange_date(utc(2026, 10, 6), 32400) == day("2026-10-06")
    assert exchange_date(utc(2026, 9, 14, 13, 30), -14400) == day("2026-09-14")
    assert exchange_date(utc(2026, 9, 14, 7), 7200) == day("2026-09-14")


def test_a_local_midnight_stamp_read_with_the_other_dst_offset_keeps_its_date():
    # Midnight EDT (04:00 UTC) of 1 Jul read with the winter offset (-5 h) shifts to 23:00 on 30 Jun.
    assert exchange_date(utc(2026, 7, 1, 4), -18000) == day("2026-07-01")
    # Midnight EST (05:00 UTC) of 2 Mar read with the summer offset (-4 h) shifts to 01:00.
    assert exchange_date(utc(2026, 3, 2, 5), -14400) == day("2026-03-02")
    # Midnight CET (23:00 UTC the day before) read with CEST (+2 h) shifts to 01:00.
    assert exchange_date(utc(2026, 1, 14, 23), 7200) == day("2026-01-15")


def test_parse_uses_gmtoffset_so_the_same_instants_land_on_different_dates():
    instants = [utc(2026, 10, 5, 23), utc(2026, 10, 6, 23)]
    sydney = Yahoo(chart(39600, instants, [10, 11])).source.history(
        vwce(), day("2026-10-01"), day("2026-10-10")
    )
    assert [str(b.date) for b in sydney] == ["2026-10-06", "2026-10-07"]
    utc_exchange = Yahoo(chart(0, [utc(2026, 10, 5), utc(2026, 10, 6)], [10, 11])).source.history(
        vwce(), day("2026-10-01"), day("2026-10-10")
    )
    assert [str(b.date) for b in utc_exchange] == ["2026-10-05", "2026-10-06"]


def test_bars_outside_the_range_by_exchange_date_are_dropped():
    body = chart(39600, [utc(2026, 10, 4, 23), utc(2026, 10, 5, 23)], [10, 11])
    bars = Yahoo(body).source.history(vwce(), day("2026-10-06"), day("2026-10-06"))
    assert [b.date for b in bars] == [day("2026-10-06")]


def test_rows_without_a_close_are_skipped_and_a_repeated_date_keeps_the_later_row():
    body = chart(
        0,
        [utc(2026, 9, 14, 8), utc(2026, 9, 15, 8), utc(2026, 9, 16, 8), utc(2026, 9, 16, 15, 5)],
        [10.5, None, 11, 11.25],
        volumes=[100, None, 200, None],
    )
    bars = Yahoo(body).source.history(vwce(), FROM, TO)
    assert [str(b.date) for b in bars] == ["2026-09-14", "2026-09-16"]
    assert bars[-1].close == d("11.25")
    assert bars[-1].volume is None


def test_a_range_without_sessions_is_an_empty_answer():
    body = json.dumps(
        {
            "chart": {
                "result": [{"meta": {"gmtoffset": 7200}, "indicators": {"quote": [{}]}}],
                "error": None,
            }
        }
    )
    assert Yahoo(body).source.history(vwce(), day("2026-09-19"), day("2026-09-20")) == []


def test_the_recorded_unknown_symbol_404_is_a_non_retryable_source_exception():
    error = failure(Yahoo(fixture("yahoo_not_found.json"), status=404))
    assert not isinstance(error, SourceBlockedException)
    assert error.retryable is False
    assert "no such symbol" in error.message
    assert "symbol may be delisted" in error.message


def test_401_403_block_the_source_other_statuses_and_non_json_are_source_exceptions():
    assert isinstance(failure(Yahoo("Unauthorized", status=401)), SourceBlockedException)
    assert isinstance(failure(Yahoo("Forbidden", status=403)), SourceBlockedException)
    assert "HTTP 418" in failure(Yahoo("teapot", status=418)).message
    html = failure(Yahoo("<html>consent</html>", content_type="text/html"))
    assert "unexpected response" in html.message
    assert "no chart result" in failure(Yahoo('{"chart":{"result":[]}}')).message


def test_float32_noise_is_removed_genuine_doubles_keep_their_digits():
    body = chart(
        0,
        [utc(2026, 9, 14, 8), utc(2026, 9, 15, 8), utc(2026, 9, 16, 8)],
        [10000.2998046875, 0.1, 0.012299999594688416],
    )
    bars = Yahoo(body).source.history(vwce(), FROM, TO)
    assert [b.close for b in bars] == [d("10000.3"), d("0.1"), d("0.0123")]
    assert [str(b.close) for b in bars] == ["10000.3", "0.1", "0.0123"]


def test_an_instrument_without_a_yahoo_alias_cannot_be_priced_here():
    yahoo = Yahoo("{}")
    with pytest.raises(NoPriceSourceException):
        yahoo.source.history(orlen(aliases=[InstrumentAlias("stooq", "pkn")]), FROM, TO)
    assert yahoo.requests == []


def test_an_empty_range_makes_no_request():
    yahoo = Yahoo("{}")
    assert yahoo.source.fetch(vwce(), TO, FROM).bars == ()
    assert yahoo.requests == []


# --- quote currency (R3) ------------------------------------------------------------------------


def vusa(currency: Currency = Currency.GBP):
    return build_instrument(
        name="Vanguard S&P 500 UCITS ETF",
        symbol="VUSA",
        mic="XLON",
        currency=currency,
        asset_class=AssetClass.ETF,
        aliases=[InstrumentAlias("yahoo", "VUSA.L", guessed=True)],
    )


def test_gbp_pence_quotes_are_divided_by_100_and_recorded_as_gbp():
    answer = Yahoo(fixture("yahoo_vusa_l_gbp_synthetic.json")).source.fetch(vusa(), FROM, TO)
    assert answer.currency == Currency.GBP
    assert [str(b.date) for b in answer.bars] == [
        "2026-09-14",
        "2026-09-15",
        "2026-09-16",
        "2026-09-17",
    ]
    assert [b.close for b in answer.bars] == [d("95.125"), d("94.88"), d("95.0125"), d("95.3")]
    first = answer.bars[0]
    assert (first.open, first.high, first.low) == (d("94.9"), d("95.2"), d("94.7"))
    assert first.volume == 120345  # volume is not a price
    assert all(b.currency == Currency.GBP for b in answer.bars)


def test_a_quote_currency_other_than_the_instrument_currency_is_a_non_retryable_error():
    yahoo = Yahoo(fixture("yahoo_vusa_l_gbp_synthetic.json"))
    with pytest.raises(QuoteCurrencyMismatchException) as caught:
        yahoo.source.history(vusa(Currency.USD), FROM, TO)
    mismatch = caught.value
    assert (mismatch.quote_currency, mismatch.instrument_currency, mismatch.retryable) == (
        Currency.GBP,
        Currency.USD,
        False,
    )
    assert (
        'quote currency GBP for "VUSA.L" differs from the instrument currency USD'
        in mismatch.message
    )


def test_zac_and_ila_are_minor_units_a_missing_currency_is_unchecked_garbage_is_an_error():
    yahoo = Yahoo("{}").source
    zar = build_instrument(currency=Currency("ZAR"), aliases=[InstrumentAlias("yahoo", "X.JO")])
    ils = build_instrument(currency=Currency("ILS"), aliases=[InstrumentAlias("yahoo", "X.TA")])

    def body(currency):
        return chart(0, [utc(2026, 9, 14, 8)], [1234], currency=currency)

    assert yahoo.parse_history(body("ZAc"), zar, FROM, TO).bars[0].close == d("12.34")
    assert yahoo.parse_history(body("ILA"), ils, FROM, TO).bars[0].close == d("12.34")
    unchecked = yahoo.parse_history(body(None), zar, FROM, TO)
    assert (unchecked.currency, unchecked.bars[0].close, unchecked.bars[0].currency) == (
        None,
        d("1234"),
        None,
    )
    with pytest.raises(SourceException, match='quote currency "pounds"'):
        yahoo.parse_history(body("pounds"), zar, FROM, TO)


# --- split events (R6) --------------------------------------------------------------------------

SPLITTER = build_instrument(
    name="Splitter Inc",
    symbol="SPLT",
    mic="XNAS",
    currency=Currency.USD,
    aliases=[InstrumentAlias("yahoo", "SPLT")],
)


def test_splits_in_the_range_come_back_with_the_adjusted_bars():
    yahoo = Yahoo(fixture("yahoo_split_4for1_synthetic.json"))
    answer = yahoo.source.fetch(SPLITTER, FROM, TO)
    assert answer.splits == (SplitEvent(date=day("2026-09-16"), ratio=d("4")),)
    assert [b.close for b in answer.bars] == [d("100"), d("99.5"), d("101"), d("101.5")]
    assert yahoo.requests[0].url.params["events"] == "split"


def test_splits_outside_the_range_are_dropped_and_malformed_entries_ignored():
    body = chart(
        -14400,
        [utc(2026, 9, 14, 13, 30)],
        [10],
        currency="USD",
        events={
            "splits": {
                "a": {"date": utc(2026, 9, 1, 13, 30), "numerator": 2, "denominator": 1},
                "b": {"date": utc(2026, 9, 14, 13, 30), "numerator": 1, "denominator": 10},
                "c": {"date": utc(2026, 9, 15, 13, 30), "numerator": 0, "denominator": 1},
            }
        },
    )
    answer = Yahoo("{}").source.parse_history(body, SPLITTER, day("2026-09-10"), TO)
    assert answer.splits == (SplitEvent(date=day("2026-09-14"), ratio=d("0.1")),)  # reverse 1:10
