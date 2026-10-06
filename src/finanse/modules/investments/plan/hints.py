"""Strategy hints per instrument (P2): which of the owner's own written rules apply right now.

Pure: no IO, no clock. The caller (``service.hints``) gathers the facts per instrument from stored
data (thesis health, the newest thesis, open signals, triggered alerts, the effective plan) and
attaches the hints to the views. A hint names the rule that applies and the review it asks for; it
is never a buy / sell call in the app's voice. Strategy-rule hints key on rule KINDS
(``gain_from_cost``, ...), never on the owner's rule ids (F7-generic).

Output: an ordered list of :class:`Hint` (``code``, ``severity``, ``params``); the first is the main
one. Severities: ``rule`` (an owner rule fired, action), ``review`` (a review is due), ``info``.
Params are fractions, flags and categories only (no amounts): the same in the app and in MCP.

Both tables start with the recommendation's freshness (P3, ``plan.freshness``), when it is not
fresh: ``recommendation_outdated`` (rule) or ``recommendation_maybe_outdated`` (review), params
``reasons`` (the freshness reason codes, in order).

Held instrument, in this order (every one that applies):

=====================  =================================================  ========  =======================
code                   when                                               severity  params
=====================  =================================================  ========  =======================
``recommendation_...`` the recommendation is outdated / maybe outdated    rule /    reasons
                                                                          review
``thesis_invalidated`` health invalidated                                 rule      predates_thesis
``plan_vs_thesis``     plan buy / buy_asap, health weakened / invalidated  rule      plan, health
                       (the P1 check's rule, from the live facts)
``thesis_fulfilled``   health fulfilled                                   review    has_exit_plan,
                                                                                    predates_thesis
``gain_review``        open signal of a ``gain_from_cost`` rule           review    gain, threshold,
                                                                                    has_exit_plan
``loss_review``        open signal of a ``loss_from_cost`` rule           review    loss, threshold
``drawdown_review``    open signal of a ``drawdown_from_high`` rule       review    drawdown, threshold
``concentration``      open signal of a ``position_concentration`` rule   review    weight, max_weight
``thesis_weakened``    health weakened                                    review    predates_thesis
``no_thesis``          no thesis record                                   review    -
``no_exit_plan``       thesis, blank exit_plan, no ``thesis_fulfilled`` /  info      -
                       ``gain_review`` hint
=====================  =================================================  ========  =======================

Watched (not held) instrument, in this order:

=======================  ===============================================  ========  ======================
``recommendation_...``   the recommendation is outdated / maybe outdated  rule /    reasons
                                                                          review
``alert_triggered``      a triggered alert on the instrument (one each)   review    alert_id, kind, title
``plan_vs_thesis``       plan buy / buy_asap, health weakened /           rule      plan, health
                         invalidated (the P1 check's rule, live facts)
``thesis_invalidated``   health invalidated                               rule      predates_thesis
``thesis_weakened``      health weakened                                  review    predates_thesis
``thesis_fulfilled``     health fulfilled                                 review    has_exit_plan,
                                                                                    predates_thesis
``plan_without_thesis``  plan buy / buy_asap, no thesis                   rule      plan
``no_thesis``            no thesis record (lowest)                        info      -
=======================  ===============================================  ========  ======================

Fractions: ``gain`` / ``loss`` / ``drawdown`` / ``weight`` / ``max_weight`` / ``threshold`` as in the
rules (0.27 = 27 %; ``loss`` and ``drawdown`` are positive magnitudes below cost / the high). Several
open signals of one kind (two gain rules) make one hint: the one with the highest threshold
(``max_weight`` for concentration: the highest crossed limit). The
alert ``title`` is the owner's text: the app shows it, MCP drops it (``kind`` stays). An instrument
research never covers (cash, an owner-named private position) and without a thesis gets no thesis
hints (``HintFacts.thesis_tracked``).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum

from ..domain import BUY_PLANS
from ..research.scoring import Health
from .checks import PLAN_VS_THESIS, plan_contradicts_thesis
from .freshness import Freshness, FreshnessState


class HintSeverity(StrEnum):
    RULE = "rule"
    REVIEW = "review"
    INFO = "info"


RECOMMENDATION_OUTDATED = "recommendation_outdated"
RECOMMENDATION_MAYBE_OUTDATED = "recommendation_maybe_outdated"
THESIS_INVALIDATED = "thesis_invalidated"
PLAN_VS_THESIS_HINT = PLAN_VS_THESIS
THESIS_FULFILLED = "thesis_fulfilled"
GAIN_REVIEW = "gain_review"
LOSS_REVIEW = "loss_review"
DRAWDOWN_REVIEW = "drawdown_review"
CONCENTRATION = "concentration"
THESIS_WEAKENED = "thesis_weakened"
NO_THESIS = "no_thesis"
NO_EXIT_PLAN = "no_exit_plan"
ALERT_TRIGGERED = "alert_triggered"
PLAN_WITHOUT_THESIS = "plan_without_thesis"

HELD_ORDER = (
    RECOMMENDATION_OUTDATED,
    RECOMMENDATION_MAYBE_OUTDATED,
    THESIS_INVALIDATED,
    PLAN_VS_THESIS_HINT,
    THESIS_FULFILLED,
    GAIN_REVIEW,
    LOSS_REVIEW,
    DRAWDOWN_REVIEW,
    CONCENTRATION,
    THESIS_WEAKENED,
    NO_THESIS,
    NO_EXIT_PLAN,
)
WATCHED_ORDER = (
    RECOMMENDATION_OUTDATED,
    RECOMMENDATION_MAYBE_OUTDATED,
    ALERT_TRIGGERED,
    PLAN_VS_THESIS_HINT,
    THESIS_INVALIDATED,
    THESIS_WEAKENED,
    THESIS_FULFILLED,
    PLAN_WITHOUT_THESIS,
    NO_THESIS,
)
CODES = tuple(dict.fromkeys(HELD_ORDER + WATCHED_ORDER))

RULE_KIND_HINTS = {
    "gain_from_cost": GAIN_REVIEW,
    "loss_from_cost": LOSS_REVIEW,
    "drawdown_from_high": DRAWDOWN_REVIEW,
    "position_concentration": CONCENTRATION,
}
"""Strategy rule kinds whose open signals become held hints (keyed on the kind, never the id)."""


@dataclass(frozen=True, slots=True)
class OpenSignal:
    """An open signal of the instrument: its kind (rule kind / ``plan:...`` / ``alert:...``) and
    payload."""

    kind: str
    payload: Mapping[str, object] = field(default_factory=dict)
    severity: str | None = None


@dataclass(frozen=True, slots=True)
class TriggeredAlert:
    alert_id: int
    kind: str
    title: str | None = None


@dataclass(frozen=True, slots=True)
class HintFacts:
    """What the hints need about one instrument."""

    held: bool
    health: str
    """Thesis health now (``research.scoring.Health`` value)."""
    has_thesis: bool
    has_exit_plan: bool = False
    plan: str | None = None
    """The effective plan (P1: a stale held-only plan is None)."""
    predates_thesis: bool = False
    """The health state rests on research stored before the thesis' last core change."""
    signals: tuple[OpenSignal, ...] = ()
    alerts: tuple[TriggeredAlert, ...] = ()
    weight: float | None = None
    """The instrument's weight (fraction): the concentration hint's fallback."""
    thesis_tracked: bool = True
    """False for an instrument research never covers (cash, an owner-named private position) with
    no thesis: the thesis hints (``thesis_*``, ``no_thesis``, ``no_exit_plan``,
    ``plan_without_thesis``) are left out, the rule and alert hints stay."""
    freshness: Freshness | None = None
    """The recommendation's freshness (P3; None: no recommendation)."""


