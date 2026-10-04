"""The parsed, validated strategy.yaml of one profile (built only by the loader, always valid)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum

from finanse.modules.investments.domain import AllocationPlan, Currency, SignalSeverity
from finanse.modules.investments.rules import (
    ContributionPlan,
    DataQualityPolicy,
    RebalancePolicy,
    RuleSpec,
)


class Weekday(StrEnum):
    MONDAY = "monday"
    TUESDAY = "tuesday"
    WEDNESDAY = "wednesday"
    THURSDAY = "thursday"
    FRIDAY = "friday"
    SATURDAY = "saturday"
    SUNDAY = "sunday"

    @property
    def iso_number(self) -> int:
        """ISO weekday number, Monday = 1 ... Sunday = 7 (``date.isoweekday()``)."""
        return list(Weekday).index(self) + 1


@dataclass(frozen=True, slots=True)
class WatchlistCriteria:
    """Screening thresholds from ``watchlist.criteria`` by YAML key (used by a later stage). Any numeric
    key is kept; ``KNOWN_KEYS`` only drive the typo hints."""

    values: Mapping[str, float] = field(default_factory=dict)

    KNOWN_KEYS = (
        "max_pe",
        "min_pe",
        "max_pb",
        "min_dividend_yield",
        "min_market_cap_pln",
        "min_roe",
        "max_debt_to_equity",
    )

    @property
    def is_empty(self) -> bool:
        return not self.values

    @property
    def max_pe(self) -> float | None:
        return self.values.get("max_pe")

    @property
    def min_dividend_yield(self) -> float | None:
        return self.values.get("min_dividend_yield")

    @property
    def min_market_cap_pln(self) -> float | None:
        return self.values.get("min_market_cap_pln")


@dataclass(frozen=True, slots=True)
class Benchmark:
    """``benchmark:`` - what the portfolio is compared with (parsed now, used by a later stage)."""

    id: str
    """Display id of the benchmark (``msci_acwi``)."""
    proxy: str
    """Instrument alias that tracks it: a Yahoo symbol (``VWCE.DE``) or an ISIN."""
    currency: Currency
    """Currency the comparison is made in (defaults to ``base_currency``)."""


@dataclass(frozen=True, slots=True)
class NotificationPolicy:
    """``notifications:`` - which severities notify immediately and the weekly digest day (parsed now,
    used by the worker later). Defaults: only ``action`` signals notify immediately, digest on Sunday."""

    immediate: frozenset[SignalSeverity] = frozenset({SignalSeverity.ACTION})
    digest_weekday: Weekday = Weekday.SUNDAY


@dataclass(frozen=True, slots=True)
class StrategyConfig:
    """A profile's strategy as the engine sees it."""

    version: int
    """``version:``, currently always 1."""
    base_currency: Currency
    allocation: AllocationPlan
    """``buckets`` (declaration order, first match wins) and ``allocation.targets`` (every bucket has a
    target; buckets without one in the YAML get 0 and a warning). Both empty without buckets."""
    horizon_years: int | None = None
    rebalance: RebalancePolicy = field(default_factory=RebalancePolicy)
    """``allocation.rebalance`` (defaults when absent); allocation_drift rules default to it."""
    data: DataQualityPolicy = field(default_factory=DataQualityPolicy)
    contributions: ContributionPlan | None = None
    rules: tuple[RuleSpec[object], ...] = ()
    """``rules:`` in declaration order."""
    watchlist: WatchlistCriteria = field(default_factory=WatchlistCriteria)
    benchmark: Benchmark | None = None
    notifications: NotificationPolicy = field(default_factory=NotificationPolicy)
    markdown: str | None = None
    """The strategy.md prose passed to the loader, if any."""

    def rule(self, rule_id: str) -> RuleSpec[object] | None:
        """The rule with ``rule_id``, or None."""
        return next((rule for rule in self.rules if rule.id == rule_id), None)
