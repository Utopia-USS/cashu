"""Stooq CSV source (bot-check detection) and NBP FX source (chunking, 404 = no data).

Port of stooq_price_source_test.dart and nbp_fx_source_test.dart.
"""

from __future__ import annotations

from datetime import date, timedelta

import httpx
import pytest
from inv_market_support import (
    FETCHED_AT,
    d,
    day,
    fake_clock,
    fixture,
    make_http,
    orlen,
    recording,
    respond,
)

from finanse.modules.investments.domain import Currency, FxRate, InstrumentAlias, PriceBar
from finanse.modules.investments.market import (
    NbpFxSource,
    NoPriceSourceException,
    SourceBlockedException,
    SourceException,
    StooqPriceSource,
)

FROM, TO = day("2026-09-14"), day("2026-09-25")

# --- stooq --------------------------------------------------------------------------------------


class Stooq:
    def __init__(self, body: str, status: int = 200, content_type: str = "text/csv"):
        self.requests: list[httpx.Request] = []
        client = recording(self.requests, lambda _: respond(body, status, content_type))
        self.source = StooqPriceSource(make_http(client), clock=fake_clock)


def stooq_failure(stooq: Stooq, instrument=None) -> SourceException:
    with pytest.raises(SourceException) as caught:
        stooq.source.history(instrument or orlen(), FROM, TO)
    return caught.value


def test_stooq_parses_the_polish_csv_and_asks_for_alias_and_range():
    pkn = orlen()
    stooq = Stooq(fixture("stooq_pkn_synthetic.csv"))
    bars = stooq.source.history(pkn, FROM, TO)

    url = stooq.requests[0].url
    assert url.host == "stooq.pl"
    assert url.path == "/q/d/l/"
    assert dict(url.params) == {"s": "pkn", "i": "d", "d1": "20260914", "d2": "20260925"}
    assert [str(b.date) for b in bars] == ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]
    assert bars[0] == PriceBar(
        instrument_id=pkn.id,
        date=day("2026-09-14"),
        open=d("64.12"),
        high=d("65.3"),
        low=d("63.9"),
        close=d("65.08"),
        volume=2154321,
        source="stooq",
        fetched_at=FETCHED_AT,
    )
    assert bars[-1].close == d("65.36")


def test_stooq_keeps_only_bars_inside_the_range_oldest_first():
    bars = Stooq(fixture("stooq_pkn_synthetic.csv")).source.history(
        orlen(), day("2026-09-15"), day("2026-09-16")
    )
    assert [str(b.date) for b in bars] == ["2026-09-15", "2026-09-16"]


def test_stooq_parses_english_headers_without_a_volume_column():
    index = orlen(aliases=[InstrumentAlias("stooq", "wig20")])
    bars = Stooq(fixture("stooq_index_no_volume_synthetic.csv")).source.history(index, FROM, TO)
    assert len(bars) == 2
    assert bars[0].close == d("2428.73")
    assert bars[0].volume is None


def test_stooq_ignores_a_byte_order_mark():
    body = "﻿" + fixture("stooq_pkn_synthetic.csv")
    assert (
        len(Stooq(body, content_type="text/csv; charset=utf-8").source.history(orlen(), FROM, TO))
        == 4
    )


def test_stooq_brak_danych_is_an_empty_answer():
    weekend = (day("2026-09-19"), day("2026-09-20"))
    assert Stooq(fixture("stooq_no_data.txt")).source.history(orlen(), *weekend) == []
    assert Stooq("No data").source.history(orlen(), *weekend) == []


def test_stooq_bot_protection_page_is_a_non_retryable_blocked_exception():
    error = stooq_failure(
        Stooq(fixture("stooq_challenge.html"), content_type="text/html; charset=utf-8")
    )
    assert isinstance(error, SourceBlockedException)
    assert error.retryable is False
    assert error.source_id == "stooq"
    assert "browser verification" in error.message


def test_stooq_daily_hit_limit_is_a_retryable_blocked_exception():
    error = stooq_failure(Stooq(fixture("stooq_daily_limit.txt")))
    assert isinstance(error, SourceBlockedException)
    assert error.retryable is True
    assert "daily request limit" in error.message


def test_stooq_api_key_demand_is_blocked():
    error = stooq_failure(
        Stooq("Get your apikey:\n1. Open https://stooq.com/q/d/?s=pkn&get_apikey")
    )
    assert isinstance(error, SourceBlockedException)
    assert "API key" in error.message


def test_stooq_another_html_page_is_a_plain_non_retryable_source_exception():
    error = stooq_failure(Stooq("<html><body>Strona w przebudowie</body></html>"))
    assert not isinstance(error, SourceBlockedException)
    assert error.retryable is False
    assert "HTML page" in error.message


def test_stooq_unexpected_text_and_malformed_rows_name_the_problem():
    assert "unexpected response" in stooq_failure(Stooq("Symbol,Name\npkn,Orlen")).message
    malformed = stooq_failure(
        Stooq(
            "Data,Otwarcie,Najwyzszy,Najnizszy,Zamkniecie,Wolumen\n"
            "2026-09-14,1,2,0.5,1.5,10\n2026-09-15,1,2,0.5,n/a,10"
        )
    )
    assert "malformed CSV row 3" in malformed.message
    assert malformed.cause is not None
    assert stooq_failure(Stooq("")).retryable is True


def test_stooq_non_200_status_is_a_source_exception():
    assert "HTTP 410" in stooq_failure(Stooq("gone", status=410)).message


def test_stooq_instrument_without_alias_cannot_be_priced_and_makes_no_request():
    stooq = Stooq(fixture("stooq_pkn_synthetic.csv"))
    error = stooq_failure(stooq, orlen(aliases=[InstrumentAlias("yahoo", "PKN.WA")]))
    assert isinstance(error, NoPriceSourceException)
    assert stooq.requests == []


