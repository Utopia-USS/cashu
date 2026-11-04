"""Portfolio math (pure functions, no IO): FIFO lots, snapshot, FX lookup, valuation, allocation.

Pipeline: ``build_snapshot`` -> ``value_portfolio`` (with a ``MarketView`` and an ``FxLookup``) ->
``allocate`` (with an ``AllocationPlan`` from the strategy loader).
"""

from .allocation import allocate, matches_bucket, matches_cash_bucket
from .fx_lookup import InMemoryFxLookup, convert, fx_currencies_for
from .last_trade_prices import SPLIT_DEDUP_WINDOW_DAYS, last_trade_prices
from .lot_engine import SPLIT_REMAINDER_TOLERANCE, LotEngineResult, run_lots
from .snapshot_builder import build_snapshot, restrict_snapshot
from .split_ratio import split_fraction
from .valuation import effective_valuation_mode, value_portfolio

__all__ = [
    "SPLIT_DEDUP_WINDOW_DAYS",
    "SPLIT_REMAINDER_TOLERANCE",
    "InMemoryFxLookup",
    "LotEngineResult",
    "allocate",
    "build_snapshot",
    "convert",
    "effective_valuation_mode",
    "fx_currencies_for",
    "last_trade_prices",
    "matches_bucket",
    "matches_cash_bucket",
    "restrict_snapshot",
    "run_lots",
    "split_fraction",
    "value_portfolio",
]
