"""Research signals: a note that invalidates the thesis (severity ``action``) or has strength 3
(severity ``info``) becomes a signal through the rule-signal lifecycle (``rules.reconcile_signals`` +
``store.signals.apply_reconciliation``) and the profile's notification policy (the strategy's
``notifications.immediate``, else the default: action only).

One signal per instrument or theme and ISO week of storing (``keys.research_dedup_key``): further
qualifying notes of that week join it (refresh, or escalate to action with a notification); the
signal shows its lead note (highest severity, then strength, then the newest). Polarity = the lead
note's polarity. Candidate notes never become signals (they have their own accept / dismiss).

The signal stays open while at least one of its notes qualifies (stored, not dismissed, not
expired): dismissing the last one resolves it with ``payload.closed_reason = "note_dismissed"``
(restoring within the window reopens the same row), expiry resolves it with ``"notes_expired"``
(housekeeping). ``note.signal_id`` remembers the signal a note created or joined.

The signal message reaches the owner (macOS notification, signal list), so it is Polish, with the
dashboard's labels for note kinds and thesis relations (frontend ``v2/research/logic.ts``):
``Analiza (wiadomość, podważa tezę): <title>; siła 3/3, 2 źródła``.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass

from sqlmodel import Session, select

from cashu.core.models import Profile

from ..domain import SignalSeverity, SignalStatus, severity_rank
from ..models import InvResearchNote, InvSignal
from ..rules import (
    Fired,
    NotFired,
    OpenSignal,
    RuleSpec,
    SignalCandidate,
    SignalPolarity,
    reconcile_signals,
)
from ..store import convert
from ..store import signals as signal_store
from .keys import is_research_key, research_dedup_key, research_rule_id
from .scoring import CANDIDATE_KIND, iso_week, theme_key

CLOSED_DISMISSED = "note_dismissed"
CLOSED_EXPIRED = "notes_expired"

KIND_LABEL = {
    "news": "wiadomość",
    "earnings": "wyniki",
    "community": "społeczność · szum",
    "trend": "trend",
    "macro": "makro",
    "candidate": "kandydat",
}
"""Polish labels of note kinds, as in the dashboard (``KIND_LABEL`` in v2/research/logic.ts)."""

RELATION_LABEL = {
    "invalidates": "podważa tezę",
    "weakens": "osłabia tezę",
    "supports": "wzmacnia tezę",
    "fulfills": "spełnia tezę",
}
"""Polish labels of the thesis relations a message names (``RELATION_LABEL`` in v2/research/logic.ts);
``neutral`` / ``none`` are left out of the message."""


def sources_phrase(count: int) -> str:
    """Polish plural: 1 źródło, 2-4 źródła (not 12-14), 0 / 5+ źródeł."""
    if count == 1:
        return "1 źródło"
    if count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14):
        return f"{count} źródła"
    return f"{count} źródeł"


def research_message(
    kind: str, relation: str | None, title: str, strength: int, sources: int
) -> str:
    """The signal message of a lead note: ``Analiza (<kind>, <relation>): <title>; siła N/3, <sources>``
    (an unknown kind shows as is; a relation outside :data:`RELATION_LABEL` is left out)."""
    label = KIND_LABEL.get(kind, kind)
    relation_text = RELATION_LABEL.get(relation or "")
    head = f"{label}, {relation_text}" if relation_text else label
    return f"Analiza ({head}): {title}; siła {strength}/3, {sources_phrase(sources)}"


def aware(value: dt.datetime | None) -> dt.datetime | None:
    return None if value is None else convert.aware(value)


def severity_of(note: InvResearchNote, at: dt.datetime) -> SignalSeverity | None:
    """The severity a note's signal would have at ``at`` (None: the note does not qualify)."""
    if note.kind == CANDIDATE_KIND or note.dismissed_at is not None:
        return None
    if aware(note.expires_at) <= at:
        return None
    if note.instrument_id is None and not note.theme:
        return None
    if note.thesis_relation == "invalidates":
        return SignalSeverity.ACTION
    if note.strength >= 3:
        return SignalSeverity.INFO
    return None


