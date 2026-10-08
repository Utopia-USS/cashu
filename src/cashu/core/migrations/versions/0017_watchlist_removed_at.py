"""Watchlist soft remove: one entry per (profile, instrument) forever.

Revision ID: 0017_watchlist_removed_at
Revises: 0016_connectors
Create Date: 2026-10-08

- ``watchlist_items.removed_at`` (nullable): set when the owner stops watching an instrument instead of
  deleting the row. A removed row is never watched (no daily price fetch, not listed), but it keeps the
  instrument referenced by the profile, and adding the instrument again restores the same row (same id,
  note and tags). ``uq_watchlist_profile_instrument`` stays: exactly one row per (profile, instrument).

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. A plain
ALTER TABLE ADD COLUMN (the column comes last, no rebuild). Downgrade refuses while a row is removed
(dropping the column would bring it back as watched), then drops the column.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0017_watchlist_removed_at"
down_revision: str | Sequence[str] | None = "0016_connectors"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "watchlist_items"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("removed_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}
    if "removed_at" not in columns:
        return
    removed = bind.execute(
        sa.text(f"SELECT 1 FROM {TABLE} WHERE removed_at IS NOT NULL LIMIT 1")
    ).first()
    if removed is not None:
        raise RuntimeError(
            "0017_watchlist_removed_at: cannot downgrade, some watchlist rows are removed "
            "(dropping the column would make them watched again)"
        )
    op.drop_column(TABLE, "removed_at")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
