"""Signals, rule runs and the notification log of one profile.

The lifecycle itself is pure (``rules.reconcile_signals``); this module loads its inputs (open
signals, newest closed signal per dedup key) and applies its actions in the caller's transaction.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlmodel import Session, select

from ..domain import SignalSeverity, SignalStatus
from ..models import InvNotification, InvRuleRun, InvSignal
from ..rules import (
    ClosedSignal,
    CreateSignal,
    EscalateSignal,
    ExpireSignal,
    OpenSignal,
    RefreshSignal,
    ResolveSignal,
    SignalCandidate,
    SignalReconciliation,
)
from . import convert

OPEN_STATUSES = (SignalStatus.ACTIVE.value, SignalStatus.ACKNOWLEDGED.value)
CLOSED_STATUSES = (SignalStatus.RESOLVED.value, SignalStatus.EXPIRED.value)


def open_signal_rows(session: Session, profile_id: int) -> list[InvSignal]:
    return list(
        session.exec(
            select(InvSignal)
            .where(InvSignal.profile_id == profile_id, InvSignal.status.in_(OPEN_STATUSES))
            .order_by(InvSignal.id)
        ).all()
    )


def open_signals(session: Session, profile_id: int) -> list[OpenSignal]:
    return [
        OpenSignal(
            signal_id=row.id,
            rule_id=row.rule_id,
            dedup_key=row.dedup_key,
            severity=SignalSeverity(row.severity),
            status=SignalStatus(row.status),
        )
        for row in open_signal_rows(session, profile_id)
    ]


def closed_signals(
    session: Session, profile_id: int, *, skip_closed_by: bool = False
) -> list[ClosedSignal]:
    """The newest closed (resolved / expired) signal of each dedup key (for cooldowns).
    ``skip_closed_by``: ignore signals the owner's action closed (payload ``closed_by``, alerts)."""
    if skip_closed_by:
        newest: dict[str, dt.datetime] = {}
        for key, closed_at, payload in session.exec(
            select(InvSignal.dedup_key, InvSignal.closed_at, InvSignal.payload).where(
                InvSignal.profile_id == profile_id,
                InvSignal.status.in_(CLOSED_STATUSES),
                InvSignal.closed_at.is_not(None),
            )
        ).all():
            if isinstance(payload, dict) and payload.get("closed_by"):
                continue
            at = convert.aware(closed_at)
            if key not in newest or at > newest[key]:
                newest[key] = at
        return [ClosedSignal(dedup_key=k, resolved_at=v) for k, v in newest.items()]
    rows = session.exec(
        select(InvSignal.dedup_key, func.max(InvSignal.closed_at))
        .where(
            InvSignal.profile_id == profile_id,
            InvSignal.status.in_(CLOSED_STATUSES),
            InvSignal.closed_at.is_not(None),
        )
        .group_by(InvSignal.dedup_key)
    ).all()
    out: list[ClosedSignal] = []
    for key, closed_at in rows:
        if isinstance(closed_at, str):  # aggregate results skip the column type
            closed_at = dt.datetime.fromisoformat(closed_at)
        out.append(ClosedSignal(dedup_key=key, resolved_at=convert.aware(closed_at)))
    return out


@dataclass
class AppliedSignals:
    """What applying one run's reconciliation changed (signal row ids)."""

    created: list[int] = field(default_factory=list)
    escalated: list[int] = field(default_factory=list)
    refreshed: list[int] = field(default_factory=list)
    resolved: list[int] = field(default_factory=list)
    expired: list[int] = field(default_factory=list)
    notified: list[int] = field(default_factory=list)


def _fill(row: InvSignal, candidate: SignalCandidate) -> None:
    row.kind = candidate.kind
    row.severity = candidate.severity.value
    row.polarity = candidate.polarity.value
    row.message = candidate.message
    row.instrument_id = convert.maybe_pk(candidate.instrument_id)
    row.account_id = convert.maybe_pk(candidate.account_id)
    row.payload = _jsonable(dict(candidate.payload))


