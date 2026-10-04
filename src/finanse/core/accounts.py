"""Accounts and balance snapshots: the core every module writes through.

Bank import (budget), manual positions (assets), loans and the cash pool all
create their accounts with ``get_or_create_account`` and record balances with
``upsert_balance``, so account identity and balance bookkeeping stay uniform.
Accounts belong to one profile; ``profile_id=None`` means the default profile
(see ``core.profiles``).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from . import profiles
from .models import Account, AccountType, Balance, Source, utcnow
from .text import iban_key, normalize_iban


def get_or_create_account(
    session: Session,
    *,
    bank: str,
    name: str | None = None,
    iban: str | None = None,
    external_id: str | None = None,
    type: AccountType = AccountType.CHECKING,
    currency: str = "PLN",
    profile_id: int | None = None,
) -> Account:
    pid = profiles.scope(session, profile_id, create=True)
    iban = normalize_iban(iban) or None
    iban_canon = iban_key(iban)

    stmt = select(Account).where(Account.profile_id == pid, Account.bank == bank)
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
            name=name or f"{bank} {iban[-4:] if iban else ''}".strip(),
            iban=iban,
            external_id=external_id or (f"csv:{iban}" if iban else None),
            type=type,
            currency=currency,
            profile_id=pid,
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
    profile_id: int | None = None,
) -> Account:
    """Record a balance snapshot for an existing account (e.g. update a mortgage
    or revalue a property over time)."""
    account = get_account(session, account_id, profile_id=profile_id)
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
        existing.created_at = utcnow()  # = when this figure was recorded (see loans)
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


def get_account(session: Session, account_id: int, *, profile_id: int | None = None) -> Account:
    """An account of the profile (default profile when None); ValueError otherwise."""
    pid = profiles.scope(session, profile_id)
    account = session.get(Account, account_id)
    if account is None or account.profile_id != pid:
        raise ValueError(f"No account with id {account_id}")
    return account


def profile_accounts(session: Session, profile_id: int | None = None) -> list[Account]:
    pid = profiles.scope(session, profile_id)
    return list(session.exec(select(Account).where(Account.profile_id == pid)).all())


def own_ibans(session: Session, profile_id: int | None = None) -> set[str]:
    """Canonical keys of every account number the profile owns: a transaction whose
    counterparty is one of these is a move within the profile's money, not
    income/expense. Per profile: a transfer to a partner's account in another
    profile is a real outflow here."""
    return {iban_key(a.iban) for a in profile_accounts(session, profile_id) if a.iban}
