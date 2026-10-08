"""Instrument search over free public sources (F12): Yahoo's symbol search for tickers, names, ISINs and
crypto, and OpenFIGI's ISIN mapping, which adds the other listings of an ISIN (Yahoo shows one or two).
HTTP goes through :class:`MarketHttp`; parsing is pure (``parse_*``) and unit-tested on recorded
responses.

A hit is a candidate listing, never stored as is: its ``currency_hint`` is the market's usual currency
(wrong for e.g. VWRA.L, which trades in USD on the LSE), so adding a pick verifies the symbol and takes
the currency from the Yahoo chart meta first (``service.watchlist``). Stooq has no usable search.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Literal, Protocol

from ..domain import AssetClass, Currency
from ..importing.exchanges import (
    CRYPTO,
    US_LISTING,
    ExchangeInfo,
    exchange_for_mic,
    exchange_for_yahoo_suffix,
)
from .market_http import MarketHttp, body_snippet
from .sources import SourceBlockedException, SourceException
from .yahoo import YahooPriceSource

SEARCH_TIMEOUT = 5.0
"""Seconds one remote search request may take (typing must stay responsive)."""
SearchSource = Literal["yahoo", "openfigi"]
ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")

MIC_LABELS: dict[str, str] = {
    "XWAR": "GPW",
    "XNCO": "NewConnect",
    "XETR": "XETRA",
    "XNAS": "NASDAQ",
    "XNYS": "NYSE",
    "ARCX": "NYSE Arca",
    "BATS": "Cboe",
    "XASE": "NYSE American",
    "IEXG": "IEX",
    "XLON": "LSE",
    "XASX": "ASX",
    "XTSE": "TSX",
    "XTSX": "TSXV",
    "XHKG": "HKEX",
    "XPAR": "Paris",
    "XAMS": "Amsterdam",
    "XBRU": "Brussels",
    "XMIL": "Milan",
    "XMAD": "Madrid",
    "XSWX": "SIX",
    "XSTO": "Stockholm",
    "XCSE": "Copenhagen",
    "XOSL": "Oslo",
    "XHEL": "Helsinki",
}
"""Short exchange labels of the known markets (stored instruments and OpenFIGI hits; Yahoo hits carry
Yahoo's own ``exchDisp``)."""


@dataclass(frozen=True, slots=True)
class SearchHit:
    """One listing a remote source found."""

    yahoo_symbol: str | None
    ticker: str
    """Display symbol: ``VWCE``, ``PKN``, ``NVDA``, ``BTC`` (crypto: the base coin)."""
    name: str
    quote_type: str
    """The source's type (Yahoo ``quoteType``; OpenFIGI ``securityType``)."""
    asset_class: AssetClass
    exchange_label: str | None
    """Human exchange name (Yahoo ``exchDisp``: XETRA, WSE, NASDAQ; OpenFIGI: :data:`MIC_LABELS`)."""
    mic: str | None
    """ISO MIC when the listing maps to a known market (never invented: None for ``.MU``, ``.SG``,
    a US listing without a known exchange or crypto)."""
    currency_hint: Currency | None
    """The market's usual currency (crypto: the pair's quote currency). A hint only: never stored
    without the chart meta check."""
    isin: str | None = None
    source: SearchSource = "yahoo"
    market: ExchangeInfo | None = None
    """The market the listing maps to (``US_LISTING`` / ``CRYPTO`` without a MIC), None when unknown."""

    @property
    def known_market(self) -> bool:
        return self.market is not None


class SymbolSearch(Protocol):
    def search(self, query: str) -> list[SearchHit]: ...


class IsinLookup(Protocol):
    def lookup(self, isin: str) -> list[SearchHit]: ...


def is_isin(text: str) -> bool:
    return ISIN.match(text.strip().upper()) is not None


def _text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text or None


def _payload(body: str, source_id: str) -> object:
    try:
        return json.loads(body)
    except ValueError as error:
        raise SourceException(
            source_id, f"unexpected response: {body_snippet(body)}", cause=error
        ) from error


def _check_status(source_id: str, status: int, body: str) -> None:
    if status in (401, 403):
        raise SourceBlockedException(source_id, f"HTTP {status}: {body_snippet(body)}")
    if status != 200:
        raise SourceException(source_id, f"HTTP {status}: {body_snippet(body)}")


# --------------------------------------------------------------------------- #
# Yahoo
# --------------------------------------------------------------------------- #

YAHOO_TYPES: dict[str, AssetClass] = {
    "EQUITY": AssetClass.EQUITY,
    "ETF": AssetClass.ETF,
    "MUTUALFUND": AssetClass.FUND,
    "CRYPTOCURRENCY": AssetClass.CRYPTO,
    "INDEX": AssetClass.OTHER,
}
"""Kept Yahoo quote types; FUTURE, OPTION, CURRENCY and anything else are dropped."""

YAHOO_US_EXCHANGES: dict[str, str] = {
    "NMS": "XNAS",
    "NGM": "XNAS",
    "NCM": "XNAS",
    "NYQ": "XNYS",
    "PCX": "ARCX",
    "BTS": "BATS",
    "ASE": "XASE",
}
"""Yahoo exchange codes of suffix-less US listings -> MIC (any other code: a US listing, MIC None)."""


def yahoo_market(
    symbol: str, quote_type: str, exchange: str | None = None
) -> tuple[str, ExchangeInfo | None]:
    """The display ticker and the market of a Yahoo symbol (``VWCE.DE`` -> VWCE on XETR, ``BTC-USD`` ->
    BTC on the crypto pseudo-market, a suffix-less symbol -> a US listing, its MIC from Yahoo's
    ``exchange`` code when known); the market is None for a suffix no known market uses."""
    if quote_type == "CRYPTOCURRENCY":
        base, _, quote = symbol.partition("-")
        return (base or symbol), CRYPTO if quote else None
    if quote_type == "INDEX" or symbol.startswith("^"):
        return symbol, None
    cut = symbol.rfind(".")
    if 0 < cut < len(symbol) - 1:
        return symbol[:cut], exchange_for_yahoo_suffix(symbol[cut:])
    mic = YAHOO_US_EXCHANGES.get((exchange or "").upper())
    return symbol, (exchange_for_mic(mic) if mic else US_LISTING)


def crypto_currency(symbol: str) -> Currency | None:
    """The quote currency of a Yahoo crypto pair (``BTC-USD`` -> USD), or None."""
    _base, _, quote = symbol.partition("-")
    try:
        return Currency(quote.upper()) if quote else None
    except ValueError:
        return None


def parse_yahoo_search(body: str, *, query: str | None = None) -> list[SearchHit]:
    """Hits of a Yahoo search response, in Yahoo's order (types filtered, duplicates dropped). With
    an ISIN ``query`` every hit carries that ISIN (Yahoo matched it by ISIN)."""
    data = _payload(body, "yahoo")
    quotes = data.get("quotes") if isinstance(data, dict) else None
    if not isinstance(quotes, list):
        raise SourceException("yahoo", f"unexpected search response: {body_snippet(body)}")
    isin = query.strip().upper() if query and is_isin(query) else None
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for quote in quotes:
        if not isinstance(quote, dict) or quote.get("isYahooFinance") is False:
            continue
        symbol = _text(quote.get("symbol"))
        quote_type = (_text(quote.get("quoteType")) or "").upper()
        asset_class = YAHOO_TYPES.get(quote_type)
        if symbol is None or asset_class is None or symbol.upper() in seen:
            continue
        seen.add(symbol.upper())
        exchange = _text(quote.get("exchange"))
        ticker, market = yahoo_market(symbol, quote_type, exchange)
        if market is not None and market.crypto:
            currency = crypto_currency(symbol)
        else:
            currency = market.currency if market is not None else None
        hits.append(
            SearchHit(
                yahoo_symbol=symbol,
                ticker=ticker,
                name=_text(quote.get("longname")) or _text(quote.get("shortname")) or symbol,
                quote_type=quote_type,
                asset_class=asset_class,
                exchange_label=_text(quote.get("exchDisp")) or exchange,
                mic=market.mic if market is not None else None,
                currency_hint=currency,
                isin=isin,
                source="yahoo",
                market=market,
            )
        )
    return hits


class YahooSymbolSearch:
    """``GET https://query1.finance.yahoo.com/v1/finance/search`` (no key; the short user agent of
    :class:`YahooPriceSource`: a full browser string got HTTP 429 in live tries)."""

    def __init__(
        self,
        http: MarketHttp,
        *,
        host: str = "query1.finance.yahoo.com",
        user_agent: str = YahooPriceSource.DEFAULT_USER_AGENT,
        count: int = 10,
    ) -> None:
        self._http = http
        self.host = host
        self.user_agent = user_agent
        self.count = count

    def search(self, query: str) -> list[SearchHit]:
        response = self._http.get(
            f"https://{self.host}/v1/finance/search",
            source_id="yahoo",
            params={
                "q": query,
                "quotesCount": str(self.count),
                "newsCount": "0",
                "listsCount": "0",
                "enableFuzzyQuery": "false",
            },
            headers={"User-Agent": self.user_agent, "Accept": "application/json"},
        )
        _check_status("yahoo", response.status_code, response.text)
        return parse_yahoo_search(response.text, query=query)


# --------------------------------------------------------------------------- #
# OpenFIGI
# --------------------------------------------------------------------------- #

FIGI_EXCHANGES: dict[str, str | None] = {
    **dict.fromkeys(("US", "UN", "UW", "UQ", "UR", "UA", "UP"), None),  # a US listing
    "PW": "XWAR",
    "GY": "XETR",
    "GR": "XETR",
    "LN": "XLON",
    "NA": "XAMS",
    "IM": "XMIL",
    "FP": "XPAR",
    "BB": "XBRU",
    "SM": "XMAD",
    "SW": "XSWX",
    "SS": "XSTO",
    "DC": "XCSE",
    "NO": "XOSL",
    "FH": "XHEL",
    "CT": "XTSE",
    "AT": "XASX",
    "HK": "XHKG",
}
"""Bloomberg exchange codes -> MIC (None: a US listing without a MIC). ``GR`` (the German composite) is
read as XETRA: its ticker is the Xetra one (VWCE), which Yahoo spells ``.DE``. Unmapped codes are
dropped."""


def _figi_asset_class(row: dict) -> AssetClass:
    kinds = {_text(row.get("securityType")), _text(row.get("securityType2"))}
    if "ETP" in kinds:
        return AssetClass.ETF
    if "Common Stock" in kinds:
        return AssetClass.EQUITY
    return AssetClass.OTHER


def parse_openfigi_mapping(body: str, isin: str) -> list[SearchHit]:
    """Hits of an OpenFIGI mapping response for one ISIN job, deduplicated by Yahoo symbol, in the
    response's order. A job answered with ``warning`` / ``error`` (no such ISIN) has no hits."""
    data = _payload(body, "openfigi")
    if not isinstance(data, list):
        raise SourceException("openfigi", f"unexpected mapping response: {body_snippet(body)}")
    wanted = isin.strip().upper()
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for job in data:
        rows = job.get("data") if isinstance(job, dict) else None
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = _text(row.get("exchCode"))
            ticker = _text(row.get("ticker"))
            if code not in FIGI_EXCHANGES or ticker is None:
                continue
            mic = FIGI_EXCHANGES[code]
            market = exchange_for_mic(mic) if mic else US_LISTING
            if market is None:
                continue
            symbol = market.yahoo_symbol(ticker.replace("/", "-"))
            if symbol is None or symbol.upper() in seen:
                continue
            seen.add(symbol.upper())
            hits.append(
                SearchHit(
                    yahoo_symbol=symbol,
                    ticker=ticker.replace("/", "-").upper(),  # BRK/B -> BRK-B, as Yahoo
                    name=_text(row.get("name")) or ticker,
                    quote_type=_text(row.get("securityType")) or "",
                    asset_class=_figi_asset_class(row),
                    exchange_label=MIC_LABELS.get(mic or "", "US"),
                    mic=mic,
                    currency_hint=market.currency,
                    isin=wanted,
                    source="openfigi",
                    market=market,
                )
            )
    return hits


class OpenFigiIsinLookup:
    """``POST https://api.openfigi.com/v3/mapping`` without a key (low rate limit; interactive use
    only, for ISIN queries)."""

    def __init__(self, http: MarketHttp, *, host: str = "api.openfigi.com") -> None:
        self._http = http
        self.host = host

    def lookup(self, isin: str) -> list[SearchHit]:
        wanted = isin.strip().upper()
        response = self._http.post(
            f"https://{self.host}/v3/mapping",
            source_id="openfigi",
            json=[{"idType": "ID_ISIN", "idValue": wanted}],
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        _check_status("openfigi", response.status_code, response.text)
        return parse_openfigi_mapping(response.text, wanted)


__all__ = [
    "FIGI_EXCHANGES",
    "MIC_LABELS",
    "SEARCH_TIMEOUT",
    "YAHOO_TYPES",
    "YAHOO_US_EXCHANGES",
    "IsinLookup",
    "OpenFigiIsinLookup",
    "SearchHit",
    "SymbolSearch",
    "YahooSymbolSearch",
    "crypto_currency",
    "is_isin",
    "parse_openfigi_mapping",
    "parse_yahoo_search",
    "yahoo_market",
]