def note_key(note: InvResearchNote) -> str | None:
    """The dedup key of the signal this note would create or join (None for candidates and notes
    without an instrument or theme)."""
    if note.kind == CANDIDATE_KIND:
        return None
    week = iso_week(aware(note.created_at).date())
    if note.instrument_id is not None:
        return research_dedup_key(week, instrument_id=note.instrument_id)
    if note.theme:
        return research_dedup_key(week, theme=theme_key(note.theme))
    return None


def notify_policy(session: Session, profile: Profile) -> frozenset[SignalSeverity]:
    """Severities that notify at once: the strategy's ``notifications.immediate`` or the default."""
    from ..service import strategy as strategy_files
    from ..strategy import NotificationPolicy

    try:
        config = strategy_files.load(session, profile).config
    except Exception:  # noqa: BLE001 - an unreadable strategy falls back to the default policy
        config = None
    return (config.notifications if config is not None else NotificationPolicy()).immediate


def _week_notes(session: Session, profile_id: int, key: str) -> list[InvResearchNote]:
    """Notes of the profile stored in the key's ISO week that map to the key."""
    week = key.split("|", 1)[0].removeprefix("research:")
    year, number = week.split("-W")
    monday = dt.date.fromisocalendar(int(year), int(number), 1)
    start = dt.datetime.combine(monday, dt.time(), tzinfo=dt.UTC)
    rows = session.exec(
        select(InvResearchNote).where(
            InvResearchNote.profile_id == profile_id,
            InvResearchNote.created_at >= start - dt.timedelta(days=1),
            InvResearchNote.created_at < start + dt.timedelta(days=8),
        )
    ).all()
    return [r for r in rows if note_key(r) == key]


def _lead(notes: Iterable[InvResearchNote], at: dt.datetime) -> list[InvResearchNote]:
    qualifying = [n for n in notes if severity_of(n, at) is not None]
    return sorted(
        qualifying,
        key=lambda n: (
            severity_rank(severity_of(n, at)),
            n.strength,
            aware(n.created_at),
            n.id or 0,
        ),
        reverse=True,
    )


def candidate_for(
    key: str, notes: Iterable[InvResearchNote], at: dt.datetime
) -> SignalCandidate | None:
    """The signal candidate of ``key`` from its notes (None when no note qualifies)."""
    ordered = _lead(notes, at)
    if not ordered:
        return None
    lead = ordered[0]
    severity = severity_of(lead, at)
    assert severity is not None
    sources = len(lead.sources or [])
    message = research_message(lead.kind, lead.thesis_relation, lead.title, lead.strength, sources)
    week = key.split("|", 1)[0].removeprefix("research:")
    return SignalCandidate(
        rule_id=research_rule_id(lead.kind),
        kind=research_rule_id(lead.kind),
        dedup_key=key,
        severity=severity,
        message=message,
        instrument_id=None if lead.instrument_id is None else str(lead.instrument_id),
        payload={
            "note_id": lead.id,
            "note_ids": [n.id for n in ordered],
            "notes": len(ordered),
            "kind": lead.kind,
            "relation": lead.thesis_relation,
            "thesis_field": lead.thesis_field,
            "strength": lead.strength,
            "sources": sources,
            "title": lead.title,
            "theme": lead.theme,
            "week": week,
        },
        polarity=SignalPolarity(lead.polarity),
    )


@dataclass
class SyncResult:
    signal_id: int | None = None
    created: bool = False
    escalated: bool = False
    resolved: bool = False
    notified: bool = False


def _open_row(session: Session, profile_id: int, key: str) -> InvSignal | None:
    return next(
        (r for r in signal_store.open_signal_rows(session, profile_id) if r.dedup_key == key), None
    )


