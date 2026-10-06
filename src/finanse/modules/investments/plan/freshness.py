"""Freshness of the model recommendation (P3): is the recommendation on an instrument (``plan``,
written at ``plan_at``) possibly or definitely outdated by data stored after it?

Pure: no IO, no clock (the caller passes ``now``). Deterministic, from stored data only; it never
changes the recommendation. The caller (``service.hints``) gathers the facts per instrument and
attaches ``plan_freshness: {state, reasons}`` next to ``plan`` (positions rows, watchlist rows, the
asset detail); the P2 hints lead with ``recommendation_outdated`` / ``recommendation_maybe_outdated``.

``state``: ``fresh`` | ``maybe_outdated`` (yellow) | ``outdated`` (red). No plan: no freshness (None).
"After the recommendation" is strictly after ``plan_at`` (the boundary itself is not after).

``outdated`` when any of:

======================  ======================================================================
``note_invalidates``    a stored, non-dismissed note relating ``invalidates`` stored after plan_at
``thesis_invalidated``  thesis health invalidated now and the plan is not reduce / exit_asap (left
                        out when ``note_invalidates`` already explains it)
``fulfilled_buy``       a stored, non-dismissed ``fulfills`` note after plan_at, plan buy / buy_asap
======================  ======================================================================

``maybe_outdated`` (not outdated) when any of:

===================  =========================================================================
``note_after``       a stored, non-dismissed, non-expired note after plan_at relating ``weakens``
                     or ``fulfills``, or ``supports`` with strength >= 2, or any note with strength
                     3 (a note already counted by an outdated reason is not repeated)
``thesis_changed``   the thesis' last core change (``core_changed_at``) after plan_at
``rule_fired``       an open signal of a strategy rule kind (``STRATEGY_RULE_KINDS``) first seen
                     after plan_at (one reason per kind, the newest)
``alert_triggered``  an alert of the instrument triggered after plan_at (one reason per alert)
``age``              plan_at more than ``PLAN_MAX_AGE_DAYS`` days before now
===================  =========================================================================

Notes: dismissed notes never count, expired ones do not count for ``note_after``; candidate notes
(strategy matches) never count and community notes count with strength 1 (as in thesis health).

``reasons``: every reason that applies, outdated codes first, in the tables' order; within a code
the newest first. A reason: ``code``, ``at`` (when it happened: the note / signal / alert / thesis
change, for ``age`` the moment the plan turned ``PLAN_MAX_AGE_DAYS`` old) and, when they apply,
``note_id`` + ``relation`` + ``count`` (note reasons: the newest note and how many qualify),
``signal_id`` + ``kind`` (rule kind), ``alert_id`` + ``kind`` (alert kind). Keys on rule KINDS,
never on the owner's rule ids (F7-generic).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import StrEnum

from ..domain import BUY_PLANS, HELD_ONLY_PLANS
from ..research.scoring import CANDIDATE_KIND, Health, ScoredNote, note_weight, window_notes

PLAN_MAX_AGE_DAYS = 30
"""A recommendation older than this many days may be outdated (``age``)."""

STRATEGY_RULE_KINDS = (
    "gain_from_cost",
    "loss_from_cost",
    "drawdown_from_high",
    "position_concentration",
)
"""Strategy rule kinds whose open signals put a recommendation in question (``rule_fired``)."""


class FreshnessState(StrEnum):
    FRESH = "fresh"
    MAYBE_OUTDATED = "maybe_outdated"
    OUTDATED = "outdated"


NOTE_INVALIDATES = "note_invalidates"
THESIS_INVALIDATED = "thesis_invalidated"
FULFILLED_BUY = "fulfilled_buy"
NOTE_AFTER = "note_after"
THESIS_CHANGED = "thesis_changed"
RULE_FIRED = "rule_fired"
ALERT_TRIGGERED = "alert_triggered"
AGE = "age"

OUTDATED_CODES = (NOTE_INVALIDATES, THESIS_INVALIDATED, FULFILLED_BUY)
MAYBE_CODES = (NOTE_AFTER, THESIS_CHANGED, RULE_FIRED, ALERT_TRIGGERED, AGE)
REASON_ORDER = OUTDATED_CODES + MAYBE_CODES


@dataclass(frozen=True, slots=True)
class PlanSignal:
    """An open signal of the instrument (``kind``: the rule kind / ``plan:...`` / ``alert:...``)."""

    signal_id: int
    kind: str
    first_seen_at: dt.datetime


@dataclass(frozen=True, slots=True)
class PlanAlert:
    """An alert of the instrument that has triggered (its last trigger)."""

    alert_id: int
    kind: str
    triggered_at: dt.datetime


@dataclass(frozen=True, slots=True)
class FreshnessFacts:
    """What freshness needs about one instrument (aware UTC datetimes)."""

    plan: str | None
    """The effective plan (P1: a stale held-only plan is None)."""
    plan_at: dt.datetime | None
    health: str = Health.NO_THESIS.value
    """Thesis health now (``research.scoring.Health`` value)."""
    notes: tuple[ScoredNote, ...] = ()
    """The instrument's notes stored after ``plan_at`` and those of the health window (more is fine:
    every rule filters)."""
    core_changed_at: dt.datetime | None = None
    """The newest thesis' last core change (None: no thesis)."""
    signals: tuple[PlanSignal, ...] = ()
    """The instrument's open signals."""
    alerts: tuple[PlanAlert, ...] = ()
    """The instrument's alerts that have triggered (any status, not deleted)."""


