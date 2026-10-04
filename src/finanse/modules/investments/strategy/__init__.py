"""strategy.yaml of a profile: schema v1 loader with located issues ("did you mean" hints), the typed
config the rules engine consumes, and access to the shipped templates."""

from __future__ import annotations

from .config import Benchmark, NotificationPolicy, StrategyConfig, WatchlistCriteria, Weekday
from .issues import IssueSeverity, StrategyIssue, StrategyLoadResult
from .loader import SUPPORTED_VERSIONS, TOP_LEVEL_KEYS, StrategyLoader, load_strategy
from .yaml_tree import MAX_STRATEGY_CHARS

__all__ = [
    "MAX_STRATEGY_CHARS",
    "SUPPORTED_VERSIONS",
    "TOP_LEVEL_KEYS",
    "Benchmark",
    "IssueSeverity",
    "NotificationPolicy",
    "StrategyConfig",
    "StrategyIssue",
    "StrategyLoadResult",
    "StrategyLoader",
    "WatchlistCriteria",
    "Weekday",
    "load_strategy",
]
