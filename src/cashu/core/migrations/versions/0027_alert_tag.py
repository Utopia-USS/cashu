"""A free-text tag on an alert.

Revision ID: 0027_alert_tag
Revises: 0026_thesis_exit_plan_changed_at
Create Date: 2026-10-31

The owner or the research agent labels an alert with a short lowercase tag ("cena", "wydarzenie",
"rsi", ...) shown as a chip next to it; null lets the UI derive a default from the kind. The chip's
colour follows the alert's state and is never stored.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027_alert_tag"
down_revision: str | Sequence[str] | None = "0026_thesis_exit_plan_changed_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "alerts"
COLUMN = "tag"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column(COLUMN, sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in set(sa.inspect(bind).get_table_names()):
        return
    if COLUMN not in {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}:
        # idempotent: a refused downgrade further down the chain may leave the version here with
        # the column already gone
        return
    held = bind.execute(
        sa.text(f"SELECT 1 FROM {TABLE} WHERE {COLUMN} IS NOT NULL LIMIT 1")
    ).first()
    if held is not None:
        raise RuntimeError("0027_alert_tag: cannot downgrade, alert tags exist")
    # plain DROP COLUMN (SQLite >= 3.35), no table rebuild
    op.drop_column(TABLE, COLUMN)