@dataclass(frozen=True, slots=True)
class Hint:
    code: str
    severity: HintSeverity
    params: Mapping[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"code": self.code, "severity": self.severity.value, "params": dict(self.params)}


def _number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return round(float(value), 4)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


_LIMIT_KEY = {"position_concentration": "max_weight"}
"""The payload key of a rule kind's crossed limit (default ``threshold``)."""


def _strongest(signals: Iterable[OpenSignal], kind: str) -> OpenSignal | None:
    """The open signal of ``kind`` with the highest crossed limit (the strongest crossing; ties
    keep the first)."""
    found = [s for s in signals if s.kind == kind]
    if not found:
        return None
    key = _LIMIT_KEY.get(kind, "threshold")
    return max(found, key=lambda s: _number(s.payload.get(key)) or 0.0)


def _rule_hint(kind: str, s: OpenSignal, f: HintFacts) -> Hint:
    p = s.payload
    threshold = _number(p.get("threshold"))
    if kind == "gain_from_cost":
        params = {
            "gain": _number(p.get("unrealized_pct")),
            "threshold": threshold,
            "has_exit_plan": f.has_exit_plan,
        }
    elif kind == "loss_from_cost":
        loss = _number(p.get("unrealized_pct"))
        params = {"loss": None if loss is None else abs(loss), "threshold": threshold}
    elif kind == "drawdown_from_high":
        params = {"drawdown": _number(p.get("drawdown")), "threshold": threshold}
    else:  # position_concentration
        weight = _number(p.get("weight"))
        params = {
            "weight": weight if weight is not None else _number(f.weight),
            "max_weight": _number(p.get("max_weight")),
        }
    return Hint(RULE_KIND_HINTS[kind], HintSeverity.REVIEW, params)


