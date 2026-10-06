"""Brokerage accounts and what hangs off them: transactions, broker position snapshots, plus the
profile's renames and manual valuations. Every query is scoped to one profile."""

from __future__ import annotations

import datetime as dt
from collections.abc import Collection, Iterable, Sequence
from decimal import Decimal

from sqlmodel import Session, select

from cashu.core.models import Account

from ..domain import InstrumentRename, ManualValuation, Transaction
from ..models import (
    InvAccountSettings,
    InvInstrumentRename,
    InvManualValuation,
    InvPositionSnapshot,
    InvTransaction,
)
from . import convert

BROKERAGE = "brokerage"  # account type id owned by the investments module


def brokerage_accounts(session: Session, profile_id: int) -> list[Account]:
    """The profile's brokerage accounts, oldest first."""
    return list(
        session.exec(
            select(Account)
            .where(Account.profile_id == profile_id, Account.type == BROKERAGE)
            .order_by(Account.id)
        ).all()
    )


def brokerage_account(session: Session, profile_id: int, account_id: int) -> Account | None:
    """One brokerage account of the profile (None for another profile's or a non-brokerage one)."""
    acc = session.get(Account, account_id)
    if acc is None or acc.profile_id != profile_id or acc.type != BROKERAGE:
        return None
    return acc


def account_settings(session: Session, account_id: int) -> InvAccountSettings:
    row = session.get(InvAccountSettings, account_id)
    return row if row is not None else InvAccountSettings(account_id=account_id)


def transaction_rows(
    session: Session, profile_id: int, account_ids: Collection[int] | None = None
) -> list[InvTransaction]:
    accounts = [a.id for a in brokerage_accounts(session, profile_id)]
    if account_ids is not None:
        accounts = [a for a in accounts if a in account_ids]
    if not accounts:
        return []
    return list(
        session.exec(
            select(InvTransaction)
            .where(InvTransaction.account_id.in_(accounts))
            .order_by(InvTransaction.trade_date, InvTransaction.created_at, InvTransaction.id)
        ).all()
    )


def transactions(
    session: Session, profile_id: int, account_ids: Collection[int] | None = None
) -> list[Transaction]:
    """The profile's transactions (domain), in chronological order."""
    return [convert.transaction(r) for r in transaction_rows(session, profile_id, account_ids)]


def has_transactions(session: Session, account_ids: Iterable[int]) -> set[int]:
    """Which of ``account_ids`` have at least one investments transaction."""
    ids = list(account_ids)
    if not ids:
        return set()
    return set(
        session.exec(
            select(InvTransaction.account_id).where(InvTransaction.account_id.in_(ids)).distinct()
        ).all()
    )


def existing_hashes(session: Session, account_id: int, hashes: Sequence[str]) -> set[str]:
    """The subset of ``hashes`` already stored for the account."""
    found: set[str] = set()
    chunk = 500
    for start in range(0, len(hashes), chunk):
        part = list(hashes[start : start + chunk])
        found |= set(
            session.exec(
                select(InvTransaction.dedup_hash).where(
                    InvTransaction.account_id == account_id, InvTransaction.dedup_hash.in_(part)
                )
            ).all()
        )
    return found


def renames(session: Session, profile_id: int) -> list[InstrumentRename]:
    rows = session.exec(
        select(InvInstrumentRename)
        .where(InvInstrumentRename.profile_id == profile_id)
        .order_by(InvInstrumentRename.date, InvInstrumentRename.id)
    ).all()
    return [convert.rename(r) for r in rows]


def manual_valuation_rows(
    session: Session, profile_id: int, instrument_ids: Collection[int] | None = None
) -> list[InvManualValuation]:
    query = select(InvManualValuation).where(InvManualValuation.profile_id == profile_id)
    if instrument_ids is not None:
        query = query.where(InvManualValuation.instrument_id.in_(list(instrument_ids)))
    return list(session.exec(query.order_by(InvManualValuation.as_of, InvManualValuation.id)).all())


def manual_valuations(
    session: Session, profile_id: int, instrument_ids: Collection[int] | None = None
) -> list[ManualValuation]:
    return [
        convert.manual_valuation(r)
        for r in manual_valuation_rows(session, profile_id, instrument_ids)
    ]


def upsert_manual_valuation(
    session: Session,
    profile_id: int,
    instrument_id: int,
    as_of: dt.date,
    unit_value: Decimal,
    currency: str,
    note: str | None = None,
) -> InvManualValuation:
    row = session.exec(
        select(InvManualValuation).where(
            InvManualValuation.profile_id == profile_id,
            InvManualValuation.instrument_id == instrument_id,
            InvManualValuation.as_of == as_of,
        )
    ).first()
    if row is None:
        row = InvManualValuation(
            profile_id=profile_id,
            instrument_id=instrument_id,
            as_of=as_of,
            unit_value=unit_value,
            currency=currency,
            note=note,
        )
    else:
        row.unit_value, row.currency, row.note = unit_value, currency, note
    session.add(row)
    session.flush()
    return row


def latest_position_snapshot(
    session: Session, account_id: int
) -> tuple[dt.date | None, list[InvPositionSnapshot]]:
    """The newest broker position snapshot of the account: (as_of, rows)."""
    newest = session.exec(
        select(InvPositionSnapshot.as_of)
        .where(InvPositionSnapshot.account_id == account_id)
        .order_by(InvPositionSnapshot.as_of.desc())
    ).first()
    if newest is None:
        return None, []
    rows = session.exec(
        select(InvPositionSnapshot)
        .where(InvPositionSnapshot.account_id == account_id, InvPositionSnapshot.as_of == newest)
        .order_by(InvPositionSnapshot.id)
    ).all()
    return newest, list(rows)
