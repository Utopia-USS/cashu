"""Batched quotes for the price refresh (P10): Yahoo spark and NBP tables parsing, and the batched
sources' fallback rules. No live HTTP: MockTransport clients and synthetic bodies in Yahoo's / NBP's
recorded shapes."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

import httpx
import pytest
from inv_market_support import (
    build_instrument,
    fake_clock,
    make_http,
    orlen,
    recording,
    respond,
    utc,
    vwce,
    weekdays,
)

from cashu.modules.investments.domain import Currency, FxRate, InstrumentAlias, PriceBar
from cashu.modules.investments.market import (
    NbpFxSource,
    PriceHistory,
    PriceSource,
    SourceBlockedException,
    YahooPriceSource,
)
from cashu.modules.investments.market.batched import BatchedFxSource, BatchedPriceSource


def spark_entry(symbol: str, currency: str, closes: dict[date, float]) -> dict:
    """One spark result as Yahoo serves it (sessions stamped 13:30 UTC, gmtoffset 0, closes only)."""
    days = sorted(closes)
    return {
        "symbol": symbol,
        "response": [
            {
                "meta": {"currency": currency, "symbol": symbol, "gmtoffset": 0},
                "timestamp": [utc(d.year, d.month, d.day, 13, 30) for d in days],
                "indicators": {"quote": [{"close": [closes[d] for d in days]}]},
            }
        ],
    }


def spark_body(*entries: dict) -> str:
    return json.dumps({"spark": {"result": list(entries), "error": None}})


def closes(start: date, end: date, value: float) -> dict[date, float]:
    return {d: value for d in weekdays(start, end)}


class Fallback(PriceSource):
    """Records which instruments went the per-instrument way; answers one bar at ``end``."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, date, date]] = []

    @property
    def id(self) -> str:
        return "fallback"

    def history(self, instrument, start, end):
        return list(self.fetch(instrument, start, end).bars)

    def fetch(self, instrument, start, end):
        self.calls.append((instrument.symbol or instrument.name, start, end))
        bar = PriceBar(instrument_id=instrument.id, date=end, close=Decimal(1), source="fallback")
        return PriceHistory(bars=(bar,))


def us_stock(symbol: str, currency: Currency = Currency.USD):
    return build_instrument(
        name=symbol, symbol=symbol, mic="XNAS", currency=currency,
        aliases=(InstrumentAlias("yahoo", symbol),),
    )


# --- Yahoo spark ------------------------------------------------------------------------------


def test_spark_one_request_per_call_and_bodies_read_like_a_chart():
    requests: list[httpx.Request] = []
    body = spark_body(
        spark_entry("VWCE.DE", "EUR", closes(date(2026, 9, 28), date(2026, 10, 2), 172.86)),
        spark_entry("AAPL", "USD", closes(date(2026, 9, 28), date(2026, 10, 2), 334.35)),
    )
    yahoo = YahooPriceSource(make_http(recording(requests, lambda r: respond(body))), clock=fake_clock)

    bodies = yahoo.spark(["AAPL", "VWCE.DE", "NOSUCH"])

    assert len(requests) == 1
    assert requests[0].url.path == "/v7/finance/spark"
    assert requests[0].url.params["symbols"] == "AAPL,VWCE.DE,NOSUCH"
    assert requests[0].url.params["interval"] == "1d"
    assert set(bodies) == {"VWCE.DE", "AAPL"}  # an unknown symbol is simply absent
    history = yahoo.parse_history(bodies["VWCE.DE"], vwce(), date(2026, 10, 1), date(2026, 10, 2))
    assert [b.date for b in history.bars] == [date(2026, 10, 1), date(2026, 10, 2)]
    assert history.bars[-1].close == Decimal("172.86")
    assert history.bars[-1].open is None and history.currency == Currency.EUR


def test_spark_blocked_and_errors():
    yahoo = YahooPriceSource(make_http(recording([], lambda r: respond("denied", 403))))
    with pytest.raises(SourceBlockedException):
        yahoo.spark(["AAPL"])
    assert yahoo.spark([]) == {}


# --- NBP tables -------------------------------------------------------------------------------


