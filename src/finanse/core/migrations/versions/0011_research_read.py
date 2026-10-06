"""Unread research notes (F8, home v3 Q10).

Revision ID: 0011_research_read
Revises: 0010_account_removed
Create Date: 2026-10-06

- ``research_notes.read_at`` (nullable timestamp): when the owner opened the note (the asset drawer's
  research section, the research page). NULL = unread; the home marks instruments with new agent notes.
  Backfill ``read_at = created_at``: nothing lights up on upgrade.
- Index ``ix_research_notes_unread (profile_id, instrument_id, read_at)`` for the grouped unread count.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. A plain
ALTER TABLE ADD COLUMN (the column comes last, no rebuild). Downgrade drops the index and the column
(read marks are a convenience, nothing else depends on them).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011_research_read"
down_revision: str | Sequence[str] | None = "0010_account_removed"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "ix_research_notes_unread"


def upgrade() -> None:
    op.add_column("research_notes", sa.Column("read_at", sa.DateTime(), nullable=True))
    op.execute("UPDATE research_notes SET read_at = created_at WHERE read_at IS NULL")
    op.create_index(
        INDEX, "research_notes", ["profile_id", "instrument_id", "read_at"], unique=False
    )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("research_notes")}
    if "read_at" not in columns:
        return
    indexes = {i["name"] for i in sa.inspect(bind).get_indexes("research_notes")}
    if INDEX in indexes:
        op.drop_index(INDEX, table_name="research_notes")
    op.drop_column("research_notes", "read_at")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
