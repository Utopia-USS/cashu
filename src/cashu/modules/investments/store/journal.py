"""The decision journal and position theses of one profile."""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Sequence
from decimal import Decimal

from sqlalchemy import delete, or_
from sqlmodel import Session, select

from cashu.core.models import utcnow

from ..domain import DecisionAction, SignalStatus
from ..models import THESIS_ENTRY_TYPES, InvDecision, InvDecisionSignal, InvSignal, InvThesis


class JournalError(ValueError):
    """Invalid journal input (message safe to show)."""


def signal(session: Session, profile_id: int, signal_id: int) -> InvSignal | None:
    row = session.get(InvSignal, signal_id)
    return row if row is not None and row.profile_id == profile_id else None


def record_decision(
    session: Session,
    profile_id: int,
    *,
    action: str,
    signal_row: InvSignal | None = None,
    signal_rows: Sequence[InvSignal] = (),
    instrument_id: int | None = None,
    account_id: int | None = None,
    quantity: Decimal | None = None,
    price: Decimal | None = None,
    currency: str | None = None,
    reason: str | None = None,
) -> InvDecision:
    """A journal entry. Linked to signals (``signal_row`` is the one-signal shortcut of
    ``signal_rows``; all of one instrument) it acknowledges every one of them with the same timestamp
    (they stay open until the rule clears) and writes one ``inv_decision_signals`` row per signal;
    ``signal_id`` keeps the first. It never books a transaction."""
    try:
        action_value = DecisionAction(action).value
    except ValueError:
        known = ", ".join(a.value for a in DecisionAction)
        raise JournalError(f"Unknown action {action!r}; known: {known}") from None
    if quantity is not None and quantity < 0:
        raise JournalError("quantity must be >= 0")
    if price is not None and price < 0:
        raise JournalError("price must be >= 0")
    rows: list[InvSignal] = []
    for row in ([signal_row] if signal_row is not None else []) + list(signal_rows):
        if all(row.id != seen.id for seen in rows):
            rows.append(row)
    if any(row.profile_id != profile_id for row in rows):
        raise JournalError("A signal belongs to another profile")
    if len({row.instrument_id for row in rows}) > 1:
        raise JournalError("The signals belong to different instruments")
    if rows and instrument_id is not None and rows[0].instrument_id not in (None, instrument_id):
        raise JournalError("The signals belong to another instrument")
    now = utcnow()
    if rows:
        instrument_id = instrument_id if instrument_id is not None else rows[0].instrument_id
        if account_id is None and len({row.account_id for row in rows}) == 1:
            account_id = rows[0].account_id
        for row in rows:
            acknowledge(session, row, at=now)
    decision_row = InvDecision(
        profile_id=profile_id,
        signal_id=rows[0].id if rows else None,
        instrument_id=instrument_id,
        account_id=account_id,
        action=action_value,
        quantity=quantity,
        price=price,
        currency=currency.upper() if currency else None,
        reason=(reason or "").strip() or None,
        created_at=now,
    )
    session.add(decision_row)
    session.flush()
    for row in rows:
        session.add(InvDecisionSignal(decision_id=decision_row.id, signal_id=row.id))
    session.flush()
    return decision_row


def acknowledge(session: Session, row: InvSignal, *, at=None) -> bool:
    """Mark an active signal acknowledged (seen, no change wanted); False when it was not active."""
    if row.status != SignalStatus.ACTIVE.value:
        return False
    row.status = SignalStatus.ACKNOWLEDGED.value
    row.acknowledged_at = at or utcnow()
    session.add(row)
    session.flush()
    return True


UNDO_WINDOW = dt.timedelta(minutes=15)
"""How long after recording a decision it can still be deleted (the UI's undo)."""


class UndoExpired(JournalError):
    """The decision is older than ``UNDO_WINDOW``."""


def decision(session: Session, profile_id: int, decision_id: int) -> InvDecision | None:
    row = session.get(InvDecision, decision_id)
    return row if row is not None and row.profile_id == profile_id else None


def undo_decision(
    session: Session, profile_id: int, row: InvDecision, *, now: dt.datetime | None = None
) -> list[InvSignal]:
    """Delete a decision recorded less than ``UNDO_WINDOW`` ago (raises :class:`UndoExpired`
    otherwise). For every linked signal (the link table, else the legacy ``signal_id``) that is still
    acknowledged and that no remaining decision links, the acknowledgement is reverted (the signal is
    active again), whichever decision wrote it: every acknowledgement comes from a decision, so a
    signal without one must not stay acknowledged (an out-of-order undo would leave it stuck).
    Returns the linked signals, the first one (``signal_id``) first."""
    now = _aware(now or utcnow())
    if now - _aware(row.created_at) > UNDO_WINDOW:
        raise UndoExpired(
            f"Decisions can be undone for {int(UNDO_WINDOW.total_seconds() // 60)} minutes after "
            "they are recorded"
        )
    ids = decision_signal_ids(session, [row]).get(row.id, [])
    linked = [r for r in (signal(session, profile_id, i) for i in ids) if r is not None]
    session.exec(delete(InvDecisionSignal).where(InvDecisionSignal.decision_id == row.id))
    session.delete(row)
    session.flush()
    for sig in linked:
        if sig.status != SignalStatus.ACKNOWLEDGED.value or _has_decision(session, sig.id):
            continue
        sig.status = SignalStatus.ACTIVE.value
        sig.acknowledged_at = None
        session.add(sig)
        session.flush()
    return linked