def _jsonable(value):
    """Payloads are JSON-encodable by contract; Decimals and dates are turned into strings."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [_jsonable(v) for v in value]
    if isinstance(value, bool | int | float | str) or value is None:
        return value
    return str(value)


def apply_reconciliation(
    session: Session,
    profile_id: int,
    reconciliation: SignalReconciliation,
    *,
    run_id: int | None,
    notify: frozenset[SignalSeverity],
) -> AppliedSignals:
    """Write one run's lifecycle actions; new and escalated signals whose severity is in ``notify``
    get a notification-log entry (at most one per signal and severity)."""
    applied = AppliedSignals()
    rows = {row.id: row for row in open_signal_rows(session, profile_id)}
    for action in reconciliation.actions:
        match action:
            case CreateSignal(candidate=candidate, created_at=at):
                row = InvSignal(
                    profile_id=profile_id,
                    rule_id=candidate.rule_id,
                    kind=candidate.kind,
                    dedup_key=candidate.dedup_key,
                    severity=candidate.severity.value,
                    status=SignalStatus.ACTIVE.value,
                    message=candidate.message,
                    first_seen_at=convert.aware(at),
                    last_seen_at=convert.aware(at),
                    created_run_id=run_id,
                    last_run_id=run_id,
                )
                _fill(row, candidate)
                session.add(row)
                session.flush()
                applied.created.append(row.id)
                if candidate.severity in notify:
                    _notify(session, profile_id, row, at)
                    applied.notified.append(row.id)
            case RefreshSignal(signal_id=sid, candidate=candidate, seen_at=at):
                row = rows[sid]
                _fill(row, candidate)
                row.last_seen_at, row.last_run_id = convert.aware(at), run_id
                session.add(row)
                applied.refreshed.append(row.id)
            case EscalateSignal(
                signal_id=sid, candidate=candidate, reactivate=reactivate, seen_at=at
            ):
                row = rows[sid]
                _fill(row, candidate)
                row.last_seen_at, row.last_run_id = convert.aware(at), run_id
                if reactivate:
                    row.status = SignalStatus.ACTIVE.value
                    row.acknowledged_at = None
                session.add(row)
                applied.escalated.append(row.id)
                if candidate.severity in notify and not is_snoozed(row, at):
                    session.flush()
                    if _notify(session, profile_id, row, at):
                        applied.notified.append(row.id)
            case ResolveSignal(signal_id=sid, resolved_at=at):
                row = rows[sid]
                row.status, row.closed_at, row.last_run_id = (
                    SignalStatus.RESOLVED.value,
                    convert.aware(at),
                    run_id,
                )
                session.add(row)
                applied.resolved.append(row.id)
            case ExpireSignal(signal_id=sid, expired_at=at):
                row = rows[sid]
                row.status, row.closed_at, row.last_run_id = (
                    SignalStatus.EXPIRED.value,
                    convert.aware(at),
                    run_id,
                )
                session.add(row)
                applied.expired.append(row.id)
            case _:
                pass  # SuppressCandidate: nothing stored
    session.flush()
    return applied


def _notify(session: Session, profile_id: int, row: InvSignal, at: dt.datetime) -> bool:
    exists = session.exec(
        select(InvNotification.id).where(
            InvNotification.signal_id == row.id, InvNotification.severity == row.severity
        )
    ).first()
    if exists is not None:
        return False
    session.add(
        InvNotification(
            profile_id=profile_id,
            signal_id=row.id,
            severity=row.severity,
            created_at=convert.aware(at),
        )
    )
    return True


# --------------------------------------------------------------------------- #
# Snooze ("Odłóż do")
# --------------------------------------------------------------------------- #


def is_snoozed(row: InvSignal, at: dt.datetime) -> bool:
    """True while ``row`` is snoozed (its ``snoozed_until`` is after ``at``)."""
    return row.snoozed_until is not None and convert.aware(row.snoozed_until) > convert.aware(at)


def snooze(session: Session, row: InvSignal, until: dt.datetime | None) -> InvSignal:
    """Hide an open signal until ``until`` (None: back now): it leaves the attention list and gets no
    notification meanwhile (its pending, unsent notification entries are dropped); the daily check
    brings it back afterwards (:func:`wake_snoozed`)."""
    row.snoozed_until = None if until is None else convert.aware(until)
    session.add(row)
    if until is not None:
        for entry in session.exec(
            select(InvNotification).where(
                InvNotification.signal_id == row.id, InvNotification.sent_at.is_(None)
            )
        ).all():
            session.delete(entry)
    session.flush()
    return row


def wake_snoozed(
    session: Session, profile_id: int, *, now: dt.datetime, notify: frozenset[SignalSeverity]
) -> list[int]:
    """Open signals whose snooze passed come back: active again (not acknowledged) and, when the
    policy notifies their severity and they were not notified yet, one notification entry."""
    woken: list[int] = []
    for row in open_signal_rows(session, profile_id):
        if row.snoozed_until is None or is_snoozed(row, now):
            continue
        row.snoozed_until = None
        row.status, row.acknowledged_at = SignalStatus.ACTIVE.value, None
        session.add(row)
        session.flush()
        if SignalSeverity(row.severity) in notify:
            _notify(session, profile_id, row, now)
        woken.append(row.id)
    session.flush()
    return woken


def last_run(session: Session, profile_id: int) -> InvRuleRun | None:
    return session.exec(
        select(InvRuleRun)
        .where(InvRuleRun.profile_id == profile_id)
        .order_by(InvRuleRun.started_at.desc(), InvRuleRun.id.desc())
    ).first()


def runs(session: Session, profile_id: int, limit: int = 20) -> list[InvRuleRun]:
    return list(
        session.exec(
            select(InvRuleRun)
            .where(InvRuleRun.profile_id == profile_id)
            .order_by(InvRuleRun.started_at.desc(), InvRuleRun.id.desc())
            .limit(limit)
        ).all()
    )