def sync(
    session: Session,
    profile: Profile,
    key: str,
    *,
    now: dt.datetime,
    notify: frozenset[SignalSeverity] | None = None,
    reason: str = CLOSED_EXPIRED,
) -> SyncResult:
    """Bring the research signal of ``key`` in line with its notes: create, refresh / escalate (with
    a notification per the policy), or resolve it (``reason`` goes to ``payload.closed_reason``)."""
    assert profile.id is not None
    now = convert.aware(now)
    notes = _week_notes(session, profile.id, key)
    open_row = _open_row(session, profile.id, key)
    candidate = candidate_for(key, notes, now)
    result = SyncResult()
    if candidate is None and open_row is None:
        return result
    open_signals = (
        []
        if open_row is None
        else [
            OpenSignal(
                open_row.id,
                open_row.rule_id,
                open_row.dedup_key,
                SignalSeverity(open_row.severity),
                SignalStatus(open_row.status),
            )
        ]
    )
    if candidate is not None:
        outcomes = [Fired(candidate)]
        rules = [RuleSpec(candidate.rule_id, candidate.kind, None, candidate.severity)]
    else:
        assert open_row is not None
        outcomes = [NotFired(open_row.rule_id, key)]
        rules = [RuleSpec(open_row.rule_id, open_row.kind, None)]
    previous_status = open_row.status if open_row is not None else None
    reconciliation = reconcile_signals(
        open_signals=open_signals, outcomes=outcomes, rules=rules, clock=lambda: now
    )
    policy = notify if notify is not None else notify_policy(session, profile)
    applied = signal_store.apply_reconciliation(
        session, profile.id, reconciliation, run_id=None, notify=policy
    )
    result.created = bool(applied.created)
    result.escalated = bool(applied.escalated)
    result.resolved = bool(applied.resolved)
    result.notified = bool(applied.notified)
    signal_id = (applied.created or [None])[0] or (open_row.id if open_row is not None else None)
    result.signal_id = signal_id
    row = session.get(InvSignal, signal_id) if signal_id is not None else None
    if row is None:
        return result
    if candidate is not None:
        row.rule_id = candidate.rule_id  # the lead note's kind may change within the week
        for note in _lead(notes, now):
            if note.signal_id != row.id:
                note.signal_id = row.id
                session.add(note)
    elif result.resolved:
        row.payload = {
            **(row.payload or {}),
            "closed_reason": reason,
            "previous_status": previous_status,
        }
    session.add(row)
    session.flush()
    return result


def reopen_dismissed(
    session: Session,
    profile_id: int,
    note: InvResearchNote,
    *,
    now: dt.datetime,
    window: dt.timedelta,
) -> bool:
    """Reopen the signal a dismissal resolved (same row, previous status) when it closed within
    ``window`` and no other signal of its key is open. True when reopened."""
    if note.signal_id is None:
        return False
    row = session.get(InvSignal, note.signal_id)
    if (
        row is None
        or row.profile_id != profile_id
        or row.status != SignalStatus.RESOLVED.value
        or (row.payload or {}).get("closed_reason") != CLOSED_DISMISSED
        or row.closed_at is None
        or convert.aware(now) - convert.aware(row.closed_at) > window
        or _open_row(session, profile_id, row.dedup_key) is not None
    ):
        return False
    payload = dict(row.payload or {})
    previous = payload.pop("previous_status", None)
    payload.pop("closed_reason", None)
    row.status = (
        previous
        if previous in (SignalStatus.ACTIVE.value, SignalStatus.ACKNOWLEDGED.value)
        else SignalStatus.ACTIVE.value
    )
    row.closed_at = None
    row.payload = payload
    session.add(row)
    session.flush()
    return True


def open_research_rows(session: Session, profile_id: int) -> list[InvSignal]:
    return [
        r
        for r in signal_store.open_signal_rows(session, profile_id)
        if is_research_key(r.dedup_key)
    ]


def research_signal_rows(session: Session, profile_id: int) -> list[InvSignal]:
    """Every research signal of the profile (open and closed), newest first."""
    rows = session.exec(
        select(InvSignal)
        .where(InvSignal.profile_id == profile_id, InvSignal.dedup_key.startswith("research:"))
        .order_by(InvSignal.id.desc())
    ).all()
    return list(rows)
