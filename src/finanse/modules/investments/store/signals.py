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


def closed_signals(session: Session, profile_id: int) -> list[ClosedSignal]:
    """The newest closed (resolved / expired) signal of each dedup key (for cooldowns)."""
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
                if candidate.severity in notify:
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
