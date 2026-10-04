"""Baseline: the upstream schema (models as of "Initial public release").

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-04

Equal to what ``SQLModel.metadata.create_all`` produced before Alembic, including
the two columns the old ``db._ensure_columns`` added (``transactions.category_source``,
``loans.origination_date``). Databases created that way are stamped at this
revision instead of being recreated (see ``finanse.core.migrations``).

Types are spelled with plain SQLAlchemy types so this file never changes when the
models do: money columns are exact decimal text (``finanse.types.DecimalText`` ->
VARCHAR), enums are stored by member NAME (VARCHAR sized to the longest name).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_baseline"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BANK = sa.Enum("MBANK", "ERSTE", "PEKAO", "MANUAL", name="bank")
ACCOUNT_TYPE = sa.Enum(
    "CHECKING", "SAVINGS", "CREDIT", "INVESTMENT", "CASH",
    "PROPERTY", "VEHICLE", "MORTGAGE", "LOAN", "OTHER",
    name="accounttype",
)
SOURCE = sa.Enum("OPEN_BANKING", "CSV", "MANUAL", name="source")
DECIMAL_TEXT = sa.String  # finanse.types.DecimalText stores Decimals as exact text

# Creation order respects foreign keys.
TABLES = (
    "accounts",
    "category_rules",
    "import_batches",
    "balances",
    "depreciations",
    "loans",
    "transactions",
)


def create_schema(ops, only: set[str] | frozenset[str] | None = None) -> None:
    """Create the baseline tables (all, or just ``only``) with ``ops`` (``op`` or an
    ``alembic.operations.Operations``; the pre-baseline shim uses the latter)."""

    def want(name: str) -> bool:
        return only is None or name in only

    if want("accounts"):
        ops.create_table(
            "accounts",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("bank", BANK, nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("iban", sa.String(), nullable=True),
            sa.Column("external_id", sa.String(), nullable=True),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("type", ACCOUNT_TYPE, nullable=False),
            sa.Column("active", sa.Boolean(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("bank", "external_id", name="uq_account_bank_external"),
        )
        ops.create_index("ix_accounts_external_id", "accounts", ["external_id"])
        ops.create_index("ix_accounts_iban", "accounts", ["iban"])

    if want("category_rules"):
        ops.create_table(
            "category_rules",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("merchant_key", sa.String(), nullable=False),
            sa.Column("category", sa.String(), nullable=False),
            sa.Column("source", sa.String(), nullable=False),
            sa.Column("locked", sa.Boolean(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("merchant_key", name="uq_rule_merchant"),
        )
        ops.create_index("ix_category_rules_merchant_key", "category_rules", ["merchant_key"])

    if want("import_batches"):
        ops.create_table(
            "import_batches",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("source", SOURCE, nullable=False),
            sa.Column("bank", BANK, nullable=True),
            sa.Column("account_id", sa.Integer(), nullable=True),
            sa.Column("filename", sa.String(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("num_seen", sa.Integer(), nullable=False),
            sa.Column("num_inserted", sa.Integer(), nullable=False),
            sa.Column("num_duplicates", sa.Integer(), nullable=False),
            sa.Column("notes", sa.String(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )

    if want("balances"):
        ops.create_table(
            "balances",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("date", sa.Date(), nullable=False),
            sa.Column("amount", DECIMAL_TEXT(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("source", SOURCE, nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("account_id", "date", "source", name="uq_balance_day"),
            sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        )
        ops.create_index("ix_balances_account_id", "balances", ["account_id"])
        ops.create_index("ix_balances_date", "balances", ["date"])

    if want("depreciations"):
        ops.create_table(
            "depreciations",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("purchase_price", DECIMAL_TEXT(), nullable=False),
            sa.Column("purchase_date", sa.Date(), nullable=False),
            sa.Column("annual_rate", DECIMAL_TEXT(), nullable=False),
            sa.Column("floor", DECIMAL_TEXT(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("account_id", name="uq_depreciation_account"),
            sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        )
        ops.create_index("ix_depreciations_account_id", "depreciations", ["account_id"])

    if want("loans"):
        ops.create_table(
            "loans",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("principal", DECIMAL_TEXT(), nullable=False),
            sa.Column("annual_rate", DECIMAL_TEXT(), nullable=False),
            sa.Column("term_months", sa.Integer(), nullable=False),
            sa.Column("start_date", sa.Date(), nullable=False),
            sa.Column("origination_date", sa.Date(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("account_id", name="uq_loan_account"),
            sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        )
        ops.create_index("ix_loans_account_id", "loans", ["account_id"])

    if want("transactions"):
        ops.create_table(
            "transactions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("booking_date", sa.Date(), nullable=False),
            sa.Column("value_date", sa.Date(), nullable=True),
            sa.Column("amount", DECIMAL_TEXT(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("counterparty_name", sa.String(), nullable=True),
            sa.Column("counterparty_iban", sa.String(), nullable=True),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("reference", sa.String(), nullable=True),
            sa.Column("bank_transaction_id", sa.String(), nullable=True),
            sa.Column("source", SOURCE, nullable=False),
            sa.Column("dedup_hash", sa.String(), nullable=False),
            sa.Column("occurrence", sa.Integer(), nullable=False),
            sa.Column("transfer_group_id", sa.String(), nullable=True),
            sa.Column("is_internal_transfer", sa.Boolean(), nullable=False),
            sa.Column("category", sa.String(), nullable=True),
            sa.Column("category_source", sa.String(), nullable=True),
            sa.Column("raw", sa.JSON(), nullable=True),
            sa.Column("import_batch_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "account_id", "dedup_hash", "occurrence", name="uq_txn_dedup"
            ),
            sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
            sa.ForeignKeyConstraint(["import_batch_id"], ["import_batches.id"]),
        )
        for col in (
            "account_id",
            "bank_transaction_id",
            "booking_date",
            "category",
            "counterparty_iban",
            "dedup_hash",
            "transfer_group_id",
        ):
            ops.create_index(f"ix_transactions_{col}", "transactions", [col])


def upgrade() -> None:
    create_schema(op)


def downgrade() -> None:
    for table in reversed(TABLES):  # SQLite drops a table's indexes with it
        op.drop_table(table)
