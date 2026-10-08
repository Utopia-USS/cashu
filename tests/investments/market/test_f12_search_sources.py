"""F12 search sources on recorded responses (public market data, probed 2026-10-08): Yahoo search hits
(types filtered, MIC mapping incl. US exchange codes, crypto base, unknown suffix -> no MIC), the OpenFIGI
mapping of three ISINs, the chart meta of a pick (VWRA.L trades in USD on the LSE), the HTTP adapters
(GET / POST, failures as SourceException) and the reverse Yahoo suffix lookup. No live HTTP."""

from __future__ import annotations

import json
from datetime import date

import httpx
import pytest
from inv_market_support import FIXTURES, FakeTime, make_http, recording, respond

from cashu.modules.investments.domain import AssetClass, Currency
from cashu.modules.investments.importing.exchanges import exchange_for_yahoo_suffix
from cashu.modules.investments.market import SourceException, YahooPriceSource
from cashu.modules.investments.market.search import (
    OpenFigiIsinLookup,
    YahooSymbolSearch,
    parse_openfigi_mapping,
    parse_yahoo_search,
)

SEARCH = FIXTURES / "search"


def body(name: str) -> str:
    return (SEARCH / name).read_text(encoding="utf-8")


def rows(hits) -> list[tuple]:
    return [(h.yahoo_symbol, h.ticker, h.mic, h.currency_hint, h.asset_class) for h in hits]


def test_yahoo_ticker_query_keeps_every_listing_and_maps_known_suffixes():
    hits = parse_yahoo_search(body("yq_VWCE.json"), query="VWCE")
    assert rows(hits)[:3] == [
        ("VWCE.DE", "VWCE", "XETR", Currency.EUR, AssetClass.ETF),
        ("VWCE.MI", "VWCE", "XMIL", Currency.EUR, AssetClass.ETF),
        ("VWCE.AS", "VWCE", "XAMS", Currency.EUR, AssetClass.ETF),
    ]
    assert hits[0].exchange_label == "XETRA" and hits[0].isin is None and hits[0].source == "yahoo"
    # unknown suffixes stay as hits without an invented MIC or currency
    munich = next(h for h in hits if h.yahoo_symbol == "VWCE.MU")
    assert (munich.mic, munich.currency_hint, munich.known_market) == (None, None, False)
    assert {h.yahoo_symbol for h in hits if h.mic is None} == {
        "VWCE.MU",
        "VWCED.XD",
        "VWCE.DU",
        "VWCEA.XD",
    }


def test_yahoo_name_query_drops_futures_and_maps_us_exchange_codes():
    hits = parse_yahoo_search(body("yq_nvidia.json"), query="nvidia")
    assert [h.yahoo_symbol for h in hits] == ["NVDA", "NVDX", "NVDA.TO", "NVD.DE", "NVDA.NE"]
    by = {h.yahoo_symbol: h for h in hits}
    assert (by["NVDA"].mic, by["NVDA"].exchange_label, by["NVDA"].ticker) == (
        "XNAS",
        "NASDAQ",
        "NVDA",
    )
    assert by["NVDX"].mic == "BATS" and by["NVD.DE"].mic == "XETR"
    assert by["NVDA.TO"].mic == "XTSE"  # .TO is a known market (TSX)
    assert by["NVDA.NE"].mic is None
    gdxj = parse_yahoo_search(body("yq_GDXJ.json"), query="GDXJ")
    assert [(h.yahoo_symbol, h.mic) for h in gdxj] == [
        ("GDXJ", "ARCX"),
        ("GDXJ.L", "XLON"),
        ("GDXJ.MI", "XMIL"),
    ]  # options dropped
    orlen = {h.yahoo_symbol: h for h in parse_yahoo_search(body("yq_orlen.json"))}
    assert orlen["PKN.WA"].mic == "XWAR" and orlen["PKN.WA"].name == "Orlen S.A."
    # an OTC code is a US listing without a MIC
    assert (orlen["PSKOF"].mic, orlen["PSKOF"].known_market) == (None, True)


