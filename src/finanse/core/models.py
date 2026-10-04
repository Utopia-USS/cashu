"""Core tables: profiles, their enabled modules, accounts and balance snapshots.

A single physical bank account maps to exactly one `Account` row, regardless of
which source (Open Banking or CSV) produced the data — e.g. legacy Santander
CSV exports and new Erste Open Banking data land in the same Account. Every
module hangs its own data off accounts (transactions, loans, depreciation, ...).
"""

from __future__ import annotations

import datetime as dt
import enum
from decimal import Decimal

from sqlalchemy import Column, ForeignKey, Integer, UniqueConstraint
from sqlmodel import Field, SQLModel

from .types import DecimalText


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class AccountType(enum.StrEnum):
    """Built-in account type ids (the upstream enum values). ``accounts.type`` is a
    plain string: modules register their types, with net-worth semantics, in
    ``core.account_types``."""

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


def profile_fk_column(table: str) -> Column:
    """``profile_id`` of a profile-scoped table: NOT NULL, indexed, named FK (so a
    migration can drop it)."""
    return Column(
        "profile_id",
        Integer,
        ForeignKey("profiles.id", name=f"fk_{table}_profile_id"),
        nullable=False,
        index=True,
    )


class Profile(SQLModel, table=True):
    """A person or household: owns accounts, learned rules and module choices."""

    __tablename__ = "profiles"

    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(index=True, unique=True)  # ASCII, used in URLs and the CLI
    name: str
    base_currency: str = Field(default="PLN")  # net worth headline; no FX conversion yet
    mcp_privacy: str = Field(default="strict")  # strict | amounts (what MCP tools may send)
    created_at: dt.datetime = Field(default_factory=utcnow)


class ProfileModule(SQLModel, table=True):
    """A module chosen for a profile. Disabling keeps the row (and the data)."""

    __tablename__ = "profile_modules"

    profile_id: int = Field(foreign_key="profiles.id", primary_key=True)
    module_id: str = Field(primary_key=True)
    enabled: bool = Field(default=True)
    enabled_at: dt.datetime = Field(default_factory=utcnow)


class Account(SQLModel, table=True):
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint(
            "profile_id", "bank", "external_id", name="uq_account_profile_bank_external"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    bank: str  # institution id (core.institutions), e.g. "mbank", "manual"
    name: str
    iban: str | None = Field(default=None, index=True)
    # Enable Banking account uid, or a stable local key for CSV-only accounts.
    external_id: str | None = Field(default=None, index=True)
    currency: str = Field(default="PLN")
    type: str = Field(default=AccountType.CHECKING)  # account type id (core.account_types)
    active: bool = Field(default=True)
    created_at: dt.datetime = Field(default_factory=utcnow)
    profile_id: int = Field(sa_column=profile_fk_column("accounts"))


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
