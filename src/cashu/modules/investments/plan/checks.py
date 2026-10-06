"""Recommendation checks: deterministic signals when the model recommendation and facts disagree. Pure: no IO,
no clock; the caller (``service.plans``) gathers the facts per held instrument and reconciles the
outcomes through the rule-signal lifecycle (``rules.reconcile_signals``).

=================  ======================================================  ========  ==========
check              fires when                                              severity  polarity
=================  ======================================================  ========  ==========
``plan_no_exit``   held AND (health fulfilled OR unrealized >=             info      negative
                   ``GAIN_REVIEW``) AND plan in {none, hold, buy,
                   buy_asap} AND no exit_plan in the thesis
``plan_vs_thesis`` plan in {buy, buy_asap} AND health weakened /           action if  negative
                   invalidated (held or watched, P2)                       invalidated
=================  ======================================================  ========  ==========

``plan_no_exit`` is skipped (never fired, an open signal left untouched) when its outcome depends on
the unrealized result and that is unknown or the price is stale. Neither check is a buy / sell call:
they point at the model output and the owner's thesis ("at +100 % check the exit plan").
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from ..domain import BUY_PLANS, HELD_ONLY_PLANS, PLAN_LABEL_HELD, SignalSeverity
from ..research.scoring import Health
from ..rules import (
    Fired,
    NotFired,
    RuleOutcome,
    RuleSpec,
    SignalCandidate,
    SignalPolarity,
    Skipped,
)
from .keys import plan_dedup_key, plan_rule_id

GAIN_REVIEW = 1.0
"""Unrealized result vs cost (fraction) from which a position needs an exit plan (+100 %)."""

PLAN_NO_EXIT = "plan_no_exit"
PLAN_VS_THESIS = "plan_vs_thesis"
CHECKS = (PLAN_NO_EXIT, PLAN_VS_THESIS)

HEALTH_LABEL = {Health.WEAKENED.value: "osłabiona", Health.INVALIDATED.value: "podważona"}
"""Polish labels of the thesis health states a ``plan_vs_thesis`` message names."""


@dataclass(frozen=True, slots=True)
class PlanFacts:
    """What the checks need about one held or watched instrument."""

    instrument_id: int
    label: str
    plan: str | None
    """The model recommendation (``domain.PLAN_VALUES``), None = no recommendation."""
    health: str
    """Thesis health as of the run (``research.scoring.Health`` value)."""
    has_exit_plan: bool
    """The thesis has a non-blank ``exit_plan``."""
    unrealized: float | None
    """Unrealized result vs cost as a fraction (1.0 = +100 %); None when unknown."""
    price_stale: bool = False
    """The price behind ``unrealized`` is stale or missing (the gain branch is then skipped)."""
    symbol: str | None = None
    held: bool = True
    """False for a watched instrument not held (P2): only ``plan_vs_thesis`` applies."""


def rule_specs() -> list[RuleSpec[object]]:
    """The lifecycle specs of both checks (so their open signals are never expired as unknown)."""
    return [
        RuleSpec(
            id=plan_rule_id(PLAN_NO_EXIT),
            kind=plan_rule_id(PLAN_NO_EXIT),
            params=None,
            severity=SignalSeverity.INFO,
            polarity=SignalPolarity.NEGATIVE,
        ),
        RuleSpec(
            id=plan_rule_id(PLAN_VS_THESIS),
            kind=plan_rule_id(PLAN_VS_THESIS),
            params=None,
            severity=SignalSeverity.INFO,
            polarity=SignalPolarity.NEGATIVE,
        ),
    ]


def _rounded(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def _payload(check: str, f: PlanFacts, **extra: object) -> dict[str, object]:
    return {
        "check": check,
        "plan": f.plan,
        "health": f.health,
        "has_exit_plan": f.has_exit_plan,
        "unrealized": _rounded(f.unrealized),
        "symbol": f.symbol,
        **extra,
    }


def _candidate(
    check: str, f: PlanFacts, severity: SignalSeverity, message: str, **extra: object
) -> Fired:
    return Fired(
        SignalCandidate(
            rule_id=plan_rule_id(check),
            kind=plan_rule_id(check),
            dedup_key=plan_dedup_key(check, f.instrument_id),
            severity=severity,
            message=message,
            instrument_id=str(f.instrument_id),
            payload=_payload(check, f, **extra),
            polarity=SignalPolarity.NEGATIVE,
        )
    )


def check_no_exit(f: PlanFacts) -> RuleOutcome:
    """``plan_no_exit``: a fulfilled thesis or +100 % from cost with no exit plan, while the plan is
    not already reduce / exit_asap. The fulfilled message wins when both hold."""
    rule_id = plan_rule_id(PLAN_NO_EXIT)
    key = plan_dedup_key(PLAN_NO_EXIT, f.instrument_id)
    if not f.held or f.plan in HELD_ONLY_PLANS or f.has_exit_plan:
        return NotFired(rule_id, key)
    if f.health == Health.FULFILLED.value:
        return _candidate(
            PLAN_NO_EXIT,
            f,
            SignalSeverity.INFO,
            "Teza spełniona, brak planu wyjścia",
            trigger="fulfilled",
        )
    if f.unrealized is None or f.price_stale:
        return Skipped(rule_id, f"Brak aktualnej ceny: {f.label}", key)
    if f.unrealized >= GAIN_REVIEW:
        return _candidate(
            PLAN_NO_EXIT,
            f,
            SignalSeverity.INFO,
            f"+{GAIN_REVIEW * 100:.0f} % od kosztu, brak planu wyjścia",
            trigger="gain",
            threshold=GAIN_REVIEW,
        )
    return NotFired(rule_id, key)


def plan_contradicts_thesis(plan: str | None, health: str) -> bool:
    """The ``plan_vs_thesis`` rule: a buy / buy_asap plan while the thesis is weakened or
    invalidated (the check and the P2 hint share it)."""
    return plan in BUY_PLANS and health in HEALTH_LABEL


def check_vs_thesis(f: PlanFacts) -> RuleOutcome:
    """``plan_vs_thesis``: the plan buys more while the thesis is weakened (info) or invalidated
    (action)."""
    rule_id = plan_rule_id(PLAN_VS_THESIS)
    key = plan_dedup_key(PLAN_VS_THESIS, f.instrument_id)
    if not plan_contradicts_thesis(f.plan, f.health):
        return NotFired(rule_id, key)
    severity = (
        SignalSeverity.ACTION if f.health == Health.INVALIDATED.value else SignalSeverity.INFO
    )
    message = f"Rekomendacja: {PLAN_LABEL_HELD[f.plan]}, teza {HEALTH_LABEL[f.health]}"
    return _candidate(PLAN_VS_THESIS, f, severity, message)


def evaluate(facts: Iterable[PlanFacts]) -> list[RuleOutcome]:
    """Both checks for every held or watched instrument, in input order."""
    out: list[RuleOutcome] = []
    for f in facts:
        out.append(check_no_exit(f))
        out.append(check_vs_thesis(f))
    return out
