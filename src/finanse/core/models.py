"""Core tables: accounts and their balance snapshots.

A single physical bank account maps to exactly one `Account` row, regardless of
which source (Open Banking or CSV) produced the data — e.g. legacy Santander
CSV exports and new Erste Open Banking data land in the same Account. Every
module hangs its own data off accounts (transactions, loans, depreciation, ...).
"""

from __future__ import annotations

import datetime as dt
import enum
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import Field, SQLModel

from .types import DecimalText


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Bank(str, enum.Enum):
    MBANK = "mbank"
    ERSTE = "erste"  # includes legacy "Santander Bank Polska"
    PEKAO = "pekao"  # Bank Pekao S.A. (CSV-only, e.g. car-loan servicing account)
    MANUAL = "manual"  # manually-tracked positions (property, mortgage, ...)


class AccountType(str, enum.Enum):
    CHECKING = "checking"
    SAVINGS = "savings"
    CREDIT = "credit"  # credit card (limit vs debt handled specially)
    INVESTMENT = "investment"
    CASH = "cash"
    PROPERTY = "property"  # real estate & other illiquid assets
    VEHICLE = "vehicle"  # car etc. — illiquid asset that depreciates over time
    MORTGAGE = "mortgage"  # home loan (liability)
    LOAN = "loan"  # other loans (liability)
    OTHER = "other"


class Source(str, enum.Enum):
    OPEN_BANKING = "open_banking"
    CSV = "csv"
    MANUAL = "manual"


class Account(SQLModel, table=True):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("bank", "external_id", name="uq_account_bank_external"),)

    id: int | None = Field(default=None, primary_key=True)
    bank: Bank
    name: str
    iban: str | None = Field(default=None, index=True)
    # Enable Banking account uid, or a stable local key for CSV-only accounts.
    external_id: str | None = Field(default=None, index=True)
    currency: str = Field(default="PLN")
    type: AccountType = Field(default=AccountType.CHECKING)
    active: bool = Field(default=True)
    created_at: dt.datetime = Field(default_factory=utcnow)


class Balance(SQLModel, table=True):
    """Point-in-time account balance snapshot — the basis for net worth history."""

    __tablename__ = "balances"
    __table_args__ = (
        UniqueConstraint("account_id", "date", "source", name="uq_balance_day"),
    )

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    date: dt.date = Field(index=True)
    amount: Decimal = Field(sa_column=Column(DecimalText, nullable=False))
    currency: str = Field(default="PLN")
    source: Source = Field(default=Source.OPEN_BANKING)
    created_at: dt.datetime = Field(default_factory=utcnow)
