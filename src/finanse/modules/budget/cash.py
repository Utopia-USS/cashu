"""The cash pool: physical cash tracked as a virtual account per currency.

Its balance is the running sum of its transactions (bank withdrawals mirrored in,
manually logged cash expenses out), never a snapshot.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core.models import Account, AccountType, Bank, Source

from .models import Transaction

ZERO = Decimal("0.00")


def cash_account_ids(session: Session) -> set[int]:
    return {
        a.id
        for a in session.exec(select(Account).where(Account.type == AccountType.CASH)).all()
    }


def get_cash_account(
    session: Session, currency: str = "PLN", *, create: bool = False
) -> Account | None:
    """The single virtual 'Gotówka' account per currency, created on first use."""
    ext = f"cash:{currency}"
    acc = session.exec(
        select(Account).where(Account.bank == Bank.MANUAL, Account.external_id == ext)
    ).first()
    if acc is not None or not create:
        return acc
    acc = Account(
        bank=Bank.MANUAL,
        name="Gotówka" if currency == "PLN" else f"Gotówka ({currency})",
        external_id=ext,
        type=AccountType.CASH,
        currency=currency,
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
        cash = get_cash_account(session, bank_txn.currency, create=True)
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
    currency: str = "PLN",
    on_date: date | None = None,
) -> Transaction:
    """Log a manual cash expense that draws down the cash pool (a real expense)."""
    from .categorize import taxonomy

    if category not in taxonomy.CATEGORY_KEYS:
        raise ValueError(f"Unknown category: {category}")
    amt = -abs(Decimal(str(amount)))
    if amt == 0:
        raise ValueError("Amount must be non-zero")
    cash = get_cash_account(session, currency, create=True)
    txn = Transaction(
        account_id=cash.id,
        booking_date=on_date or date.today(),
        amount=amt,
        currency=currency,
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


def delete_cash_transaction(session: Session, txn_id: int) -> bool:
    """Delete a cash-pool entry. Only transactions on a cash account are removable;
    deleting a withdrawal mirror reverts its source bank transaction's category."""
    from .service import recategorize_one

    t = session.get(Transaction, txn_id)
    if t is None or t.account_id not in cash_account_ids(session):
        return False
    src_id = (t.raw or {}).get("cash_leg_of")
    session.delete(t)
    if src_id is not None:
        bank_txn = session.get(Transaction, src_id)
        if bank_txn is not None:
            recategorize_one(session, bank_txn)
    return True


def cash_balance_points(session: Session) -> dict[int, list[tuple[date, Decimal]]]:
    """Running end-of-day balance per CASH account, derived from its transactions.

    A cash account has no bank/OB balance feed — its balance is purely the sum of
    withdrawals into the pool (positive) minus manually-logged cash spends
    (negative). Returns ascending (date, running_total) points, and an empty list
    for a cash account that has no transactions yet (so it still shows as 0)."""
    out: dict[int, list[tuple[date, Decimal]]] = {}
    cash_accounts = session.exec(
        select(Account).where(Account.type == AccountType.CASH)
    ).all()
    for acc in cash_accounts:
        txns = session.exec(
            select(Transaction).where(Transaction.account_id == acc.id)
        ).all()
        by_date: dict[date, Decimal] = {}
        run = ZERO
        for t in sorted(txns, key=lambda t: (t.booking_date, t.id or 0)):
            run += t.amount
            by_date[t.booking_date] = run
        out[acc.id] = sorted(by_date.items())
    return out
