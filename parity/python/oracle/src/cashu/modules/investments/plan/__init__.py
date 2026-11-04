"""Recommendation checks (P1): the model recommendation compared with the facts (thesis health,
exit plan, unrealized result), the strategy hints per instrument (P2, ``hints``) and the
recommendation's freshness (P3, ``freshness``). Pure; the service layer (``service.plans``,
``service.hints``) loads, reconciles and attaches."""

from .checks import (
    CHECKS,
    GAIN_REVIEW,
    PLAN_NO_EXIT,
    PLAN_VS_THESIS,
    PlanFacts,
    check_no_exit,
    check_vs_thesis,
    evaluate,
    rule_specs,
)
from .freshness import (
    PLAN_MAX_AGE_DAYS,
    Freshness,
    FreshnessFacts,
    FreshnessState,
    PlanAlert,
    PlanSignal,
    plan_freshness,
)
from .hints import (
    Hint,
    HintFacts,
    HintSeverity,
    OpenSignal,
    TriggeredAlert,
    instrument_hints,
)
from .keys import PLAN_PREFIX, is_plan_key, plan_dedup_key, plan_rule_id

__all__ = [
    "CHECKS",
    "GAIN_REVIEW",
    "PLAN_MAX_AGE_DAYS",
    "PLAN_NO_EXIT",
    "PLAN_PREFIX",
    "PLAN_VS_THESIS",
    "Freshness",
    "FreshnessFacts",
    "FreshnessState",
    "Hint",
    "HintFacts",
    "HintSeverity",
    "OpenSignal",
    "PlanAlert",
    "PlanFacts",
    "PlanSignal",
    "TriggeredAlert",
    "check_no_exit",
    "check_vs_thesis",
    "evaluate",
    "instrument_hints",
    "is_plan_key",
    "plan_dedup_key",
    "plan_freshness",
    "plan_rule_id",
    "rule_specs",
]
