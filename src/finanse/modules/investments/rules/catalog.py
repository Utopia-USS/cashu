"""The catalog of rule kinds the strategy loader accepts and the engine evaluates."""

from __future__ import annotations

from collections.abc import Iterator

from .kind import RuleKind
from .kinds import (
    AllocationDriftRule,
    CashLevelRule,
    ContributionGapRule,
    CustomRule,
    DrawdownFromHighRule,
    GainFromCostRule,
    LossFromCostRule,
    PositionConcentrationRule,
    TaggedWeightRule,
)

BUILT_IN_KINDS = (
    "allocation_drift",
    "position_concentration",
    "loss_from_cost",
    "gain_from_cost",
    "drawdown_from_high",
    "cash_level",
    "contribution_gap",
    "tagged_weight",
    "custom",
)


class RuleCatalog:
    """Rule kinds by their ``kind:`` name, in registration order."""

    def __init__(self) -> None:
        self._kinds: dict[str, RuleKind[object]] = {}

    @staticmethod
    def built_in() -> RuleCatalog:
        """The built-in kinds (see ``BUILT_IN_KINDS``)."""
        catalog = RuleCatalog()
        for kind in (
            AllocationDriftRule(),
            PositionConcentrationRule(),
            LossFromCostRule(),
            GainFromCostRule(),
            DrawdownFromHighRule(),
            CashLevelRule(),
            ContributionGapRule(),
            TaggedWeightRule(),
            CustomRule(),
        ):
            catalog.register(kind)
        return catalog

    def register(self, kind: RuleKind[object]) -> None:
        """Adds ``kind``; raises ``ValueError`` when its name is already registered."""
        if kind.kind in self._kinds:
            raise ValueError(f"Rule kind {kind.kind!r} is already registered")
        self._kinds[kind.kind] = kind

    @property
    def kinds(self) -> tuple[str, ...]:
        """Registered kind names, in registration order."""
        return tuple(self._kinds)

    def get(self, kind: str) -> RuleKind[object] | None:
        return self._kinds.get(kind)

    def __contains__(self, kind: object) -> bool:
        return kind in self._kinds

    def __iter__(self) -> Iterator[RuleKind[object]]:
        return iter(self._kinds.values())
