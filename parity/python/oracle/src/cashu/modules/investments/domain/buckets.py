"""Allocation bucket contract shared by the strategy loader (builds it from ``strategy.yaml``) and the
portfolio math (``portfolio.allocation.allocate`` matches holdings against it). Plain data."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from .enums import AssetClass
from .values import Currency, InstrumentId

GENERIC_BUCKET_IDS: frozenset[str] = frozenset(
    {
        # every bucket id of the shipped strategy templates (templates/strategy/*.yaml)
        "global_equity",
        "bond_etfs",
        "treasury_bonds",
        "cash",
        "stocks",
        "bonds",
        # plain asset-class ids
        "equity",
        "equities",
        "fixed_income",
        "crypto",
        "real_estate",
        "reits",
        "commodities",
        "gold",
    }
)
"""Bucket ids the app may show as a generic, asset-class style allocation (F7 owner decision): the
template ids plus plain asset-class ids. Any other id is the owner's own bucket (``core``, ``active``,
...): knowledge for the agent (MCP, strategy files), never shown in the app. Case-sensitive, as written.
Here (not in ``strategy``) because the rule kinds need it and ``strategy`` imports the rules."""


def is_generic_bucket(bucket_id: object) -> bool:
    """True when ``bucket_id`` is one of :data:`GENERIC_BUCKET_IDS` (exact, case-sensitive match)."""
    return isinstance(bucket_id, str) and bucket_id in GENERIC_BUCKET_IDS


@dataclass(frozen=True, slots=True)
class BucketMatch:
    """Matching criteria of one bucket (``buckets[].match`` in ``strategy.yaml``).

    Every non-empty criterion must hold (AND). Within a criterion any element matches (OR), except
    ``tags``, where the instrument must carry all of them. An empty criterion matches anything. MICs and
    tags compare case-insensitively.
    """

    asset_classes: frozenset[AssetClass] = frozenset()
    tags: frozenset[str] = frozenset()
    """All of these tags must be present on the instrument."""
    mics: frozenset[str] = frozenset()
    currencies: frozenset[Currency] = frozenset()
    instrument_ids: frozenset[InstrumentId] = frozenset()
    """Explicit instrument pins, for one-off classification."""

    def __post_init__(self) -> None:
        for name in ("asset_classes", "tags", "mics", "currencies", "instrument_ids"):
            value = getattr(self, name)
            if not isinstance(value, frozenset):
                object.__setattr__(self, name, frozenset(value))

    @property
    def is_empty(self) -> bool:
        """True when no criterion is set (matches every instrument)."""
        return not (
            self.asset_classes or self.tags or self.mics or self.currencies or self.instrument_ids
        )


@dataclass(frozen=True, slots=True)
class BucketDef:
    """One allocation bucket. Buckets are evaluated in declaration order; the first match wins. Bucket ids
    are unique (the strategy loader rejects a duplicate id); express alternatives with list-valued match
    criteria instead."""

    id: str
    """Bucket id referenced by ``allocation.targets`` (``global_equity``)."""
    match: BucketMatch = field(default_factory=BucketMatch)


@dataclass(frozen=True, slots=True)
class AllocationPlan:
    """Buckets in declaration order plus target weights by bucket id (0..1, summing to 1)."""

    buckets: tuple[BucketDef, ...] = ()
    targets: Mapping[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.buckets, tuple):
            object.__setattr__(self, "buckets", tuple(self.buckets))
