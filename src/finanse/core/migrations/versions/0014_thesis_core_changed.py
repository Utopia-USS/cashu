"""When a thesis' core last changed (P2, strategy hints).

Revision ID: 0014_thesis_core_changed
Revises: 0013_instrument_plan
Create Date: 2026-10-06

- ``inv_theses.core_changed_at`` (nullable timestamp, UTC): the last change of a core field
  (``entry_type``, ``thesis``, ``invalidation``); edits of ``exit_plan`` / ``size_plan`` leave it.
  Thesis health tags research notes stored before it as possibly outdated (``predates_thesis``); it
  never drops them. Backfill ``core_changed_at = updated_at`` (the best known moment); NULL reads as
  ``updated_at``.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. A plain
ALTER TABLE ADD COLUMN (the column comes last, no rebuild). Downgrade drops the column (derived
bookkeeping: ``updated_at`` stays the fallback).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014_thesis_core_changed"
down_revision: str | Sequence[str] | None = "0013_instrument_plan"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_theses"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("core_changed_at", sa.DateTime(), nullable=True))
    op.execute(f"UPDATE {TABLE} SET core_changed_at = updated_at WHERE core_changed_at IS NULL")


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}
    if "core_changed_at" in columns:
        op.drop_column(TABLE, "core_changed_at")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
