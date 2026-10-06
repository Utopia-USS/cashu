"""Alerts and watchlist rows of one profile (every query is scoped by ``profile_id``). Soft-deleted
alerts (``deleted_at`` set) are left out of every alert query except ``deleted_alert``."""

from __future__ import annotations

import datetime as dt
from collections.abc import Collection

from sqlalchemy import func
from sqlmodel import Session, select

from cashu.core.models import utcnow

from ..alerts import LIVE_STATUSES, AlertSource, alert_rule_id
from ..domain import SignalStatus
from ..models import InvAlert, InvSignal, InvWatchlistItem
from . import convert
from .signals import OPEN_STATUSES

_LIVE_ROW = InvAlert.deleted_at.is_(None)


def alerts(
    session: Session, profile_id: int, statuses: Collection[str] | None = None
) -> list[InvAlert]:
    query = select(InvAlert).where(InvAlert.profile_id == profile_id, _LIVE_ROW)
    if statuses is not None:
        query = query.where(InvAlert.status.in_(sorted(statuses)))
    return list(session.exec(query.order_by(InvAlert.id)).all())


def alert(session: Session, profile_id: int, alert_id: int) -> InvAlert | None:
    row = session.get(InvAlert, alert_id)
    if row is None or row.profile_id != profile_id or row.deleted_at is not None:
        return None
    return row


def deleted_alert(session: Session, profile_id: int, alert_id: int) -> InvAlert | None:
    """A soft-deleted alert of the profile (restore), else None."""
    row = session.get(InvAlert, alert_id)
    if row is None or row.profile_id != profile_id or row.deleted_at is None:
        return None
    return row


def live_agent_alerts(session: Session, profile_id: int) -> int:
    """Agent alerts that can still fire (active, triggered, snoozed): the agent cap counts these."""
    return session.exec(
        select(func.count(InvAlert.id)).where(
            InvAlert.profile_id == profile_id,
            _LIVE_ROW,
            InvAlert.source == AlertSource.AGENT.value,
            InvAlert.status.in_([s.value for s in LIVE_STATUSES]),
        )
    ).one()


def open_alert_signals(session: Session, profile_id: int) -> dict[int, InvSignal]:
    """Open signals of alerts, by alert id."""
    rows = session.exec(
        select(InvSignal).where(
            InvSignal.profile_id == profile_id,
            InvSignal.status.in_(OPEN_STATUSES),
            InvSignal.dedup_key.like("alert:%"),
        )
    ).all()
    out: dict[int, InvSignal] = {}
    for row in rows:
        key = row.dedup_key.removeprefix("alert:")
        if key.isdigit():
            out[int(key)] = row
    return out


CLOSED_BY_KEY = "closed_by"
"""Payload key of an alert signal the owner's action closed (``snooze``, ``mute``, ``delete``) or the
alert's own expiry (``alert_expired``): such a close is no resolution of the condition, so it never
starts the alert's cooldown (F6 review V5)."""


def close_open_signal(
    session: Session,
    profile_id: int,
    alert_id: int,
    *,
    now: dt.datetime | None = None,
    reason: str = "owner",
) -> InvSignal | None:
    """Expire the alert's open signal (muted, snoozed or deleted alerts stop speaking at once),
    marked with ``reason`` under :data:`CLOSED_BY_KEY`."""
    row = session.exec(
        select(InvSignal).where(
            InvSignal.profile_id == profile_id,
            InvSignal.dedup_key == alert_rule_id(alert_id),
            InvSignal.status.in_(OPEN_STATUSES),
        )
    ).first()
    if row is None:
        return None
    row.status = SignalStatus.EXPIRED.value
    row.closed_at = convert.aware(now or utcnow())
    row.payload = {**(row.payload or {}), CLOSED_BY_KEY: reason}
    session.add(row)
    session.flush()
    return row


def reopen_signal_closed_at(
    session: Session, profile_id: int, alert_id: int, closed_at: dt.datetime
) -> InvSignal | None:
    """Re-open the alert's signal that ``close_open_signal`` expired at ``closed_at`` (an alert
    restore): acknowledged again when it had been acknowledged, else active. None when there is no
    such signal or another signal of the alert is open."""
    if (
        session.exec(
            select(InvSignal.id).where(
                InvSignal.profile_id == profile_id,
                InvSignal.dedup_key == alert_rule_id(alert_id),
                InvSignal.status.in_(OPEN_STATUSES),
            )
        ).first()
        is not None
    ):
        return None
    rows = session.exec(
        select(InvSignal)
        .where(
            InvSignal.profile_id == profile_id,
            InvSignal.dedup_key == alert_rule_id(alert_id),
            InvSignal.status == SignalStatus.EXPIRED.value,
        )
        .order_by(InvSignal.id.desc())
    ).all()
    row = next(
        (r for r in rows if r.closed_at is not None and convert.aware(r.closed_at) == closed_at),
        None,
    )
    if row is None:
        return None
    acknowledged = row.acknowledged_at is not None
    row.status = (SignalStatus.ACKNOWLEDGED if acknowledged else SignalStatus.ACTIVE).value
    row.closed_at = None
    row.payload = {k: v for k, v in (row.payload or {}).items() if k != CLOSED_BY_KEY}
    session.add(row)
    session.flush()
    return row


def alert_counts(session: Session, profile_id: int) -> dict[str, int]:
    """Alerts per status plus the agent-created ones that can still fire."""
    rows = session.exec(
        select(InvAlert.status, func.count(InvAlert.id))
        .where(InvAlert.profile_id == profile_id, _LIVE_ROW)
        .group_by(InvAlert.status)
    ).all()
    counts = {status: n for status, n in rows}
    return {
        "active": counts.get("active", 0),
        "triggered": counts.get("triggered", 0),
        "snoozed": counts.get("snoozed", 0),
        "muted": counts.get("muted", 0),
        "expired": counts.get("expired", 0),
        "agent_live": live_agent_alerts(session, profile_id),
    }


# --------------------------------------------------------------------------- #
# Watchlist
# --------------------------------------------------------------------------- #


def watchlist(session: Session, profile_id: int) -> list[InvWatchlistItem]:
    return list(
        session.exec(
            select(InvWatchlistItem)
            .where(InvWatchlistItem.profile_id == profile_id)
            .order_by(InvWatchlistItem.added_at, InvWatchlistItem.id)
        ).all()
    )


def watchlist_item(session: Session, profile_id: int, item_id: int) -> InvWatchlistItem | None:
    row = session.get(InvWatchlistItem, item_id)
    return row if row is not None and row.profile_id == profile_id else None


def watched_item_for(
    session: Session, profile_id: int, instrument_id: int
) -> InvWatchlistItem | None:
    return session.exec(
        select(InvWatchlistItem).where(
            InvWatchlistItem.profile_id == profile_id,
            InvWatchlistItem.instrument_id == instrument_id,
        )
    ).first()


def watched_instrument_ids(session: Session, profile_id: int) -> set[int]:
    return set(
        session.exec(
            select(InvWatchlistItem.instrument_id).where(InvWatchlistItem.profile_id == profile_id)
        ).all()
    )


def alert_instrument_ids(
    session: Session, profile_id: int, statuses: Collection[str] | None = None
) -> set[int]:
    query = select(InvAlert.instrument_id).where(
        InvAlert.profile_id == profile_id, _LIVE_ROW, InvAlert.instrument_id.is_not(None)
    )
    if statuses is not None:
        query = query.where(InvAlert.status.in_(sorted(statuses)))
    return {i for i in session.exec(query).all() if i is not None}
