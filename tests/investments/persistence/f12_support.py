"""F12 helpers: the real search sources (Yahoo search, OpenFIGI mapping, Yahoo chart) over an
``httpx.MockTransport`` answering with the recorded responses in ``fixtures/market/search`` (public
market data). No live HTTP; every request is recorded so tests can count them."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from cashu.modules.investments.market import MarketHttp, YahooPriceSource
from cashu.modules.investments.market.search import OpenFigiIsinLookup, YahooSymbolSearch
from cashu.modules.investments.service import instrument_search

SEARCH = Path(__file__).resolve().parents[1] / "fixtures" / "market" / "search"
QUERIES = {
    "vwce": "yq_VWCE.json",
    "nvidia": "yq_nvidia.json",
    "nvda": "yq_nvidia.json",  # what Yahoo answers for the bare ticker is the same set
    "orlen": "yq_orlen.json",
    "pkn": "yq_PKN.json",
    "gdxj": "yq_GDXJ.json",
    "bitcoin": "yq_bitcoin.json",
    "all world": "yq_all_world.json",
    "ie00bk5bqt80": "yq_IE00BK5BQT80.json",
    "us67066g1040": "yq_US67066G1040.json",
}
FIGI_JOBS = {"IE00BK5BQT80": 0, "PLPKN0000018": 1, "US67066G1040": 2}
EMPTY_SEARCH = json.dumps({"quotes": [], "news": []})


@dataclass
class Recorded:
    """Switches and the request log of one fake remote."""

    requests: list[httpx.Request] = field(default_factory=list)
    search_down: bool = False
    figi_down: bool = False
    chart_down: bool = False

    def paths(self, host_part: str) -> list[str]:
        return [str(r.url) for r in self.requests if host_part in str(r.url)]


def _handler(rec: Recorded):
    def handle(request: httpx.Request) -> httpx.Response:
        rec.requests.append(request)
        url = request.url
        if url.host == "api.openfigi.com":
            if rec.figi_down:
                return httpx.Response(429, text="Too Many Requests")
            isin = json.loads(request.content)[0]["idValue"]
            jobs = json.loads((SEARCH / "figi_map.json").read_text())
            job = (
                jobs[FIGI_JOBS[isin]] if isin in FIGI_JOBS else {"warning": "No identifier found."}
            )
            return httpx.Response(200, text=json.dumps([job]))
        if url.path == "/v1/finance/search":
            if rec.search_down:
                raise httpx.ConnectError("offline", request=request)
            name = QUERIES.get(url.params["q"].casefold())
            text = (SEARCH / name).read_text() if name else EMPTY_SEARCH
            return httpx.Response(200, text=text)
        if url.path.startswith("/v8/finance/chart/"):
            symbol = url.path.removeprefix("/v8/finance/chart/")
            path = SEARCH / f"chart_{symbol}.json"
            if rec.chart_down:
                raise httpx.ConnectError("offline", request=request)
            if not path.is_file():
                return httpx.Response(
                    404,
                    text='{"chart":{"result":null,"error":{"code":"Not Found",'
                    '"description":"No data found, symbol may be delisted"}}}',
                )
            return httpx.Response(200, text=path.read_text())
        return httpx.Response(404, text="{}")

    return handle


def fixture_sources(rec: Recorded | None = None) -> instrument_search.SearchSources:
    rec = rec or Recorded()
    client = httpx.Client(transport=httpx.MockTransport(_handler(rec)))
    http = MarketHttp(client, timeout=5.0, max_retries=0, sleep=lambda _s: None)
    return instrument_search.SearchSources(
        YahooSymbolSearch(http), OpenFigiIsinLookup(http), YahooPriceSource(http), client.close
    )


def install(monkeypatch, rec: Recorded | None = None) -> Recorded:
    """Make ``instrument_search.default_sources`` answer from the fixtures; returns the log."""
    rec = rec or Recorded()
    monkeypatch.setattr(instrument_search, "default_sources", lambda: fixture_sources(rec))
    instrument_search.clear_cache()
    return rec