def test_yahoo_crypto_and_isin_queries():
    hits = parse_yahoo_search(body("yq_bitcoin.json"), query="bitcoin")
    assert rows(hits) == [
        ("BTC-USD", "BTC", None, Currency.USD, AssetClass.CRYPTO),
        ("IBIT", "IBIT", "XNAS", Currency.USD, AssetClass.ETF),
        ("BCH-USD", "BCH", None, Currency.USD, AssetClass.CRYPTO),
    ]
    assert hits[0].known_market  # the crypto pseudo-market
    isin = parse_yahoo_search(body("yq_IE00BK5BQT80.json"), query="IE00BK5BQT80")
    assert [(h.yahoo_symbol, h.mic, h.asset_class, h.isin) for h in isin] == [
        ("VWRA.L", "XLON", AssetClass.ETF, "IE00BK5BQT80"),
        ("IE00BK5BQT80.SG", None, AssetClass.FUND, "IE00BK5BQT80"),
    ]
    nvda = parse_yahoo_search(body("yq_US67066G1040.json"), query="US67066G1040")
    assert [(h.yahoo_symbol, h.mic) for h in nvda] == [("NVDA", "XNAS")]


def test_yahoo_drops_non_finance_and_unknown_types():
    data = {
        "quotes": [
            {"symbol": "EURUSD=X", "quoteType": "CURRENCY", "isYahooFinance": True},
            {"symbol": "ABC", "quoteType": "EQUITY", "isYahooFinance": False},
            {
                "symbol": "^WIG20",
                "quoteType": "INDEX",
                "isYahooFinance": True,
                "shortname": "WIG20",
            },
            {"symbol": "ABC.WA", "quoteType": "EQUITY", "exchange": "WSE", "shortname": "  A  B  "},
            {"symbol": "abc.wa", "quoteType": "EQUITY"},
        ]
    }
    hits = parse_yahoo_search(json.dumps(data))
    assert [(h.yahoo_symbol, h.asset_class, h.mic, h.name) for h in hits] == [
        ("^WIG20", AssetClass.OTHER, None, "WIG20"),
        ("ABC.WA", AssetClass.EQUITY, "XWAR", "A B"),
    ]
    with pytest.raises(SourceException):
        parse_yahoo_search("<html>blocked</html>")


def test_openfigi_mapping_of_three_isins():
    jobs = json.loads(body("figi_map.json"))

    def hits(index: int, isin: str):
        return parse_openfigi_mapping(json.dumps([jobs[index]]), isin)

    vwce = hits(0, "IE00BK5BQT80")
    assert [(h.yahoo_symbol, h.mic) for h in vwce][:4] == [
        ("VWRA.L", "XLON"),
        ("VWRP.L", "XLON"),
        ("VWCE.DE", "XETR"),
        ("VWCE.MI", "XMIL"),
    ]
    assert {h.asset_class for h in vwce} == {AssetClass.ETF}
    assert {h.isin for h in vwce} == {"IE00BK5BQT80"} and {h.source for h in vwce} == {"openfigi"}
    pkn = hits(1, "PLPKN0000018")
    assert [(h.yahoo_symbol, h.mic, h.asset_class) for h in pkn][:1] == [
        ("PKN.WA", "XWAR", AssetClass.EQUITY)
    ]
    nvda = hits(2, "US67066G1040")
    assert nvda[0].yahoo_symbol == "NVDA" and nvda[0].mic is None and nvda[0].known_market
    symbols = [h.yahoo_symbol for h in nvda]
    assert len(symbols) == len(set(symbols))  # deduplicated (US, UN, UW, ... are one NVDA)
    assert hits(3, "XS0000000000") == []  # a job answered with a warning