def nbp_tables(days: list[date], rates: dict[str, str]) -> str:
    return json.dumps(
        [
            {
                "table": "A",
                "no": f"{i}/A/NBP/2026",
                "effectiveDate": d.isoformat(),
                "rates": [{"currency": c.lower(), "code": c, "mid": float(v)} for c, v in rates.items()],
            }
            for i, d in enumerate(days, 1)
        ]
    )


def test_nbp_table_rates_one_request_for_every_currency():
    requests: list[httpx.Request] = []
    days = [date(2026, 10, 1), date(2026, 10, 2)]
    body = nbp_tables(days, {"USD": "3.6512", "EUR": "4.2701", "XDR": "5.0"})
    nbp = NbpFxSource(make_http(recording(requests, lambda r: respond(body))), clock=fake_clock)

    rates = nbp.table_rates(date(2026, 10, 1), date(2026, 10, 2))

    assert len(requests) == 1
    assert requests[0].url.path == "/api/exchangerates/tables/A/2026-10-01/2026-10-02/"
    assert [r.rate for r in rates[Currency.USD]] == [Decimal("3.6512")] * 2
    assert rates[Currency.EUR][0].date == date(2026, 10, 1)
    empty = NbpFxSource(make_http(recording([], lambda r: respond("Brak danych", 404))))
    assert empty.table_rates(date(2026, 10, 3), date(2026, 10, 4)) == {}


# --- BatchedPriceSource -----------------------------------------------------------------------


def batched(handler, fallback=None, **kwargs):
    requests: list[httpx.Request] = []
    yahoo = YahooPriceSource(make_http(recording(requests, handler)), clock=fake_clock)
    return BatchedPriceSource(yahoo, fallback or Fallback(), **kwargs), requests


def test_chunks_of_twenty_symbols_and_answers_from_the_batch():
    stocks = [us_stock(f"S{n:02d}") for n in range(25)]

    def handler(request: httpx.Request) -> httpx.Response:
        symbols = request.url.params["symbols"].split(",")
        return respond(spark_body(*(
            spark_entry(s, "USD", closes(date(2026, 9, 7), date(2026, 10, 2), 10.5)) for s in symbols
        )))

    fallback = Fallback()
    source, requests = batched(handler, fallback)
    source.prefetch(stocks)

    assert len(requests) == 2  # 20 + 5
    answer = source.fetch(stocks[3], date(2026, 10, 1), date(2026, 10, 2))
    assert [b.close for b in answer.bars] == [Decimal("10.5")] * 2
    assert all(b.source == "yahoo" for b in answer.bars)
    assert fallback.calls == [] and source.batched == 1


def test_falls_back_when_the_batch_cannot_answer():
    aapl, euro_listed, nosuch = us_stock("AAPL"), us_stock("EUR1"), us_stock("NOSUCH")
    pkn = orlen()  # XWAR: stooq first, never batched

    def handler(request: httpx.Request) -> httpx.Response:
        return respond(spark_body(
            spark_entry("AAPL", "USD", closes(date(2026, 9, 21), date(2026, 10, 2), 330.0)),
            spark_entry("EUR1", "EUR", closes(date(2026, 9, 21), date(2026, 10, 2), 9.0)),
        ))

    fallback = Fallback()
    source, requests = batched(handler, fallback)
    source.prefetch([aapl, euro_listed, nosuch, pkn])
    assert requests[0].url.params["symbols"] == "AAPL,EUR1,NOSUCH,PKN.WA"  # one request for all

    source.fetch(aapl, date(2026, 9, 1), date(2026, 10, 2))  # older than the batch window
    source.fetch(euro_listed, date(2026, 10, 1), date(2026, 10, 2))  # currency mismatch
    source.fetch(nosuch, date(2026, 10, 1), date(2026, 10, 2))  # Yahoo left it out
    source.fetch(pkn, date(2026, 10, 1), date(2026, 10, 2))  # stooq-first listing
    assert [c[0] for c in fallback.calls] == ["AAPL", "EUR1", "NOSUCH", "PKN"]
    assert source.batched == 0 and source.fallbacks == 4


