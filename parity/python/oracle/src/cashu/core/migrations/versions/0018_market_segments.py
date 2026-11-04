"""Market segments (P5): the segment of an instrument per profile and segment research notes.

Revision ID: 0018_market_segments
Revises: 0017_watchlist_removed_at
Create Date: 2026-10-08

- ``inv_profile_instruments.segment`` (nullable text): the market segment (catalog key in
  ``research/segments.py``) the owner or the research agent set for the instrument in this profile;
  NULL = not set (the automatic guess applies).
- ``inv_profile_instruments.segment_by`` (nullable text): who set it, ``owner`` (the app) or ``agent``
  (MCP); the agent never changes the owner's choice.
- ``research_notes.segment`` (nullable text): the segment a segment note is about (no instrument, no
  candidate).
- No backfill; existing ``theme`` values stay as they are (research is never dropped).

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Plain
ALTER TABLE ADD COLUMN (the columns come last, no rebuild). Downgrade refuses while a segment is set
or a segment note exists (dropping the columns would lose them), then drops both columns.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018_market_segments"
down_revision: str | Sequence[str] | None = "0017_watchlist_removed_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("inv_profile_instruments", "research_notes")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(table, sa.Column("segment", sa.String(), nullable=True))
    op.add_column(TABLES[0], sa.Column("segment_by", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    present = [
        t for t in TABLES if "segment" in {c["name"] for c in sa.inspect(bind).get_columns(t)}
    ]
    for table in present:
        used = bind.execute(
            sa.text(f"SELECT 1 FROM {table} WHERE segment IS NOT NULL LIMIT 1")
        ).first()
        if used is not None:
            raise RuntimeError(
                f"0018_market_segments: cannot downgrade, {table} has segments set "
                "(dropping the column would lose them)"
            )
    for table in present:
        if table == TABLES[0]:
            columns = {c["name"] for c in sa.inspect(bind).get_columns(table)}
            if "segment_by" in columns:
                op.drop_column(table, "segment_by")
        op.drop_column(table, "segment")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
