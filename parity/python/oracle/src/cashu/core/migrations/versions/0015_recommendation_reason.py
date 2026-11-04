"""A short reason for the model recommendation.

Revision ID: 0015_recommendation_reason
Revises: 0014_thesis_core_changed
Create Date: 2026-10-06

- ``inv_profile_instruments.plan_reason`` (nullable text, at most 280 characters by the writers): the
  one or two sentences the model gives with its recommendation (legacy column family ``plan``);
  written and cleared together with ``plan``.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. A plain
ALTER TABLE ADD COLUMN (the column comes last, no rebuild). Downgrade drops the column.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015_recommendation_reason"
down_revision: str | Sequence[str] | None = "0014_thesis_core_changed"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_profile_instruments"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("plan_reason", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}
    if "plan_reason" in columns:
        op.drop_column(TABLE, "plan_reason")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