def _has_decision(session: Session, signal_id: int) -> bool:
    """Whether any decision links the signal (the link table or the legacy column)."""
    return (
        session.exec(select(InvDecision.id).where(_links_signal(signal_id)).limit(1)).first()
        is not None
    )


def _links_signal(signal_id: int):
    return or_(
        InvDecision.signal_id == signal_id,
        InvDecision.id.in_(
            select(InvDecisionSignal.decision_id).where(InvDecisionSignal.signal_id == signal_id)
        ),
    )


def decision_signal_ids(
    session: Session, decision_rows: Iterable[InvDecision]
) -> dict[int, list[int]]:
    """Decision id -> the signal ids it covers: the legacy ``signal_id`` first, then the other linked
    signals by id. A decision without signals maps to ``[]``."""
    rows = [d for d in decision_rows if d.id is not None]
    links: dict[int, set[int]] = {d.id: set() for d in rows}
    ids = list(links)
    for start in range(0, len(ids), 500):  # well under SQLite's bound-parameter limit
        chunk = ids[start : start + 500]
        for decision_id, signal_id in session.exec(
            select(InvDecisionSignal.decision_id, InvDecisionSignal.signal_id).where(
                InvDecisionSignal.decision_id.in_(chunk)
            )
        ).all():
            links[decision_id].add(signal_id)
    out: dict[int, list[int]] = {}
    for d in rows:
        first = [] if d.signal_id is None else [d.signal_id]
        out[d.id] = first + sorted(links[d.id] - set(first))
    return out


def _aware(value: dt.datetime) -> dt.datetime:
    return value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value.astimezone(dt.UTC)


def decisions(
    session: Session,
    profile_id: int,
    *,
    signal_id: int | None = None,
    instrument_id: int | None = None,
) -> list[InvDecision]:
    query = select(InvDecision).where(InvDecision.profile_id == profile_id)
    if signal_id is not None:
        query = query.where(_links_signal(signal_id))
    if instrument_id is not None:
        query = query.where(InvDecision.instrument_id == instrument_id)
    return list(
        session.exec(query.order_by(InvDecision.created_at.desc(), InvDecision.id.desc())).all()
    )


# --------------------------------------------------------------------------- #
# Theses
# --------------------------------------------------------------------------- #

THESIS_FIELDS = ("entry_type", "thesis", "invalidation", "exit_plan", "size_plan")
CORE_THESIS_FIELDS = ("entry_type", "thesis", "invalidation")
"""The fields whose change moves ``core_changed_at`` (research stored before it is tagged
``predates_thesis``); ``exit_plan`` / ``size_plan`` edits never do (P2)."""


def _clean_thesis(values: dict, *, partial: bool) -> dict:
    out: dict = {}
    for key in THESIS_FIELDS:
        if key not in values:
            continue
        value = values[key]
        out[key] = value.strip() if isinstance(value, str) and value.strip() else None
    if ("entry_type" in out or not partial) and out.get("entry_type") not in THESIS_ENTRY_TYPES:
        raise JournalError(f"entry_type must be one of: {', '.join(THESIS_ENTRY_TYPES)}")
    if ("thesis" in out or not partial) and not out.get("thesis"):
        raise JournalError("thesis is required")
    return out


def theses(session: Session, profile_id: int, instrument_id: int | None = None) -> list[InvThesis]:
    query = select(InvThesis).where(InvThesis.profile_id == profile_id)
    if instrument_id is not None:
        query = query.where(InvThesis.instrument_id == instrument_id)
    return list(
        session.exec(query.order_by(InvThesis.created_at.desc(), InvThesis.id.desc())).all()
    )


def thesis(session: Session, profile_id: int, thesis_id: int) -> InvThesis | None:
    row = session.get(InvThesis, thesis_id)
    return row if row is not None and row.profile_id == profile_id else None


def create_thesis(session: Session, profile_id: int, instrument_id: int, values: dict) -> InvThesis:
    cleaned = _clean_thesis(values, partial=False)
    now = utcnow()
    row = InvThesis(
        profile_id=profile_id,
        instrument_id=instrument_id,
        created_at=now,
        updated_at=now,
        core_changed_at=now,
        **cleaned,
    )
    session.add(row)
    session.flush()
    return row


def update_thesis(
    session: Session, row: InvThesis, values: dict, *, reviewed: bool = False
) -> InvThesis:
    now = utcnow()
    for key, value in _clean_thesis(values, partial=True).items():
        if key in CORE_THESIS_FIELDS and getattr(row, key) != value:
            row.core_changed_at = now
        setattr(row, key, value)
    row.updated_at = now
    if reviewed:
        row.reviewed_at = now
    session.add(row)
    session.flush()
    return row


def delete_thesis(session: Session, row: InvThesis) -> None:
    session.delete(row)
    session.flush()
