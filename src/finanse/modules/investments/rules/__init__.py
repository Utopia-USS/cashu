"""Investments rules engine: a fixed, typed catalog of rule kinds (plus ``custom`` rules in a safe
expression language), a pure engine and a pure signal lifecycle. No IO anywhere in this package.

Usage: ``RulesEngine(config.rules).evaluate(RuleContext.build(...))`` -> outcomes;
``reconcile_signals(open_signals=..., outcomes=..., rules=config.rules, clock=...)`` -> actions.
"""

from __future__ import annotations

from .catalog import BUILT_IN_KINDS, RuleCatalog
from .engine import RulesEngine
from .hints import closest_match, did_you_mean
from .kind import ContributionPlan, DataQualityPolicy, RuleContext, RuleKind, RuleSpec
from .kinds import (
    AllocationDriftParams,
    AllocationDriftRule,
    CashLevelParams,
    CashLevelRule,
    ContributionGapParams,
    ContributionGapRule,
    CustomParams,
    CustomRule,
    DrawdownFromHighParams,
    DrawdownFromHighRule,
    GainFromCostRule,
    InstrumentFilter,
    LossFromCostRule,
    PositionConcentrationParams,
    PositionConcentrationRule,
    RebalancePolicy,
    TaggedWeightParams,
    TaggedWeightRule,
    UnrealizedThresholdParams,
)
from .lifecycle import (
    UNVERIFIED,
    ClosedSignal,
    CreateSignal,
    EscalateSignal,
    ExpireSignal,
    OpenSignal,
    RefreshSignal,
    ResolveSignal,
    SignalAction,
    SignalReconciliation,
    SuppressCandidate,
    reconcile_signals,
)
from .outcomes import (
    Fired,
    NotFired,
    RuleOutcome,
    SignalCandidate,
    Skipped,
    outcome_scope,
    signal_dedup_key,
)
from .params import ParamErrors, ParamIssue, ParamReader
from .polarity import SignalPolarity, default_polarity, polarity_rank

__all__ = [
    "BUILT_IN_KINDS",
    "UNVERIFIED",
    "AllocationDriftParams",
    "AllocationDriftRule",
    "CashLevelParams",
    "CashLevelRule",
    "ClosedSignal",
    "ContributionGapParams",
    "ContributionGapRule",
    "ContributionPlan",
    "CreateSignal",
    "CustomParams",
    "CustomRule",
    "DataQualityPolicy",
    "DrawdownFromHighParams",
    "DrawdownFromHighRule",
    "EscalateSignal",
    "ExpireSignal",
    "Fired",
    "GainFromCostRule",
    "InstrumentFilter",
    "LossFromCostRule",
    "NotFired",
    "OpenSignal",
    "ParamErrors",
    "ParamIssue",
    "ParamReader",
    "PositionConcentrationParams",
    "PositionConcentrationRule",
    "RebalancePolicy",
    "RefreshSignal",
    "ResolveSignal",
    "RuleCatalog",
    "RuleContext",
    "RuleKind",
    "RuleOutcome",
    "RuleSpec",
    "RulesEngine",
    "SignalAction",
    "SignalCandidate",
    "SignalPolarity",
    "SignalReconciliation",
    "Skipped",
    "SuppressCandidate",
    "TaggedWeightParams",
    "TaggedWeightRule",
    "UnrealizedThresholdParams",
    "closest_match",
    "default_polarity",
    "did_you_mean",
    "outcome_scope",
    "polarity_rank",
    "reconcile_signals",
    "signal_dedup_key",
]