def test_split_guard_sends_an_adjusted_history_the_per_instrument_way():
    aapl, msft = us_stock("AAPL"), us_stock("MSFT")
    body = spark_body(
        spark_entry("AAPL", "USD", closes(date(2026, 9, 21), date(2026, 10, 2), 25.0)),  # 4:1 split
        spark_entry("MSFT", "USD", closes(date(2026, 9, 21), date(2026, 10, 2), 101.0)),
    )
    fallback = Fallback()
    source, _ = batched(
        lambda r: respond(body),
        fallback,
        last_closes={
            aapl.id: (date(2026, 9, 30), Decimal(100)),
            msft.id: (date(2026, 9, 30), Decimal(100)),
        },
    )
    source.prefetch([aapl, msft])
    source.fetch(aapl, date(2026, 9, 30), date(2026, 10, 2))
    assert source.fetch(msft, date(2026, 9, 30), date(2026, 10, 2)).bars[-1].close == Decimal(101)
    assert [c[0] for c in fallback.calls] == ["AAPL"]


def test_a_blocked_spark_stops_batching():
    stocks = [us_stock(f"S{n:02d}") for n in range(45)]
    fallback = Fallback()
    source, requests = batched(lambda r: respond("denied", 401), fallback)
    source.prefetch(stocks)
    assert len(requests) == 1 and source.batch_errors
    source.fetch(stocks[0], date(2026, 10, 1), date(2026, 10, 2))
    assert fallback.calls and source.fallbacks == 1


def test_without_yahoo_everything_goes_per_instrument():
    fallback = Fallback()
    source = BatchedPriceSource(None, fallback)
    source.prefetch([us_stock("AAPL")])
    source.fetch(us_stock("AAPL"), date(2026, 10, 1), date(2026, 10, 2))
    assert source.requests == 0 and len(fallback.calls) == 1


# --- BatchedFxSource --------------------------------------------------------------------------


class FallbackFx:
    def __init__(self) -> None:
        self.calls: list[tuple[str, date, date]] = []

    @property
    def id(self) -> str:
        return "nbp"

    def rates(self, quote, start, end):
        self.calls.append((str(quote), start, end))
        return [FxRate(quote=Currency(quote), date=end, rate=Decimal(4), source="nbp")]


def test_fx_from_one_table_request_within_its_window():
    days = [date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 2)]
    requests: list[httpx.Request] = []
    body = nbp_tables(days, {"USD": "3.6", "EUR": "4.25"})
    nbp = NbpFxSource(make_http(recording(requests, lambda r: respond(body))), clock=fake_clock)
    fallback = FallbackFx()
    fx = BatchedFxSource(nbp, fallback)
    fx.prefetch(date(2026, 9, 30), date(2026, 10, 2))

    usd = fx.rates(Currency.USD, date(2026, 10, 1), date(2026, 10, 2))
    eur = fx.rates(Currency.EUR, date(2026, 9, 30), date(2026, 10, 2))
    chf = fx.rates(Currency("CHF"), date(2026, 10, 1), date(2026, 10, 2))  # not in the table: none
    fx.rates(Currency.USD, date(2026, 9, 1), date(2026, 10, 2))  # older than the window

    assert len(requests) == 1
    assert [r.rate for r in usd] == [Decimal("3.6")] * 2 and len(eur) == 3 and chf == []
    assert fallback.calls == [("USD", date(2026, 9, 1), date(2026, 10, 2))]


class BlockedStooq(Fallback):
    """A composite stand-in whose stooq was blocked earlier in the run."""

    def blocked(self) -> set[str]:
        return {"stooq"}


def test_a_stooq_first_listing_uses_the_batch_once_stooq_is_blocked():
    pkn = orlen()
    body = spark_body(spark_entry("PKN.WA", "PLN", closes(date(2026, 9, 21), date(2026, 10, 2), 61.0)))
    fallback = BlockedStooq()
    source, _ = batched(lambda r: respond(body), fallback)
    source.prefetch([pkn])
    answer = source.fetch(pkn, date(2026, 10, 1), date(2026, 10, 2))
    assert [b.close for b in answer.bars] == [Decimal(61)] * 2 and fallback.calls == []