def _plan_vs_thesis(f: HintFacts) -> Hint | None:
    """From the live facts (not the ``plan:plan_vs_thesis`` signal, which follows them only at the
    next sync), so it always agrees with the thesis hints and the freshness."""
    if not plan_contradicts_thesis(f.plan, f.health):
        return None
    return Hint(PLAN_VS_THESIS_HINT, HintSeverity.RULE, {"plan": f.plan, "health": f.health})


def _thesis_state(f: HintFacts) -> Hint | None:
    tagged = {"predates_thesis": f.predates_thesis}
    if f.health == Health.INVALIDATED.value:
        return Hint(THESIS_INVALIDATED, HintSeverity.RULE, tagged)
    if f.health == Health.WEAKENED.value:
        return Hint(THESIS_WEAKENED, HintSeverity.REVIEW, tagged)
    if f.health == Health.FULFILLED.value:
        return Hint(
            THESIS_FULFILLED, HintSeverity.REVIEW, {"has_exit_plan": f.has_exit_plan, **tagged}
        )
    return None


def _freshness(f: HintFacts) -> list[Hint]:
    fresh = f.freshness
    if fresh is None or fresh.state == FreshnessState.FRESH:
        return []
    if fresh.state == FreshnessState.OUTDATED:
        return [Hint(RECOMMENDATION_OUTDATED, HintSeverity.RULE, {"reasons": fresh.codes})]
    return [Hint(RECOMMENDATION_MAYBE_OUTDATED, HintSeverity.REVIEW, {"reasons": fresh.codes})]


def _ordered(found: list[Hint], order: tuple[str, ...]) -> list[Hint]:
    rank = {code: i for i, code in enumerate(order)}
    return sorted(found, key=lambda h: rank[h.code])  # stable: alerts keep their input order


def held_hints(f: HintFacts) -> list[Hint]:
    found: list[Hint] = _freshness(f)
    state = _thesis_state(f)
    if state is not None:
        found.append(state)
    vs = _plan_vs_thesis(f)
    if vs is not None:
        found.append(vs)
    for kind in RULE_KIND_HINTS:
        s = _strongest(f.signals, kind)
        if s is not None:
            found.append(_rule_hint(kind, s, f))
    if not f.has_thesis:
        found.append(Hint(NO_THESIS, HintSeverity.REVIEW))
    elif not f.has_exit_plan and not any(h.code in (THESIS_FULFILLED, GAIN_REVIEW) for h in found):
        found.append(Hint(NO_EXIT_PLAN, HintSeverity.INFO))
    return _ordered(found, HELD_ORDER)


def watched_hints(f: HintFacts) -> list[Hint]:
    found: list[Hint] = [
        Hint(
            ALERT_TRIGGERED,
            HintSeverity.REVIEW,
            {"alert_id": a.alert_id, "kind": a.kind, "title": a.title},
        )
        for a in sorted(f.alerts, key=lambda a: a.alert_id)
    ]
    found.extend(_freshness(f))
    vs = _plan_vs_thesis(f)
    if vs is not None:
        found.append(vs)
    state = _thesis_state(f)
    if state is not None:
        found.append(state)
    if not f.has_thesis:
        if f.plan in BUY_PLANS:
            found.append(Hint(PLAN_WITHOUT_THESIS, HintSeverity.RULE, {"plan": f.plan}))
        found.append(Hint(NO_THESIS, HintSeverity.INFO))
    return _ordered(found, WATCHED_ORDER)


_THESIS_CODES = frozenset(
    {
        THESIS_INVALIDATED,
        THESIS_WEAKENED,
        THESIS_FULFILLED,
        NO_THESIS,
        NO_EXIT_PLAN,
        PLAN_WITHOUT_THESIS,
    }
)


def instrument_hints(f: HintFacts) -> list[Hint]:
    """The hints of one instrument, main first (held or watched table by ``f.held``)."""
    found = held_hints(f) if f.held else watched_hints(f)
    if f.thesis_tracked or f.has_thesis:
        return found
    return [h for h in found if h.code not in _THESIS_CODES]
