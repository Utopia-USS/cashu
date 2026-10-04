"""Budget tables: bank transactions, learned category rules, import audit."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import JSON, Field, SQLModel

from finanse.core.models import Bank, Source, profile_fk_column, utcnow
from finanse.core.types import DecimalText


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
    created_at: dt.datetime = Field(default_factory=utcnow)


class CategoryRule(SQLModel, table=True):
    """Learned merchant → category mapping (the categorization "model").

    One row per (profile, merchant_key): learned rules are per profile, the seed
    taxonomy is global. Manual corrections are `locked` and win over
    (never overwritten by) LLM/seed guesses; LLM answers are cached here so a
    given merchant is classified at most once.
    """

    __tablename__ = "category_rules"
    __table_args__ = (
        UniqueConstraint("profile_id", "merchant_key", name="uq_rule_profile_merchant"),
    )

    id: int | None = Field(default=None, primary_key=True)
    merchant_key: str = Field(index=True)
    category: str
    source: str = "manual"  # manual | llm
    locked: bool = False  # manual corrections are locked
    created_at: dt.datetime = Field(default_factory=utcnow)
    profile_id: int = Field(sa_column=profile_fk_column("category_rules"))


class ImportBatch(SQLModel, table=True):
    """Audit record for every sync run or CSV import."""

    __tablename__ = "import_batches"

    id: int | None = Field(default=None, primary_key=True)
    source: Source
    bank: Bank | None = None
    account_id: int | None = None
    filename: str | None = None
    started_at: dt.datetime = Field(default_factory=utcnow)
    finished_at: dt.datetime | None = None
    num_seen: int = 0
    num_inserted: int = 0
    num_duplicates: int = 0
    notes: str | None = None
    profile_id: int = Field(sa_column=profile_fk_column("import_batches"))
