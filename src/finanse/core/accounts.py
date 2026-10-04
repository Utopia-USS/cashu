"""Accounts and balance snapshots: the core every module writes through.

Bank import (budget), manual positions (assets), loans and the cash pool all
create their accounts with ``get_or_create_account`` and record balances with
``upsert_balance``, so account identity and balance bookkeeping stay uniform.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from .models import Account, AccountType, Balance, Bank, Source
from .text import iban_key, normalize_iban


def get_or_create_account(
    session: Session,
    *,
    bank: Bank,
    name: str | None = None,
    iban: str | None = None,
    external_id: str | None = None,
    type: AccountType = AccountType.CHECKING,
    currency: str = "PLN",
) -> Account:
    iban = normalize_iban(iban) or None
    iban_canon = iban_key(iban)

    stmt = select(Account).where(Account.bank == bank)
    account: Account | None = None
    for acc in session.exec(stmt).all():
        if external_id and acc.external_id == external_id:
            account = acc
            break
        # Match across sources: CSV stores bare NRB, Open Banking full IBAN.
        if iban_canon and acc.iban and iban_key(acc.iban) == iban_canon:
            account = acc
            break

    if account is None:
        account = Account(
            bank=bank,
            name=name or f"{bank.value} {iban[-4:] if iban else ''}".strip(),
            iban=iban,
            external_id=external_id or (f"csv:{iban}" if iban else None),
            type=type,
            currency=currency,
        )
        session.add(account)
        session.flush()  # assign id
    else:
        # backfill only missing fields; never overwrite an existing name (the
        # Open Banking "name" is just the account holder — useless and identical
        # across accounts — and would clobber CSV/user-set names).
        if iban and not account.iban:
            account.iban = iban
        if external_id and not account.external_id:
            account.external_id = external_id
        session.add(account)

    return account


def set_balance(
    session: Session,
    account_id: int,
    value: Decimal | float | str,
    *,
    on_date: date | None = None,
    source: Source = Source.MANUAL,
) -> Account:
    """Record a balance snapshot for an existing account (e.g. update a mortgage
    or revalue a property over time)."""
    account = session.get(Account, account_id)
    if account is None:
        raise ValueError(f"No account with id {account_id}")
    upsert_balance(session, account, on_date or date.today(), Decimal(str(value)), source=source)
    return account


def upsert_balance(
    session: Session,
    account: Account,
    on_date: date,
    amount: Decimal,
    *,
    source: Source,
    currency: str | None = None,
) -> None:
    existing = session.exec(
        select(Balance).where(
            Balance.account_id == account.id,
            Balance.date == on_date,
            Balance.source == source,
        )
    ).first()
    if existing:
        existing.amount = amount
        session.add(existing)
        return
    session.add(
        Balance(
            account_id=account.id,
            date=on_date,
            amount=amount,
            currency=currency or account.currency,
            source=source,
        )
    )


def own_ibans(session: Session) -> set[str]:
    """Canonical keys of every account number we own: a transaction whose
    counterparty is one of these is a move within the estate, not income/expense."""
    return {iban_key(a.iban) for a in session.exec(select(Account)).all() if a.iban}