def test_stooq_empty_range_makes_no_request():
    stooq = Stooq(fixture("stooq_pkn_synthetic.csv"))
    assert stooq.source.history(orlen(), day("2026-09-15"), day("2026-09-14")) == []
    assert stooq.requests == []


# --- NBP ----------------------------------------------------------------------------------------


def requested_range(request: httpx.Request) -> tuple[date, date]:
    """(start, end) of a path ``/api/exchangerates/rates/A/<code>/<start>/<end>/``."""
    segments = [s for s in request.url.path.split("/") if s]
    return day(segments[-2]), day(segments[-1])


class Nbp:
    def __init__(self, handler, max_days_per_request: int = 93):
        self.requests: list[httpx.Request] = []
        self.source = NbpFxSource(
            make_http(recording(self.requests, handler)),
            clock=fake_clock,
            max_days_per_request=max_days_per_request,
        )


def test_nbp_parses_the_recorded_usd_response_pln_per_usd():
    nbp = Nbp(lambda _: respond(fixture("nbp_usd.json")))
    rates = nbp.source.rates(Currency.USD, FROM, TO)

    url = nbp.requests[0].url
    assert url.host == "api.nbp.pl"
    assert url.path == "/api/exchangerates/rates/A/usd/2026-09-14/2026-09-25/"
    assert dict(url.params) == {"format": "json"}
    assert [str(r.date) for r in rates] == ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]
    assert rates[0] == FxRate(
        quote=Currency.USD,
        date=day("2026-09-14"),
        rate=d("3.7607"),
        source="nbp",
        fetched_at=FETCHED_AT,
    )
    assert rates[0].base == Currency.PLN
    assert str(rates[-1].rate) == "3.803"  # exact decimal text, never a float


def test_nbp_parses_the_recorded_eur_response_with_a_polish_name():
    rates = Nbp(lambda _: respond(fixture("nbp_eur.json"))).source.rates(Currency.EUR, FROM, TO)
    assert [r.rate for r in rates] == [d("4.3391"), d("4.3445"), d("4.3435"), d("4.3632")]
    assert all(r.quote == Currency.EUR for r in rates)


def test_nbp_long_range_is_split_into_contiguous_requests_of_at_most_93_days():
    def handler(request):
        start, end = requested_range(request)
        if start <= day("2026-09-14") and end >= day("2026-09-17"):
            return respond(fixture("nbp_usd.json"))
        return respond(fixture("nbp_no_data_404.txt"), 404, "text/plain; charset=utf-8")

    nbp = Nbp(handler)
    rates = nbp.source.rates(Currency.USD, day("2026-01-01"), day("2026-12-31"))

    ranges = [requested_range(r) for r in nbp.requests]
    assert len(ranges) == 4  # 365 days / 93
    assert ranges[0][0] == day("2026-01-01")
    assert ranges[-1][1] == day("2026-12-31")
    for index, (start, end) in enumerate(ranges):
        assert (end - start).days + 1 <= 93
        if index > 0:
            assert start == ranges[index - 1][1] + timedelta(days=1)
    assert len(rates) == 4


def test_nbp_chunk_size_is_configurable():
    nbp = Nbp(lambda _: respond(fixture("nbp_usd.json")), max_days_per_request=367)
    nbp.source.rates(Currency.USD, day("2025-09-01"), day("2026-10-03"))
    assert [f"{s}..{e}" for s, e in map(requested_range, nbp.requests)] == [
        "2025-09-01..2026-09-02",
        "2026-09-03..2026-10-03",
    ]


def test_nbp_recorded_404_for_a_range_without_tables_is_an_empty_answer():
    nbp = Nbp(lambda _: respond(fixture("nbp_no_data_404.txt"), 404, "text/plain"))
    assert nbp.source.rates(Currency.USD, day("2026-09-19"), day("2026-09-20")) == []
    assert len(nbp.requests) == 1  # not retried


def test_nbp_recorded_400_range_limit_is_a_non_retryable_source_exception():
    nbp = Nbp(lambda _: respond(fixture("nbp_range_limit_400.txt"), 400, "text/plain"))
    with pytest.raises(SourceException) as caught:
        nbp.source.rates(Currency.USD, day("2026-09-01"), day("2026-09-30"))
    assert caught.value.source_id == "nbp"
    assert caught.value.retryable is False
    assert "HTTP 400" in caught.value.message
    assert "367" in caught.value.message


def test_nbp_response_for_another_currency_or_unexpected_shape_is_a_source_exception():
    with pytest.raises(SourceException, match="rates for EUR"):
        Nbp(lambda _: respond(fixture("nbp_eur.json"))).source.rates(Currency.USD, FROM, TO)
    with pytest.raises(SourceException, match="unexpected response"):
        Nbp(lambda _: respond("<html>maintenance</html>", 200, "text/html")).source.rates(
            Currency.USD, FROM, TO
        )


def test_nbp_5xx_is_retried_by_the_shared_http_helper():
    calls = {"n": 0}

    def handler(_):
        calls["n"] += 1
        return respond("busy", 503) if calls["n"] == 1 else respond(fixture("nbp_usd.json"))

    nbp = Nbp(handler)
    assert len(nbp.source.rates(Currency.USD, FROM, TO)) == 4
    assert len(nbp.requests) == 2


def test_nbp_pln_and_an_empty_range_make_no_request():
    nbp = Nbp(lambda _: respond(fixture("nbp_usd.json")))
    assert nbp.source.rates(Currency.PLN, FROM, TO) == []
    assert nbp.source.rates(Currency.USD, TO, FROM) == []
    assert nbp.requests == []