def test_chart_meta_gives_the_pick_currency():
    source = YahooPriceSource(make_http(httpx.Client()))
    quote = source.parse_chart(
        body("chart_VWRA.L.json"), "VWRA.L", date(2025, 10, 1), date(2026, 10, 8)
    )
    assert quote.currency == Currency.USD  # not GBP: VWRA trades in USD on the LSE
    assert (quote.instrument_type, quote.exchange_name) == ("ETF", "LSE")
    assert quote.long_name == "Vanguard FTSE All-World UCITS ETF USD Accumulation"
    assert len(quote.bars) > 200 and {b.currency for b in quote.bars} == {Currency.USD}
    assert {b.instrument_id for b in quote.bars} == {"chart"}
    btc = source.parse_chart(
        body("chart_BTC-USD.json"), "BTC-USD", date(2025, 10, 1), date(2026, 10, 8)
    )
    assert (btc.currency, btc.instrument_type) == (Currency.USD, "CRYPTOCURRENCY")
    with pytest.raises(SourceException, match="no such symbol"):
        source.parse_chart(
            (FIXTURES / "yahoo_not_found.json").read_text(),
            "NOPE.DE",
            date(2026, 1, 1),
            date(2026, 2, 1),
        )


def test_http_adapters_send_the_right_requests_and_report_failures():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.openfigi.com":
            jobs = json.loads(body("figi_map.json"))
            return respond(json.dumps([jobs[1]]))
        if request.url.path == "/v1/finance/search":
            if request.url.params["q"] == "boom":
                return respond("busy", status=503)
            return respond(body("yq_orlen.json"))
        if request.url.path.startswith("/v8/finance/chart/"):
            return respond(body("chart_VWCE.DE.json"))
        return respond("{}", status=404)

    http = make_http(recording(requests, handler), FakeTime())
    http.max_retries = 0
    hits = YahooSymbolSearch(http).search("orlen")
    assert hits[0].yahoo_symbol == "PKN.WA"
    sent = requests[-1]
    assert sent.method == "GET" and sent.url.params["q"] == "orlen"
    assert sent.url.params["quotesCount"] == "10" and sent.url.params["newsCount"] == "0"
    assert sent.headers["User-Agent"] == YahooPriceSource.DEFAULT_USER_AGENT
    with pytest.raises(SourceException):
        YahooSymbolSearch(http).search("boom")

    figi = OpenFigiIsinLookup(http).lookup("plpkn0000018")
    sent = requests[-1]
    assert sent.method == "POST" and sent.url.path == "/v3/mapping"
    assert json.loads(sent.content) == [{"idType": "ID_ISIN", "idValue": "PLPKN0000018"}]
    assert figi[0].yahoo_symbol == "PKN.WA"

    quote = YahooPriceSource(http).chart("VWCE.DE", date(2025, 10, 1), date(2026, 10, 8))
    assert quote.currency == Currency.EUR and quote.bars
    assert requests[-1].url.path == "/v8/finance/chart/VWCE.DE"


def test_network_errors_are_source_exceptions():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    http = make_http(recording([], handler), FakeTime(), timeout=5.0)
    http.max_retries = 0
    with pytest.raises(SourceException, match="timed out after 5000 ms"):
        YahooSymbolSearch(http).search("orlen")
    with pytest.raises(SourceException):
        OpenFigiIsinLookup(http).lookup("PLPKN0000018")


def test_reverse_yahoo_suffix_lookup():
    assert exchange_for_yahoo_suffix(".DE").mic == "XETR"
    assert exchange_for_yahoo_suffix("wa").mic == "XWAR"  # GPW main market, not NewConnect
    assert exchange_for_yahoo_suffix(".L").mic == "XLON"
    assert exchange_for_yahoo_suffix(".HK").mic == "XHKG"
    for unknown in (".MU", ".SG", ".XD", ".DU", ".F", "", None):
        assert exchange_for_yahoo_suffix(unknown) is None
