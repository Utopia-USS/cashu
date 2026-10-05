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
    upsert_balance(
        session, account, on_date or date.today(),  # noqa: DTZ011 - local dates
        Decimal(str(value)), source=source,
    )
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


# --- removed accounts: name keys (F7 MB2) -------------------------------------------------------
# An account the owner removed (``removed_at`` set; the assets module's DELETE) keeps its row. Its
# ``external_id`` (``manual:<name>``) is unique per profile and bank, so before a new account takes that
# key the removed one is parked aside as ``<key>~<id>``; a restore takes the key back when it is free.


def _key_holder(session: Session, profile_id: int, bank: str, key: str) -> Account | None:
    return session.exec(
        select(Account).where(
            Account.profile_id == profile_id, Account.bank == bank, Account.external_id == key
        )
    ).first()


def park_removed_key(session: Session, profile_id: int | None, bank: str, key: str) -> None:
    """Move a removed account holding ``key`` aside (``<key>~<id>``) so ``key`` can name a fresh
    account: a new position or loan of a removed one's name never revives its history or terms."""
    pid = profiles.scope(session, profile_id, create=True)
    holder = _key_holder(session, pid, bank, key)
    if holder is not None and holder.removed_at is not None:
        holder.external_id = f"{key}~{holder.id}"
        session.add(holder)
        session.flush()


def unpark_key(session: Session, account: Account) -> None:
    """On a restore: take the parked key (``<key>~<id>``) back unless a visible account holds it now (a
    removed holder is parked aside); otherwise the account keeps its parked key."""
    parked, suffix = account.external_id or "", f"~{account.id}"
    if not parked.endswith(suffix):
        return
    key = parked[: -len(suffix)]
    park_removed_key(session, account.profile_id, account.bank, key)
    if _key_holder(session, account.profile_id, account.bank, key) is None:
        account.external_id = key
        session.add(account)
        session.flush()
