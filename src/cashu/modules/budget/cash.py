"""The cash pool: physical cash tracked as a virtual account per currency.

Its balance is the running sum of its transactions (bank withdrawals mirrored in,
manually logged cash expenses out), never a snapshot.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from cashu.core import profiles
from cashu.core.institutions import MANUAL
from cashu.core.models import Account, AccountType, Source

from .models import Transaction


def cash_account_ids(session: Session, profile_id: int | None = None) -> set[int]:
    pid = profiles.scope(session, profile_id)
    return {
        a.id
        for a in session.exec(
            select(Account).where(Account.profile_id == pid, Account.type == AccountType.CASH)
        ).all()
    }


def get_cash_account(
    session: Session,
    currency: str | None = None,
    *,
    create: bool = False,
    profile_id: int | None = None,
) -> Account | None:
    """The profile's single virtual 'Gotówka' account per currency (default: the
    profile's base currency), created on first use."""
    from .analytics import base_currency

    pid = profiles.scope(session, profile_id, create=create)
    base = base_currency(session, pid)
    currency = currency or base
    ext = f"cash:{currency}"
    acc = session.exec(
        select(Account).where(
            Account.profile_id == pid, Account.bank == MANUAL, Account.external_id == ext
        )
    ).first()
    if acc is not None or not create:
        return acc
    acc = Account(
        bank=MANUAL,
        name="Gotówka" if currency == base else f"Gotówka ({currency})",
        external_id=ext,
        type=AccountType.CASH,
        currency=currency,
        profile_id=pid,
    )
    session.add(acc)
    session.flush()
    return acc


def sync_cash_leg(session: Session, bank_txn: Transaction, category: str) -> None:
    """Keep a cash-pool credit in sync with a bank withdrawal marked cash_withdrawal.

    The mirror is a positive entry on the cash account keyed by the bank txn id
    (dedup_hash = ``cashleg:<id>``), so it's idempotent and removable."""
    tag = f"cashleg:{bank_txn.id}"
    existing = session.exec(
        select(Transaction).where(Transaction.dedup_hash == tag)
    ).first()

    if category == "cash_withdrawal":
        pid = session.get(Account, bank_txn.account_id).profile_id
        cash = get_cash_account(session, bank_txn.currency, create=True, profile_id=pid)
        amount = abs(bank_txn.amount)
        if existing is None:
            session.add(
                Transaction(
                    account_id=cash.id,
                    booking_date=bank_txn.booking_date,
                    value_date=bank_txn.value_date,
                    amount=amount,
                    currency=bank_txn.currency,
                    counterparty_name="Wypłata gotówki",
                    description=bank_txn.reference or bank_txn.description or "Wypłata gotówki",
                    reference="Wypłata gotówki",
                    source=Source.MANUAL,
                    dedup_hash=tag,
                    occurrence=0,
                    category="cash_withdrawal",
                    category_source="cash_leg",
                    raw={"cash_leg_of": bank_txn.id},
                )
            )
        else:
            existing.amount = amount
            existing.booking_date = bank_txn.booking_date
            existing.currency = bank_txn.currency
            session.add(existing)
    elif existing is not None:
        session.delete(existing)


def add_cash_expense(
    session: Session,
    *,
    amount: Decimal | float | str,
    title: str,
    category: str,
    currency: str | None = None,
    on_date: date | None = None,
    profile_id: int | None = None,
) -> Transaction:
    """Log a manual cash expense that draws down the profile's cash pool (a real
    expense)."""
    from .categorize import taxonomy

    if category not in taxonomy.CATEGORY_KEYS:
        raise ValueError(f"Unknown category: {category}")
    amt = -abs(Decimal(str(amount)))
    if amt == 0:
        raise ValueError("Amount must be non-zero")
    cash = get_cash_account(session, currency, create=True, profile_id=profile_id)
    txn = Transaction(
        account_id=cash.id,
        booking_date=on_date or date.today(),  # noqa: DTZ011 - local dates
        amount=amt,
        currency=cash.currency,
        counterparty_name=title,
        description=title,
        reference=title,
        source=Source.MANUAL,
        dedup_hash=f"cashexp:{uuid.uuid4().hex}",
        occurrence=0,
        category=category,
        category_source="manual_txn",
        raw={"cash_expense": True},
    )
    session.add(txn)
    session.flush()
    return txn


def delete_cash_transaction(
    session: Session, txn_id: int, *, profile_id: int | None = None
) -> bool:
    """Delete a cash-pool entry. Only transactions on one of the profile's cash
    accounts are removable; deleting a withdrawal mirror reverts its source bank
    transaction's category."""
    from .service import recategorize_one

    t = session.get(Transaction, txn_id)
    if t is None or t.account_id not in cash_account_ids(session, profile_id):
        return False
    src_id = (t.raw or {}).get("cash_leg_of")
    session.delete(t)
    if src_id is not None:
        bank_txn = session.get(Transaction, src_id)
        if bank_txn is not None:
            recategorize_one(session, bank_txn)
    return True
