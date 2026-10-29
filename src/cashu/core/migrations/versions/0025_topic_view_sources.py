"""Sources of the market view on a topic thesis.

Revision ID: 0025_topic_view_sources
Revises: 0024_topic_market_view
Create Date: 2026-10-10

The topic outlook rests on quantitative industry estimates of market / demand growth (P11 owner
decision 2026-10-10), so the view carries its own cited sources: a JSON list of
``{title, url, publisher, published_at}``, null when the view has none.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025_topic_view_sources"
down_revision: str | Sequence[str] | None = "0024_topic_market_view"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_topic_theses"
COLUMN = "view_sources"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column(COLUMN, sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in set(sa.inspect(bind).get_table_names()):
        return
    present = {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}
    if COLUMN not in present:
        # idempotent: a refused downgrade further down the chain may leave the version here with
        # the column already gone
        return
    held = bind.execute(
        sa.text(f"SELECT 1 FROM {TABLE} WHERE {COLUMN} IS NOT NULL LIMIT 1")
    ).first()
    if held is not None:
        raise RuntimeError("0025_topic_view_sources: cannot downgrade, topic view sources exist")
    # plain DROP COLUMN (SQLite >= 3.35), no table rebuild
    op.drop_column(TABLE, COLUMN)
