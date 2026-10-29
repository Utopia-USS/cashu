"""`cashu serve` for the e2e suite, with the market sources swapped for the synthetic generator of
scripts/demo_data.py, so a daily check (POST /run, the automatic one is off here) and the backfill never touch the network,
and the instrument search swapped for recorded Yahoo answers (`VWCE`, `orlen`, `nvidia`; anything else
finds nothing) with synthetic charts for the pick verification.

Run with CASHU_DATA_DIR set (the e2e global setup does it); arguments go to `cashu serve`:

    CASHU_DATA_DIR=<tmp> .venv/bin/python frontend/e2e/serve_offline.py --port 8711

It prints the same one-time `Dashboard: http://127.0.0.1:<port>/#token=...` line as `cashu serve`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _refuse_outbound_http() -> None:
    """Any httpx request to a non-loopback host fails loudly (tests never hit live HTTP)."""
    import httpx

    original = httpx.HTTPTransport.handle_request

    def guarded(self, request):
        if request.url.host not in ("127.0.0.1", "localhost", "::1"):
            raise httpx.ConnectError(f"e2e: outbound HTTP refused ({request.url.host})")
        return original(self, request)

    httpx.HTTPTransport.handle_request = guarded


SEARCH_FIXTURES = REPO / "tests" / "investments" / "fixtures" / "market" / "search"
RECORDED_QUERIES = {"vwce": "yq_VWCE.json", "orlen": "yq_orlen.json", "nvidia": "yq_nvidia.json"}


def offline_search_sources():
    """``instrument_search.default_sources`` stand-in: recorded Yahoo search answers and a chart of
    synthetic bars (demo_data's generator, the ticker as its key, like the daily refresh) in the
    market's currency, so a pick verifies without the network."""
    import demo_data  # scripts/ is on sys.path (main)

    from cashu.modules.investments.domain import PriceBar
    from cashu.modules.investments.market import ChartQuote, SourceException
    from cashu.modules.investments.market.search import (
        crypto_currency,
        parse_yahoo_search,
        yahoo_market,
    )
    from cashu.modules.investments.service.instrument_search import SearchSources

    class RecordedSearch:
        def search(self, query):
            name = RECORDED_QUERIES.get(query.strip().casefold())
            if name is None:
                return []
            return parse_yahoo_search((SEARCH_FIXTURES / name).read_text(), query=query)

    class SyntheticChart:
        def chart(self, symbol, start, end, *, instrument_id="chart"):
            crypto = "-" in symbol
            ticker, market = yahoo_market(symbol, "CRYPTOCURRENCY" if crypto else "")
            currency = crypto_currency(symbol) if crypto else (market and market.currency)
            if currency is None:
                raise SourceException("yahoo", f'no such symbol "{symbol}"')
            bars = tuple(
                PriceBar(
                    instrument_id=instrument_id,
                    date=day,
                    close=demo_data.close_on(ticker, day),
                    source="yahoo",
                    currency=currency,
                )
                for day in demo_data.sessions(max(start, demo_data.EPOCH), end)
            )
            return ChartQuote(symbol, currency, None, None, None, bars)

    return SearchSources(RecordedSearch(), None, SyntheticChart())


def main() -> None:
    if not os.environ.get("CASHU_DATA_DIR"):
        raise SystemExit("CASHU_DATA_DIR must point at a temporary data dir")
    sys.path.insert(0, str(REPO / "scripts"))
    import demo_data  # scripts/ is not a package

    from cashu.modules.investments.service import daily

    daily.default_sources = demo_data.synthetic_sources  # the backfill reads it from daily too
    from cashu.modules.investments.service import instrument_search

    instrument_search.default_sources = offline_search_sources
    from cashu.modules.investments.service import prices

    prices.default_sources = prices.offline_sources  # the app's refresh on open: no network, no writes
    # the automatic daily check (P10) stays off: the specs start from the seeded data and run it themselves
    os.environ["CASHU_AUTO_DAILY"] = "0"
    _refuse_outbound_http()
    from cashu.cli import app

    sys.argv = ["cashu", "serve", *sys.argv[1:]]
    app()


if __name__ == "__main__":
    main()
