"""Alerts and watchlist rows of one profile (every query is scoped by ``profile_id``)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Collection

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core.models import utcnow

from ..alerts import LIVE_STATUSES, AlertSource, alert_rule_id
from ..domain import SignalStatus
from ..models import InvAlert, InvSignal, InvWatchlistItem
from . import convert
from .signals import OPEN_STATUSES


def alerts(
    session: Session, profile_id: int, statuses: Collection[str] | None = None
) -> list[InvAlert]:
    query = select(InvAlert).where(InvAlert.profile_id == profile_id)
    if statuses is not None:
        query = query.where(InvAlert.status.in_(sorted(statuses)))
    return list(session.exec(query.order_by(InvAlert.id)).all())


def alert(session: Session, profile_id: int, alert_id: int) -> InvAlert | None:
    row = session.get(InvAlert, alert_id)
    return row if row is not None and row.profile_id == profile_id else None


def live_agent_alerts(session: Session, profile_id: int) -> int:
    """Agent alerts that can still fire (active, triggered, snoozed): the agent cap counts these."""
    return session.exec(
        select(func.count(InvAlert.id)).where(
            InvAlert.profile_id == profile_id,
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


def close_open_signal(
    session: Session, profile_id: int, alert_id: int, *, now: dt.datetime | None = None
) -> InvSignal | None:
    """Expire the alert's open signal (muted, snoozed or deleted alerts stop speaking at once)."""
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
    session.add(row)
    session.flush()
    return row


def alert_counts(session: Session, profile_id: int) -> dict[str, int]:
    """Alerts per status plus the agent-created ones that can still fire."""
    rows = session.exec(
        select(InvAlert.status, func.count(InvAlert.id))
        .where(InvAlert.profile_id == profile_id)
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
        InvAlert.profile_id == profile_id, InvAlert.instrument_id.is_not(None)
    )
    if statuses is not None:
        query = query.where(InvAlert.status.in_(sorted(statuses)))
    return {i for i in session.exec(query).all() if i is not None}
