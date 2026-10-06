"""Market data over HTTP (Yahoo, stooq, NBP): sources return data, nothing is persisted here.

``MarketDataRefresher.refresh`` plans an incremental refresh against a read-only ``StoredMarketData``
and returns a ``FetchReport`` carrying the bars and rates to store (``InMemoryMarketData.apply`` shows
the persistence semantics, incl. replacing the stored window after a split).
"""

from .composite import (
    CompositePriceSource,
    PriceSourceOrder,
    SourceHealth,
    default_price_source_order,
)
from .fetch_report import FetchReport, FetchStatus, FxFetch, InstrumentFetch
from .market_http import MarketHttp, body_snippet, exponential_backoff
from .nbp import NbpFxSource
from .refresh import InMemoryMarketData, MarketDataRefresher, StoredMarketData
from .sources import (
    FxSource,
    NoPriceSourceException,
    PriceHistory,
    PriceSource,
    QuoteCurrencyMismatchException,
    SourceBlockedException,
    SourceException,
    SplitEvent,
)
from .stooq import StooqPriceSource
from .yahoo import YahooPriceSource, exchange_date, utc_now

__all__ = [
    "CompositePriceSource",
    "FetchReport",
    "FetchStatus",
    "FxFetch",
    "FxSource",
    "InMemoryMarketData",
    "InstrumentFetch",
    "MarketDataRefresher",
    "MarketHttp",
    "NbpFxSource",
    "NoPriceSourceException",
    "PriceHistory",
    "PriceSource",
    "PriceSourceOrder",
    "QuoteCurrencyMismatchException",
    "SourceBlockedException",
    "SourceException",
    "SourceHealth",
    "SplitEvent",
    "StooqPriceSource",
    "StoredMarketData",
    "YahooPriceSource",
    "body_snippet",
    "default_price_source_order",
    "exchange_date",
    "exponential_backoff",
    "utc_now",
]