@dataclass(frozen=True, slots=True)
class Reason:
    code: str
    at: dt.datetime | None
    note_id: int | None = None
    signal_id: int | None = None
    alert_id: int | None = None
    kind: str | None = None
    relation: str | None = None
    count: int | None = None

    def to_dict(self, fmt: Callable[[dt.datetime | None], str | None]) -> dict:
        out: dict = {"code": self.code, "at": fmt(self.at)}
        for key in ("note_id", "signal_id", "alert_id", "kind", "relation", "count"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out


@dataclass(frozen=True, slots=True)
class Freshness:
    state: FreshnessState
    reasons: tuple[Reason, ...] = ()

    @property
    def codes(self) -> list[str]:
        """The distinct reason codes, in order."""
        return list(dict.fromkeys(r.code for r in self.reasons))

    def to_dict(self, fmt: Callable[[dt.datetime | None], str | None] | None = None) -> dict:
        fmt = fmt or _isoformat
        return {"state": self.state.value, "reasons": [r.to_dict(fmt) for r in self.reasons]}


def _isoformat(value: dt.datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _newest_note(code: str, notes: list[ScoredNote]) -> Reason | None:
    if not notes:
        return None
    newest = max(notes, key=lambda n: (n.created_at, n.id))
    return Reason(
        code,
        newest.created_at,
        note_id=newest.id,
        relation=newest.thesis_relation,
        count=len(notes),
    )


def _note_after(note: ScoredNote) -> bool:
    weight = note_weight(note.kind, note.strength)
    relation = note.thesis_relation
    return (
        relation in ("weakens", "fulfills")
        or (relation == "supports" and weight >= 2)
        or weight >= 3
    )


def _ordered(reasons: Iterable[Reason]) -> tuple[Reason, ...]:
    rank = {code: i for i, code in enumerate(REASON_ORDER)}
    floor = dt.datetime.min.replace(tzinfo=dt.UTC)
    by_time = sorted(reasons, key=lambda r: r.at or floor, reverse=True)
    return tuple(sorted(by_time, key=lambda r: rank[r.code]))  # stable: newest first per code


def plan_freshness(f: FreshnessFacts, now: dt.datetime) -> Freshness | None:
    """The freshness of ``f.plan`` at ``now``; None without a plan (or its date)."""
    if f.plan is None or f.plan_at is None:
        return None
    plan_at = f.plan_at
    reasons: list[Reason] = []

    stored = [
        n
        for n in f.notes
        if n.kind != CANDIDATE_KIND and n.stored_at(now) and n.created_at > plan_at
    ]
    invalidating = [n for n in stored if n.thesis_relation == "invalidates"]
    fulfilling = (
        [n for n in stored if n.thesis_relation == "fulfills"] if f.plan in BUY_PLANS else []
    )
    for code, notes in ((NOTE_INVALIDATES, invalidating), (FULFILLED_BUY, fulfilling)):
        reason = _newest_note(code, notes)
        if reason is not None:
            reasons.append(reason)
    if not invalidating and f.health == Health.INVALIDATED.value and f.plan not in HELD_ONLY_PLANS:
        window = [n for n in window_notes(f.notes, now) if n.thesis_relation == "invalidates"]
        newest = max(window, key=lambda n: (n.created_at, n.id), default=None)
        reasons.append(
            Reason(
                THESIS_INVALIDATED,
                None if newest is None else newest.created_at,
                note_id=None if newest is None else newest.id,
            )
        )

    counted = {n.id for n in invalidating} | {n.id for n in fulfilling}
    after = [n for n in stored if n.id not in counted and n.active_at(now) and _note_after(n)]
    reason = _newest_note(NOTE_AFTER, after)
    if reason is not None:
        reasons.append(reason)
    if f.core_changed_at is not None and f.core_changed_at > plan_at:
        reasons.append(Reason(THESIS_CHANGED, f.core_changed_at))
    for kind in STRATEGY_RULE_KINDS:
        fired = [s for s in f.signals if s.kind == kind and s.first_seen_at > plan_at]
        if fired:
            newest = max(fired, key=lambda s: (s.first_seen_at, s.signal_id))
            reasons.append(
                Reason(RULE_FIRED, newest.first_seen_at, signal_id=newest.signal_id, kind=kind)
            )
    for a in f.alerts:
        if a.triggered_at > plan_at:
            reasons.append(
                Reason(ALERT_TRIGGERED, a.triggered_at, alert_id=a.alert_id, kind=a.kind)
            )
    aged_at = plan_at + dt.timedelta(days=PLAN_MAX_AGE_DAYS)
    if now > aged_at:
        reasons.append(Reason(AGE, aged_at))

    ordered = _ordered(reasons)
    if any(r.code in OUTDATED_CODES for r in ordered):
        state = FreshnessState.OUTDATED
    elif ordered:
        state = FreshnessState.MAYBE_OUTDATED
    else:
        state = FreshnessState.FRESH
    return Freshness(state, ordered)
