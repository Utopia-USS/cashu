"""When a thesis's exit plan last changed.

Revision ID: 0026_thesis_exit_plan_changed_at
Revises: 0025_topic_view_sources
Create Date: 2026-10-30

The review deck's "Do decyzji" card treats a subject whose exit plan changed after its signals as a
decision already taken ("W toku"). ``updated_at`` moves on every save (marking the thesis reviewed, the
research agent's upsert), so the plan gets its own timestamp. Existing plans start at ``updated_at``,
the best known bound.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026_thesis_exit_plan_changed_at"
down_revision: str | Sequence[str] | None = "0025_topic_view_sources"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_theses"
COLUMN = "exit_plan_changed_at"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column(COLUMN, sa.DateTime(), nullable=True))
    op.execute(
        sa.text(f"UPDATE {TABLE} SET {COLUMN} = updated_at WHERE exit_plan IS NOT NULL AND exit_plan != ''")
    )


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in set(sa.inspect(bind).get_table_names()):
        return
    if COLUMN not in {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}:
        # idempotent: a refused downgrade further down the chain may leave the version here with
        # the column already gone
        return
    # derived data (a timestamp), safe to drop; plain DROP COLUMN (SQLite >= 3.35), no table rebuild
    op.drop_column(TABLE, COLUMN)
