"""Contract of the rules engine: the RuleKind protocol, configured rule specs, the evaluation context and
the strategy policies the rules read. Rule evaluation is pure: no IO, no clock, deterministic messages."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from cashu.modules.investments.domain import (
    DEFAULT_MAX_FX_AGE_DAYS,
    AllocationResult,
    BucketAllocation,
    CalendarDate,
    MarketView,
    ProfileId,
    SignalSeverity,
    ValuedHolding,
    ValuedPortfolio,
)

from .outcomes import RuleOutcome
from .params import ParamErrors
from .polarity import SignalPolarity


@dataclass(frozen=True, slots=True)
class RuleSpec[P]:
    """A configured rule from ``strategy.yaml`` with parsed params."""

    id: str
    """Unique rule id within the strategy (``dip_review``)."""
    kind: str
    params: P
    severity: SignalSeverity = SignalSeverity.INFO
    """Severity of signals this rule fires (YAML ``severity``, default info)."""
    cooldown_days: int | None = None
    """YAML ``cooldown_days``: a resolved signal of the same key does not come back within this many
    days."""
    polarity: SignalPolarity | None = None
    """YAML ``polarity``: overrides the kind's ``DEFAULT_POLARITY`` for the signals this rule fires
    (None = the kind's default)."""


class RuleKind[P](Protocol):
    """One kind of rule from the fixed catalog (``allocation_drift``, ``custom``...) with typed params.

    A kind may declare a class attribute ``DEFAULT_POLARITY`` (:class:`SignalPolarity`, neutral when
    absent): the polarity of its signals unless the rule sets ``polarity:``."""

    @property
    def kind(self) -> str:
        """The ``kind:`` value in strategy.yaml."""
        ...

    @property
    def params_type(self) -> type:
        """Runtime type of the parsed params (the engine refuses specs with other params)."""
        ...

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> P:
        """Validates and converts the rule's raw ``params:`` map. Problems go to ``errors``; when any
        error was recorded the returned value is discarded, so return something with fallback values."""
        ...

    def evaluate(self, ctx: RuleContext, spec: RuleSpec[P]) -> list[RuleOutcome]:
        """One outcome per checked scope. Never fires on stale or missing data: Skipped with a reason."""
        ...


DEFAULT_MAX_UNVERIFIED_DAYS = 14
MAX_UNVERIFIED_DAYS = 3650


@dataclass(frozen=True, slots=True)
class DataQualityPolicy:
    """Data-quality thresholds from the strategy's ``data:`` section (every key optional)."""

    max_price_age_days: int = 5
    """A price older than this many calendar days (relative to as_of) is stale."""
    max_stale_weight: float = 0.05
    """Portfolio-weight rules skip when the stale-priced share of the portfolio exceeds this (0..1)."""
    max_unclassified_weight: float = 0.02
    """allocation_drift (and tagged_weight) skip while holdings that match no bucket exceed this share."""
    max_fx_age_days: int = DEFAULT_MAX_FX_AGE_DAYS
    """An FX rate older than this many days relative to the date it is needed for counts as missing."""
    max_unverified_days: int | None = DEFAULT_MAX_UNVERIFIED_DAYS
    """An open rule or alert signal no run confirmed (its check skipped) for more than this many days
    closes as expired (``closed_reason`` ``unverified``); None (YAML ``null``) = never."""

    KEYS = (
        "max_price_age_days",
        "max_stale_weight",
        "max_unclassified_weight",
        "max_fx_age_days",
        "max_unverified_days",
    )


@dataclass(frozen=True, slots=True)
class ContributionPlan:
    """Planned contributions from the strategy's ``contributions:`` section."""

    monthly_amount: Decimal
    """Planned deposit per month in the base currency."""
    day_of_month: int | None = None


@dataclass(frozen=True, slots=True)
class RuleContext:
    """Everything a rule may look at, for one profile as of one date. Built by the daily run."""

    profile_id: ProfileId
    as_of: CalendarDate
    portfolio: ValuedPortfolio
    """Valued portfolio (holdings with instrument metadata, cash, deposits via ``portfolio.snapshot``)."""
    market: MarketView
    """Instrument metadata and price series up to ``as_of``."""
    allocations: tuple[BucketAllocation, ...] = ()
    """Bucket allocations computed from the strategy's buckets and targets."""
    unclassified: tuple[ValuedHolding, ...] = ()
    """Holdings that match no bucket (``AllocationResult.unclassified``)."""
    data: DataQualityPolicy = DataQualityPolicy()
    contributions: ContributionPlan | None = None
    """None when the strategy has no ``contributions:`` section."""

    def __post_init__(self) -> None:
        for name in ("allocations", "unclassified"):
            value = getattr(self, name)
            if not isinstance(value, tuple):
                object.__setattr__(self, name, tuple(value))

    @staticmethod
    def build(
        *,
        profile_id: ProfileId,
        as_of: CalendarDate,
        portfolio: ValuedPortfolio,
        market: MarketView,
        allocation: AllocationResult | None = None,
        data: DataQualityPolicy | None = None,
        contributions: ContributionPlan | None = None,
    ) -> RuleContext:
        """Context from the pipeline outputs (``allocate`` result optional when there are no buckets)."""
        return RuleContext(
            profile_id=profile_id,
            as_of=as_of,
            portfolio=portfolio,
            market=market,
            allocations=allocation.allocations if allocation is not None else (),
            unclassified=allocation.unclassified if allocation is not None else (),
            data=data or DataQualityPolicy(),
            contributions=contributions,
        )


RuleSpecs = Sequence[RuleSpec[object]]
