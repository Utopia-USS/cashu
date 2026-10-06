"""Exchange hints found in broker exports (``GPW``, ``XWAR``, ``.PL`` suffixes) and the market data symbol
conventions derived from them (Yahoo / stooq ticker suffixes, default trading currency).

Everything derived here is a guess: aliases built from it are stored with ``guessed=True``.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..domain import Currency


@dataclass(frozen=True, slots=True)
class ExchangeInfo:
    """A market an exchange hint points to, plus how Yahoo and stooq spell its tickers."""

    mic: str | None
    """ISO 10383 MIC (``XWAR``), or None for a hint naming several markets (``US``) or crypto."""
    yahoo_suffix: str | None
    """Yahoo ticker suffix (``.WA``; empty for US listings; ``-USD`` for crypto), None when unknown."""
    stooq_suffix: str | None = None
    """stooq ticker suffix (empty for GPW, ``.us``, ``.de``, ``.uk``), None when unknown."""
    currency: Currency | None = None
    """Usual trading currency of the market (a default only; rows carry the real currency)."""
    crypto: bool = False
    """True for the crypto pseudo-market (no MIC; Yahoo pairs such as ``BTC-USD``)."""
    yahoo_digits: int | None = None
    """Yahoo pads numeric tickers of this market to this many digits (Hong Kong: ``700`` and
    ``00700`` -> ``0700.HK``)."""

    def yahoo_symbol(self, symbol: str) -> str | None:
        """Guessed Yahoo symbol of ``symbol`` on this market (``PKN`` -> ``PKN.WA``), or None."""
        if self.yahoo_suffix is None:
            return None
        ticker = symbol.strip().upper()
        if self.yahoo_digits is not None and ticker.isascii() and ticker.isdigit():
            ticker = str(int(ticker)).zfill(self.yahoo_digits)
        return f"{ticker}{self.yahoo_suffix}"

    def stooq_symbol(self, symbol: str) -> str | None:
        """Guessed stooq symbol of ``symbol`` on this market (``PKN`` -> ``pkn``), or None."""
        if self.stooq_suffix is None:
            return None
        return f"{symbol.strip().lower()}{self.stooq_suffix}"


def _market(
    mic: str, yahoo: str, currency: str, stooq: str | None = None, *, digits: int | None = None
) -> ExchangeInfo:
    return ExchangeInfo(
        mic=mic,
        yahoo_suffix=yahoo,
        stooq_suffix=stooq,
        currency=Currency(currency),
        yahoo_digits=digits,
    )


# Markets by MIC. Yahoo suffixes per Yahoo Finance conventions; stooq suffixes only where stooq lists
# the market with a stable suffix (as in Kompas).
MARKETS: dict[str, ExchangeInfo] = {
    "XNAS": _market("XNAS", "", "USD", ".us"),
    "XNYS": _market("XNYS", "", "USD", ".us"),
    "ARCX": _market("ARCX", "", "USD", ".us"),
    "BATS": _market("BATS", "", "USD", ".us"),
    "XASE": _market("XASE", "", "USD", ".us"),
    "IEXG": _market("IEXG", "", "USD", ".us"),
    "XWAR": _market("XWAR", ".WA", "PLN", ""),
    "XNCO": _market("XNCO", ".WA", "PLN", ""),
    "XLON": _market("XLON", ".L", "GBP", ".uk"),
    "XASX": _market("XASX", ".AX", "AUD"),
    "XTSE": _market("XTSE", ".TO", "CAD"),
    "XTSX": _market("XTSX", ".V", "CAD"),
    "XHKG": _market("XHKG", ".HK", "HKD", digits=4),
    "XPAR": _market("XPAR", ".PA", "EUR"),
    "XAMS": _market("XAMS", ".AS", "EUR"),
    "XBRU": _market("XBRU", ".BR", "EUR"),
    "XETR": _market("XETR", ".DE", "EUR", ".de"),
    "XMIL": _market("XMIL", ".MI", "EUR"),
    "XMAD": _market("XMAD", ".MC", "EUR"),
    "XSWX": _market("XSWX", ".SW", "CHF"),
    "XSTO": _market("XSTO", ".ST", "SEK"),
    "XCSE": _market("XCSE", ".CO", "DKK"),
    "XOSL": _market("XOSL", ".OL", "NOK"),
    "XHEL": _market("XHEL", ".HE", "EUR"),
}

US_LISTING = ExchangeInfo(mic=None, yahoo_suffix="", stooq_suffix=".us", currency=Currency.USD)
"""A US listing without a known exchange (hint ``US``)."""

CRYPTO = ExchangeInfo(mic=None, yahoo_suffix="-USD", currency=Currency.USD, crypto=True)
"""Crypto pseudo-market: Yahoo pairs against USD (``BTC`` -> ``BTC-USD``)."""

# Upper-case hint (MIC, exchange name, broker suffix without the dot) -> market. Ambiguous suffixes are
# left out on purpose (``BE`` is Belgium at some brokers but Berlin at Yahoo).
_ALIASES: dict[str, str] = {
    "GPW": "XWAR",
    "WSE": "XWAR",
    "WAR": "XWAR",
    "WA": "XWAR",
    "PL": "XWAR",
    "NEWCONNECT": "XNCO",
    "NC": "XNCO",
    "XETRA": "XETR",
    "ETR": "XETR",
    "GER": "XETR",
    "DE": "XETR",
    "NASDAQ": "XNAS",
    "NYSE": "XNYS",
    "NYSEARCA": "ARCX",
    "ARCA": "ARCX",
    "CBOE": "BATS",
    "AMEX": "XASE",
    "NYSEAMERICAN": "XASE",
    "NYSEMKT": "XASE",
    "IEX": "IEXG",
    "LSE": "XLON",
    "UK": "XLON",
    "L": "XLON",
    "ASX": "XASX",
    "AX": "XASX",
    "TSX": "XTSE",
    "TO": "XTSE",
    "TSXV": "XTSX",
    "V": "XTSX",
    "HKEX": "XHKG",
    "HK": "XHKG",
    "AEB": "XAMS",
    "NL": "XAMS",
    "AS": "XAMS",
    "FR": "XPAR",
    "PA": "XPAR",
    "BR": "XBRU",
    "IT": "XMIL",
    "MI": "XMIL",
    "BME": "XMAD",
    "ES": "XMAD",
    "MC": "XMAD",
    "SIX": "XSWX",
    "CH": "XSWX",
    "SW": "XSWX",
    "ST": "XSTO",
    "SE": "XSTO",
    "CO": "XCSE",
    "DK": "XCSE",
    "OL": "XOSL",
    "NO": "XOSL",
    "HE": "XHEL",
    "FI": "XHEL",
}

_SPECIAL: dict[str, ExchangeInfo] = {"US": US_LISTING, "CRYPTO": CRYPTO}


def exchange_for_mic(mic: str | None) -> ExchangeInfo | None:
    """The market of ``mic`` (case-insensitive), or None when unknown."""
    if mic is None:
        return None
    return MARKETS.get(mic.strip().upper())


def exchange_for_hint(hint: str | None) -> ExchangeInfo | None:
    """The market of ``hint`` (``GPW``, ``xwar``, ``.PL``, ``crypto``), or None when unknown or blank."""
    if hint is None:
        return None
    key = hint.strip().upper().removeprefix(".")
    if not key:
        return None
    if key in MARKETS:
        return MARKETS[key]
    if key in _SPECIAL:
        return _SPECIAL[key]
    mic = _ALIASES.get(key)
    return MARKETS[mic] if mic else None


@dataclass(frozen=True, slots=True)
class SplitSymbol:
    """A broker symbol split into the bare ticker and its market."""

    symbol: str
    exchange: ExchangeInfo | None


def split_broker_symbol(symbol: str, exchange_hint: str | None) -> SplitSymbol:
    """Split a broker symbol into ticker and market.

    Understood forms (case-insensitive market part): ``PKN.PL`` / ``VWCE.DE`` (suffix after a dot) and
    ``NVDA:xnas`` / ``CDR:XWAR`` (market after a colon). Without a hint ``PKN.PL`` becomes (``PKN``,
    Warsaw); ``PKN`` with hint ``GPW`` becomes (``PKN``, Warsaw). A suffix that is not a known market
    (``BRK.B``) stays part of the ticker, and so does a suffix naming another market than the hint.
    """
    trimmed = symbol.strip()
    from_hint = exchange_for_hint(exchange_hint)
    for separator in (":", "."):
        cut = trimmed.rfind(separator)
        if not 0 < cut < len(trimmed) - 1:
            continue
        from_suffix = exchange_for_hint(trimmed[cut + 1 :])
        if from_suffix is not None and (
            from_hint is None or from_hint.mic == from_suffix.mic or from_suffix.mic is None
        ):
            return SplitSymbol(trimmed[:cut].strip(), from_hint or from_suffix)
        if separator == ":":
            break  # a colon form names its market explicitly; never fall back to a dot suffix
    return SplitSymbol(trimmed, from_hint)


# Well-known crypto asset tickers (base symbols). A guess helper only: a broker alias or ISIN always
# wins in resolution.
CRYPTO_TICKERS: frozenset[str] = frozenset(
    {
        "BTC",
        "ETH",
        "SOL",
        "ADA",
        "XRP",
        "DOGE",
        "DOT",
        "LTC",
        "BCH",
        "BNB",
        "AVAX",
        "MATIC",
        "POL",
        "LINK",
        "XLM",
        "ATOM",
        "TRX",
        "ETC",
        "XMR",
        "UNI",
        "SHIB",
        "TON",
        "NEAR",
        "ALGO",
        "USDT",
        "USDC",
        "DAI",
    }
)

_CRYPTO_QUOTES = ("USDT", "USDC", "USD", "EUR", "PLN", "GBP", "CHF")


def crypto_base(symbol: str | None) -> str | None:
    """The crypto base ticker of ``symbol`` (``BTC``, ``btc-usd``, ``ETH/EUR``, ``BTCUSD``), or None
    when it does not look like a well-known crypto asset."""
    if symbol is None:
        return None
    text = symbol.strip().upper()
    if text in CRYPTO_TICKERS:
        return text
    for separator in ("-", "/"):
        if separator in text:
            base, _, quote = text.partition(separator)
            return base if base in CRYPTO_TICKERS and quote in _CRYPTO_QUOTES else None
    for quote in _CRYPTO_QUOTES:
        base = text.removesuffix(quote)
        if base != text and base in CRYPTO_TICKERS:
            return base
    return None


def is_crypto_symbol(symbol: str | None) -> bool:
    """True when ``symbol`` names a well-known crypto asset (see :func:`crypto_base`)."""
    return crypto_base(symbol) is not None


__all__ = [
    "CRYPTO",
    "CRYPTO_TICKERS",
    "MARKETS",
    "US_LISTING",
    "ExchangeInfo",
    "SplitSymbol",
    "crypto_base",
    "exchange_for_hint",
    "exchange_for_mic",
    "is_crypto_symbol",
    "split_broker_symbol",
]
