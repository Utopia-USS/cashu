"""Assets: manually valued positions (property, ...) and depreciating vehicles."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core.accounts import get_or_create_account, upsert_balance
from finanse.core.models import Account, AccountType, Bank, Source

from .models import Depreciation


def add_manual_position(
    session: Session,
    *,
    name: str,
    type: AccountType,
    value: Decimal | float | str,
    currency: str = "PLN",
    on_date: date | None = None,
) -> Account:
    """Create/update a manually-tracked asset or liability (property, mortgage,
    loan, ...) and record its current value as a balance snapshot."""
    account = get_or_create_account(
        session,
        bank=Bank.MANUAL,
        name=name,
        external_id=f"manual:{name}",
        type=type,
        currency=currency,
    )
    session.flush()
    upsert_balance(
        session, account, on_date or date.today(), Decimal(str(value)), source=Source.MANUAL
    )
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
) -> Account:
    """Create/update a depreciating VEHICLE asset (declining-balance from the
    purchase price). Counts as illiquid net worth, like property."""
    account = get_or_create_account(
        session,
        bank=Bank.MANUAL,
        name=name,
        external_id=f"vehicle:{name}",
        type=AccountType.VEHICLE,
        currency=currency,
    )
    session.flush()
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
    else:
        session.add(
            Depreciation(
                account_id=account.id,
                purchase_price=Decimal(str(purchase_price)),
                purchase_date=purchase_date,
                annual_rate=Decimal(str(annual_rate)),
                floor=floor_val,
            )
        )
    return account


def depreciations(session: Session) -> dict[int, Depreciation]:
    """account_id -> Depreciation terms (VEHICLE accounts)."""
    return {d.account_id: d for d in session.exec(select(Depreciation)).all()}
