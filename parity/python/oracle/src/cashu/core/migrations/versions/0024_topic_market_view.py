"""Agent market view on a topic thesis.

Revision ID: 0024_topic_market_view
Revises: 0023_change_events
Create Date: 2026-10-10

The current assessment and forward market/adoption outlook belong to the topic, directly under its
thesis, rather than to individual sourced research notes.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024_topic_market_view"
down_revision: str | Sequence[str] | None = "0023_change_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_topic_theses"


COLUMNS = ("assessment", "outlook", "view_updated_at")


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("assessment", sa.String(), nullable=True))
    op.add_column(TABLE, sa.Column("outlook", sa.String(), nullable=True))
    op.add_column(TABLE, sa.Column("view_updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in set(sa.inspect(bind).get_table_names()):
        return
    present = {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}
    if {"assessment", "outlook"} <= present:
        held = bind.execute(
            sa.text(
                f"SELECT 1 FROM {TABLE} WHERE assessment IS NOT NULL OR outlook IS NOT NULL LIMIT 1"
            )
        ).first()
        if held is not None:
            raise RuntimeError("0024_topic_market_view: cannot downgrade, topic market views exist")
    # plain DROP COLUMN (SQLite >= 3.35), no table rebuild; idempotent, because a refused downgrade
    # further down the chain may leave the version here with the columns already gone
    for column in reversed(COLUMNS):
        if column in present:
            op.drop_column(TABLE, column)
