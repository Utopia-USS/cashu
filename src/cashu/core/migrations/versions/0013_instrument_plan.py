"""The model recommendation per instrument (P1, legacy plan storage).

Revision ID: 0013_instrument_plan
Revises: 0012_decision_signals
Create Date: 2026-10-06

- ``inv_profile_instruments.plan`` (nullable text, ``domain.PLAN_VALUES``): what the owner decided to
  do with the instrument (buy_asap, buy, hold, reduce, exit_asap). NULL = no plan. Set only by the
  owner in the app.
- ``inv_profile_instruments.plan_at`` (nullable timestamp, UTC): when the plan was last written;
  cleared with the plan.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Plain
ALTER TABLE ADD COLUMN (both columns come last, no rebuild). Downgrade refuses while a plan is set
(it is the owner's decision, not derived data), then drops both columns.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013_instrument_plan"
down_revision: str | Sequence[str] | None = "0012_decision_signals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_profile_instruments"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("plan", sa.String(), nullable=True))
    op.add_column(TABLE, sa.Column("plan_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}
    if "plan" in columns:
        planned = bind.execute(
            sa.text(f"SELECT 1 FROM {TABLE} WHERE plan IS NOT NULL LIMIT 1")
        ).first()
        if planned is not None:
            raise RuntimeError(
                "0013_instrument_plan: cannot downgrade, an instrument has a plan "
                "(clear the plans first, the older schema cannot hold them)"
            )
        op.drop_column(TABLE, "plan")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
    if "plan_at" in columns:
        op.drop_column(TABLE, "plan_at")
