"""Assets: manually valued positions (property, ...) and depreciating vehicles."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core.accounts import (
    get_or_create_account,
    park_removed_key,
    unpark_key,
    upsert_balance,
)
from finanse.core.institutions import MANUAL
from finanse.core.models import Account, AccountType, Source, utcnow

from .models import NOTE_MAX, AssetDetails, Depreciation

MANUAL_PREFIXES = ("manual:", "vehicle:")
"""External ids of the accounts this module creates (manual positions, vehicles)."""


class AssetError(ValueError):
    """Invalid manual position input (message safe to show)."""


def clean_note(note: str | None) -> str | None:
    """A note as stored: stripped, one line (newlines folded to spaces), empty -> None, at most
    ``NOTE_MAX`` characters (longer is refused, never cut)."""
    if note is None:
        return None
    text = " ".join(str(note).split())
    if not text:
        return None
    if len(text) > NOTE_MAX:
        raise AssetError(f"note is too long (max {NOTE_MAX} characters)")
    return text


def is_module_account(account: Account) -> bool:
    return account.bank == MANUAL and (account.external_id or "").startswith(MANUAL_PREFIXES)


# --- remove / restore (F7 MB2) ------------------------------------------------------------------
# A removed position keeps its account, balances, note and depreciation terms; ``removed_at`` hides it
# from every view and from net worth (core.networth leaves it out, now and in the history).


def remove(session: Session, account: Account) -> None:
    """Remove a manual position or vehicle from the profile's view (idempotent)."""
    if account.removed_at is None:
        account.removed_at = utcnow()
        session.add(account)
        session.flush()


def restore(session: Session, account: Account) -> None:
    """Bring a removed position back (idempotent). Its parked name key comes back unless a visible
    position of the same name holds it now; then it keeps the parked key and the name shows twice
    (``core.accounts.unpark_key``)."""
    if account.removed_at is None:
        return
    account.removed_at = None
    session.add(account)
    session.flush()
    unpark_key(session, account)


def notes(session: Session, account_ids: list[int]) -> dict[int, str]:
    if not account_ids:
        return {}
    rows = session.exec(select(AssetDetails).where(AssetDetails.account_id.in_(account_ids))).all()
    return {r.account_id: r.note for r in rows if r.note}


def set_note(session: Session, account: Account, note: str | None) -> str | None:
    """Store (or clear, with None / blank) the note of a manual position; returns the stored text."""
    text = clean_note(note)
    row = session.exec(select(AssetDetails).where(AssetDetails.account_id == account.id)).first()
    if row is None:
        if text is None:
            return None
        row = AssetDetails(account_id=account.id)
    row.note = text
    row.updated_at = utcnow()
    session.add(row)
    session.flush()
    return text


def add_manual_position(
    session: Session,
    *,
    name: str,
    type: str,
    value: Decimal | float | str,
    currency: str = "PLN",
    on_date: date | None = None,
    profile_id: int | None = None,
    note: str | None = None,
) -> Account:
    """Create/update a manually-tracked asset or liability (property, mortgage,
    loan, ...) of the profile and record its current value as a balance snapshot. ``note``
    (optional, max 500 characters) replaces the stored note when given."""
    clean_note(note)  # validate before anything is written
    park_removed_key(session, profile_id, MANUAL, f"manual:{name}")  # a removed one starts fresh
    account = get_or_create_account(
        session,
        bank=MANUAL,
        name=name,
        external_id=f"manual:{name}",
        type=type,
        currency=currency,
        profile_id=profile_id,
    )
    session.flush()
    upsert_balance(
        session, account, on_date or date.today(),  # noqa: DTZ011 - local dates
        Decimal(str(value)), source=Source.MANUAL,
    )
    if note is not None:
        set_note(session, account, note)
    return account


def set_vehicle(
    session: Session,
    *,
    name: str,
    purchase_price: Decimal | float | str,
    purchase_date: date,
    annual_rate: Decimal | float | str,
    floor: Decimal | float | str | None = None,
    currency: str = "PLN",
    profile_id: int | None = None,
) -> Account:
    """Create/update a depreciating VEHICLE asset of the profile (declining-balance
    from the purchase price). Counts as illiquid net worth, like property."""
    park_removed_key(session, profile_id, MANUAL, f"vehicle:{name}")  # a removed one starts fresh
    account = get_or_create_account(
        session,
        bank=MANUAL,
        name=name,
        external_id=f"vehicle:{name}",
        type=AccountType.VEHICLE,
        currency=currency,
        profile_id=profile_id,
    )
    session.flush()
    set_depreciation(
        session,
        account,
        purchase_price=purchase_price,
        purchase_date=purchase_date,
        annual_rate=annual_rate,
        floor=floor,
    )
    return account


def set_depreciation(
    session: Session,
    account: Account,
    *,
    purchase_price: Decimal | float | str,
    purchase_date: date,
    annual_rate: Decimal | float | str,
    floor: Decimal | float | str | None = None,
) -> Depreciation:
    """Create or replace the depreciation curve of a vehicle account (``annual_rate`` in percent,
    15 = 15 %/yr; ``floor`` None = no floor)."""
    existing = session.exec(
        select(Depreciation).where(Depreciation.account_id == account.id)
    ).first()
    floor_val = Decimal(str(floor)) if floor is not None else None
    if existing is not None:
        existing.purchase_price = Decimal(str(purchase_price))
        existing.purchase_date = purchase_date
        existing.annual_rate = Decimal(str(annual_rate))
        existing.floor = floor_val
        session.add(existing)
        return existing
    row = Depreciation(
        account_id=account.id,
        purchase_price=Decimal(str(purchase_price)),
        purchase_date=purchase_date,
        annual_rate=Decimal(str(annual_rate)),
        floor=floor_val,
    )
    session.add(row)
    return row
