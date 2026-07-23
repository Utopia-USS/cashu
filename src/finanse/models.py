"""Normalized data model shared by every ingestion source.

A single physical bank account maps to exactly one `Account` row, regardless of
which source (Open Banking or CSV) produced the data — e.g. legacy Santander
CSV exports and new Erste Open Banking data land in the same Account.
"""

from __future__ import annotations

import datetime as dt
import enum
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import JSON, Field, SQLModel

from .types import DecimalText


def _utcnow() -> dt.datetime:
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
    created_at: dt.datetime = Field(default_factory=_utcnow)


class Transaction(SQLModel, table=True):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint(
            "account_id", "dedup_hash", "occurrence", name="uq_txn_dedup"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)

    booking_date: dt.date = Field(index=True)
    value_date: dt.date | None = None

    # Signed: negative = outflow/expense, positive = inflow/income.
    amount: Decimal = Field(sa_column=Column(DecimalText, nullable=False))
    currency: str = Field(default="PLN")

    counterparty_name: str | None = None
    counterparty_iban: str | None = Field(default=None, index=True)
    description: str | None = None
    reference: str | None = None

    # Bank-provided stable id (entryReference / transactionId) when available.
    bank_transaction_id: str | None = Field(default=None, index=True)

    source: Source
    # Content hash for cross-source dedup; `occurrence` disambiguates
    # genuinely identical same-day transactions.
    dedup_hash: str = Field(index=True)
    occurrence: int = Field(default=0)

    # Internal transfer cross-referencing (mBank <-> Erste etc.)
    transfer_group_id: str | None = Field(default=None, index=True)
    is_internal_transfer: bool = Field(default=False)

    # Filled by the categorization engine.
    category: str | None = Field(default=None, index=True)
    # How the category was assigned: transfer | manual | llm | keyword | subscription | default
    category_source: str | None = Field(default=None)

    raw: dict = Field(default_factory=dict, sa_column=Column(JSON))
    import_batch_id: int | None = Field(default=None, foreign_key="import_batches.id")
    created_at: dt.datetime = Field(default_factory=_utcnow)


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
    created_at: dt.datetime = Field(default_factory=_utcnow)


class CategoryRule(SQLModel, table=True):
    """Learned merchant → category mapping (the categorization "model").

    One row per merchant_key. Manual corrections are `locked` and win over
    (never overwritten by) LLM/seed guesses; LLM answers are cached here so a
    given merchant is classified at most once.
    """

    __tablename__ = "category_rules"
    __table_args__ = (UniqueConstraint("merchant_key", name="uq_rule_merchant"),)

    id: int | None = Field(default=None, primary_key=True)
    merchant_key: str = Field(index=True)
    category: str
    source: str = "manual"  # manual | llm
    locked: bool = False  # manual corrections are locked
    created_at: dt.datetime = Field(default_factory=_utcnow)


class Loan(SQLModel, table=True):
    """Amortization terms for a MORTGAGE/LOAN account (the payoff simulator)."""

    __tablename__ = "loans"
    __table_args__ = (UniqueConstraint("account_id", name="uq_loan_account"),)

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    principal: Decimal = Field(sa_column=Column(DecimalText, nullable=False))
    annual_rate: Decimal = Field(sa_column=Column(DecimalText, nullable=False))  # percent, e.g. 6.27
    term_months: int
    start_date: dt.date  # first installment date
    origination_date: dt.date | None = None  # disbursement (debt exists from here)
    created_at: dt.datetime = Field(default_factory=_utcnow)


class Depreciation(SQLModel, table=True):
    """Depreciation terms for a VEHICLE (or other depreciating asset) account.

    Value is modeled as declining-balance from the purchase price:
    ``value(t) = max(floor, purchase_price * (1 - annual_rate/100) ** years)``.
    """

    __tablename__ = "depreciations"
    __table_args__ = (UniqueConstraint("account_id", name="uq_depreciation_account"),)

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    purchase_price: Decimal = Field(sa_column=Column(DecimalText, nullable=False))
    purchase_date: dt.date
    annual_rate: Decimal = Field(sa_column=Column(DecimalText, nullable=False))  # percent, e.g. 15.0
    floor: Decimal | None = Field(default=None, sa_column=Column(DecimalText, nullable=True))
    created_at: dt.datetime = Field(default_factory=_utcnow)


class ImportBatch(SQLModel, table=True):
    """Audit record for every sync run or CSV import."""

    __tablename__ = "import_batches"

    id: int | None = Field(default=None, primary_key=True)
    source: Source
    bank: Bank | None = None
    account_id: int | None = None
    filename: str | None = None
    started_at: dt.datetime = Field(default_factory=_utcnow)
    finished_at: dt.datetime | None = None
    num_seen: int = 0
    num_inserted: int = 0
    num_duplicates: int = 0
    notes: str | None = None
