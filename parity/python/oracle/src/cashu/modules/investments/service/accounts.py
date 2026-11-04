"""Brokerage accounts: a core account of type ``brokerage`` (bank = broker / exchange institution
id) plus its investments settings (tax wrapper, remembered importer)."""

from __future__ import annotations

import re
import uuid

from sqlmodel import Session

from cashu.core import accounts as core_accounts
from cashu.core import institutions
from cashu.core.models import Account

from ..domain import AccountWrapper
from ..importing.canonical import canonical_importer_id
from ..models import InvAccountSettings
from ..store import transactions
from ..store.transactions import BROKERAGE


class AccountError(ValueError):
    """Invalid account input (message safe to show)."""


class AccountConflict(AccountError):
    pass


def broker_ids() -> list[str]:
    """Institutions a brokerage account may belong to (brokers, exchanges, manual)."""
    return [*institutions.ids("broker"), *institutions.ids("exchange"), institutions.MANUAL]


def add_account(
    session: Session,
    profile_id: int,
    *,
    name: str,
    broker: str,
    wrapper: str = AccountWrapper.REGULAR,
    currency: str = "PLN",
) -> Account:
    name = (name or "").strip()
    if not name:
        raise AccountError("name is required")
    if broker not in broker_ids():
        raise AccountError(f"Unknown broker {broker!r}; known: {', '.join(broker_ids())}")
    try:
        wrapper_value = AccountWrapper(wrapper).value
    except ValueError:
        known = ", ".join(w.value for w in AccountWrapper)
        raise AccountError(f"Unknown wrapper {wrapper!r}; known: {known}") from None
    cur = (currency or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", cur):
        raise AccountError("currency must be a 3-letter code (e.g. PLN)")
    folded = name.casefold()
    for existing in transactions.brokerage_accounts(session, profile_id):
        if existing.bank == broker and existing.name.strip().casefold() == folded:
            raise AccountConflict(f"a {broker} account named '{existing.name}' already exists")
    account = core_accounts.get_or_create_account(
        session,
        bank=broker,
        name=name,
        external_id=f"brokerage:{uuid.uuid4().hex}",
        type=BROKERAGE,
        currency=cur,
        profile_id=profile_id,
    )
    session.add(InvAccountSettings(account_id=account.id, wrapper=wrapper_value))
    session.flush()
    return account


def account_dict(session: Session, account: Account) -> dict:
    settings = transactions.account_settings(session, account.id)
    return {
        "id": account.id,
        "name": account.name,
        "broker": account.bank,
        "broker_name": institutions.display_name(account.bank),
        "wrapper": settings.wrapper,
        "currency": account.currency,
        "importer": canonical_importer_id(settings.importer),
        "has_mapping": bool(settings.mapping_yaml),
        "active": account.active,
    }
