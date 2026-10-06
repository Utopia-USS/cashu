"""Loans: last-update time and installment matching.

Revision ID: 0004_loan_payments
Revises: 0003_registry_ids
Create Date: 2026-10-04

- ``loans.updated_at`` (when the terms were last set; existing rows: their
  ``created_at``): a balance recorded for the loan account after it wins over the
  computed schedule from its date on, instead of being silently ignored.
- ``loans.payment_iban`` / ``loans.payment_text``: how the budget recognises the
  loan's installments among bank transactions (both optional).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004_loan_payments"
down_revision: str | Sequence[str] | None = "0003_registry_ids"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("loans") as batch:
        batch.add_column(sa.Column("updated_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("payment_iban", sa.String(), nullable=True))
        batch.add_column(sa.Column("payment_text", sa.String(), nullable=True))
    op.get_bind().execute(sa.text("UPDATE loans SET updated_at = created_at"))
    with op.batch_alter_table("loans") as batch:
        batch.alter_column("updated_at", existing_type=sa.DateTime(), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("loans") as batch:
        batch.drop_column("payment_text")
        batch.drop_column("payment_iban")
        batch.drop_column("updated_at")
