"""Rejected topic-thesis drafts (P9 review fix): ``inv_topic_theses.rejected_at``.

Revision ID: 0022_topic_thesis_rejected
Revises: 0021_topic_theses
Create Date: 2026-10-09

- ``inv_topic_theses.rejected_at`` (nullable timestamp): set when the owner deletes a topic thesis
  (his own or the research agent's draft); the row stays as a rejection (read as "no thesis") so the agent does not propose a
  draft for that topic again for 90 days. NULL = a live thesis or draft.

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Plain ALTER
TABLE ADD COLUMN (the column comes last, no rebuild). Downgrade deletes the rejection rows (they hold
no live thesis) and drops the column.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0022_topic_thesis_rejected"
down_revision: str | Sequence[str] | None = "0021_topic_theses"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_topic_theses"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("rejected_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in set(sa.inspect(bind).get_table_names()):
        return
    if "rejected_at" not in {c["name"] for c in sa.inspect(bind).get_columns(TABLE)}:
        return  # already gone (a refused downgrade further down may have left the version here)
    bind.execute(sa.text(f"DELETE FROM {TABLE} WHERE rejected_at IS NOT NULL"))
    op.drop_column(TABLE, "rejected_at")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
