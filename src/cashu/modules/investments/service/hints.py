"""Strategy hints on the views (P2) and the recommendation's freshness (P3): the facts per instrument
from stored data, the pure hints (``plan.hints``) attached as ``hints: [{code, severity, params}]``
and the pure freshness (``plan.freshness``) as ``plan_freshness: {state, reasons}`` (next to ``plan``)
to positions rows, watchlist rows and the asset detail. Computed on read (no table); one thesis-health
map and one note query per request.

Facts: thesis health now (``research.views.health_by_instrument``, the summary's computation, with
``predates_thesis``), the newest thesis (present, non-blank ``exit_plan``), the instrument's open
signals (rule kind + payload; strategy rules, plan checks), its triggered alerts, the effective plan
(the caller's ``instrument_dict`` value) and its weight. Freshness adds the plan's date, the notes
stored after it (and the health window's), the thesis' last core change, the open signals' first
sighting and the instrument's alerts that have triggered (any status, not deleted).
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from sqlmodel import Session, col, or_, select

from cashu.core.models import utcnow

from ..domain import Instrument
from ..models import InvAlert, InvResearchNote, InvSignal
from ..plan.freshness import FreshnessFacts, PlanAlert, PlanSignal, plan_freshness
from ..plan.hints import HintFacts, OpenSignal, TriggeredAlert, instrument_hints
from ..research import service as research_service
from ..research import views as research_views
from ..research.scoring import CANDIDATE_KIND, HEALTH_WINDOW_DAYS, ScoredNote
from ..store import alerts as alert_store
from ..store import convert, signals

TRIGGERED = "triggered"


@dataclass(frozen=True, slots=True)
class Subject:
    """One instrument a view shows: its instrument, whether it is held, the effective plan (P1), its
    weight (fraction; None when unknown or not held) and whether its hints are wanted (False: only
    the plan's freshness, e.g. the asset detail of an instrument neither held nor watched)."""

    instrument: Instrument | None
    held: bool
    plan: str | None = None
    weight: float | None = None
    hints: bool = True

    @property
    def plan_at(self) -> dt.datetime | None:
        """When the effective plan was generated (aware UTC; None without a plan)."""
        if self.plan is None or self.instrument is None or self.instrument.plan_at is None:
            return None
        return convert.aware(self.instrument.plan_at)


@dataclass(frozen=True, slots=True)
class Annotation:
    """What a view attaches to one instrument: its hints (main first) and the plan's freshness
    (``{state, reasons}``; None without a plan)."""

    hints: list[dict]
    plan_freshness: dict | None


def _notes_after_plans(
    session: Session, profile_id: int, subjects: Mapping[int, Subject], now: dt.datetime
) -> dict[int, list[ScoredNote]]:
    """The notes of the subjects with a plan: stored after the oldest plan date, or observed in the
    health window (the invalidating note behind ``thesis_invalidated``). One query."""
    dated = {iid: s.plan_at for iid, s in subjects.items() if s.plan_at is not None}
    if not dated:
        return {}
    since = min(dated.values())
    window = now - dt.timedelta(days=HEALTH_WINDOW_DAYS)
    rows = session.exec(
        select(InvResearchNote).where(
            InvResearchNote.profile_id == profile_id,
            col(InvResearchNote.instrument_id).in_(dated),
            InvResearchNote.kind != CANDIDATE_KIND,
            or_(InvResearchNote.created_at > since, InvResearchNote.observed_at >= window),
        )
    ).all()
    out: dict[int, list[ScoredNote]] = defaultdict(list)
    for r in rows:
        out[r.instrument_id].append(research_views.scored(r))
    return out


def annotate(
    session: Session,
    profile_id: int,
    subjects: Mapping[int, Subject],
    *,
    now: dt.datetime | None = None,
    open_rows: Iterable[InvSignal] | None = None,
    alert_rows: Iterable[InvAlert] | None = None,
) -> dict[int, Annotation]:
    """``{instrument id: Annotation}`` for every subject. ``open_rows`` / ``alert_rows``: the
    profile's open signals / alerts when the caller already loaded them."""
    if not subjects:
        return {}
    now = convert.aware(now or utcnow())
    ids = set(subjects)
    health = research_views.health_by_instrument(session, profile_id, ids, now)
    notes = _notes_after_plans(session, profile_id, subjects, now)
    by_signal: dict[int, list[OpenSignal]] = defaultdict(list)
    fresh_signals: dict[int, list[PlanSignal]] = defaultdict(list)
    for row in signals.open_signal_rows(session, profile_id) if open_rows is None else open_rows:
        if row.instrument_id in ids:
            by_signal[row.instrument_id].append(
                OpenSignal(kind=row.kind, payload=row.payload or {}, severity=row.severity)
            )
            fresh_signals[row.instrument_id].append(
                PlanSignal(
                    signal_id=row.id or 0,
                    kind=row.kind,
                    first_seen_at=convert.aware(row.first_seen_at),
                )
            )
    by_alert: dict[int, list[TriggeredAlert]] = defaultdict(list)
    fresh_alerts: dict[int, list[PlanAlert]] = defaultdict(list)
    for a in alert_store.alerts(session, profile_id) if alert_rows is None else alert_rows:
        if a.instrument_id not in ids or a.deleted_at is not None:
            continue
        if a.status == TRIGGERED:
            by_alert[a.instrument_id].append(
                TriggeredAlert(alert_id=a.id or 0, kind=a.kind, title=a.title)
            )
        if a.last_triggered_at is not None:
            fresh_alerts[a.instrument_id].append(
                PlanAlert(
                    alert_id=a.id or 0,
                    kind=a.kind,
                    triggered_at=convert.aware(a.last_triggered_at),
                )
            )
    out: dict[int, Annotation] = {}
    for iid, subject in subjects.items():
        result, thesis = health[iid]
        freshness = plan_freshness(
            FreshnessFacts(
                plan=subject.plan,
                plan_at=subject.plan_at,
                health=result.state.value,
                notes=tuple(notes.get(iid, ())),
                core_changed_at=None if thesis is None else research_views.core_changed_at(thesis),
                signals=tuple(fresh_signals.get(iid, ())),
                alerts=tuple(fresh_alerts.get(iid, ())),
            ),
            now,
        )
        hints: list[dict] = []
        if subject.hints:
            facts = HintFacts(
                held=subject.held,
                health=result.state.value,
                has_thesis=thesis is not None,
                has_exit_plan=bool(thesis is not None and (thesis.exit_plan or "").strip()),
                plan=subject.plan,
                predates_thesis=result.predates_thesis,
                signals=tuple(by_signal.get(iid, ())),
                alerts=tuple(by_alert.get(iid, ())),
                weight=subject.weight,
                thesis_tracked=research_service.researchable(subject.instrument),
                freshness=freshness,
            )
            hints = [h.to_dict() for h in instrument_hints(facts)]
        out[iid] = Annotation(
            hints=hints,
            plan_freshness=None if freshness is None else freshness.to_dict(research_views.iso),
        )
    return out
