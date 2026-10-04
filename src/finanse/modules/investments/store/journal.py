"""The decision journal and position theses of one profile."""

from __future__ import annotations

from decimal import Decimal

from sqlmodel import Session, select

from finanse.core.models import utcnow

from ..domain import DecisionAction, SignalStatus
from ..models import THESIS_ENTRY_TYPES, InvDecision, InvSignal, InvThesis


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
    instrument_id: int | None = None,
    account_id: int | None = None,
    quantity: Decimal | None = None,
    price: Decimal | None = None,
    currency: str | None = None,
    reason: str | None = None,
) -> InvDecision:
    """A journal entry. Linked to a signal it also acknowledges the signal (it stays open until the
    rule clears); it never books a transaction."""
    try:
        action_value = DecisionAction(action).value
    except ValueError:
        known = ", ".join(a.value for a in DecisionAction)
        raise JournalError(f"Unknown action {action!r}; known: {known}") from None
    if quantity is not None and quantity < 0:
        raise JournalError("quantity must be >= 0")
    if price is not None and price < 0:
        raise JournalError("price must be >= 0")
    now = utcnow()
    if signal_row is not None:
        instrument_id = instrument_id if instrument_id is not None else signal_row.instrument_id
        account_id = account_id if account_id is not None else signal_row.account_id
        acknowledge(session, signal_row, at=now)
    row = InvDecision(
        profile_id=profile_id,
        signal_id=None if signal_row is None else signal_row.id,
        instrument_id=instrument_id,
        account_id=account_id,
        action=action_value,
        quantity=quantity,
        price=price,
        currency=currency.upper() if currency else None,
        reason=(reason or "").strip() or None,
        created_at=now,
    )
    session.add(row)
    session.flush()
    return row


def acknowledge(session: Session, row: InvSignal, *, at=None) -> bool:
    """Mark an active signal acknowledged (seen, no change wanted); False when it was not active."""
    if row.status != SignalStatus.ACTIVE.value:
        return False
    row.status = SignalStatus.ACKNOWLEDGED.value
    row.acknowledged_at = at or utcnow()
    session.add(row)
    session.flush()
    return True


def decisions(
    session: Session,
    profile_id: int,
    *,
    signal_id: int | None = None,
    instrument_id: int | None = None,
) -> list[InvDecision]:
    query = select(InvDecision).where(InvDecision.profile_id == profile_id)
    if signal_id is not None:
        query = query.where(InvDecision.signal_id == signal_id)
    if instrument_id is not None:
        query = query.where(InvDecision.instrument_id == instrument_id)
    return list(
        session.exec(query.order_by(InvDecision.created_at.desc(), InvDecision.id.desc())).all()
    )


# --------------------------------------------------------------------------- #
# Theses
# --------------------------------------------------------------------------- #

THESIS_FIELDS = ("entry_type", "thesis", "invalidation", "exit_plan", "size_plan")


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
    row = InvThesis(profile_id=profile_id, instrument_id=instrument_id, **cleaned)
    session.add(row)
    session.flush()
    return row


def update_thesis(
    session: Session, row: InvThesis, values: dict, *, reviewed: bool = False
) -> InvThesis:
    for key, value in _clean_thesis(values, partial=True).items():
        setattr(row, key, value)
    now = utcnow()
    row.updated_at = now
    if reviewed:
        row.reviewed_at = now
    session.add(row)
    session.flush()
    return row


def delete_thesis(session: Session, row: InvThesis) -> None:
    session.delete(row)
    session.flush()
