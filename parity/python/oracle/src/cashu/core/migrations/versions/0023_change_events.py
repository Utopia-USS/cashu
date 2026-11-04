"""Change events for the open app (P10 live data): ``change_events``.

Revision ID: 0023_change_events
Revises: 0022_topic_thesis_rejected
Create Date: 2026-10-09

An append-only, short-lived log (pruned after a day) of committed changes: every process writes a row
in the same transaction as the change (``core/events.py``), the app server tails it by id and pushes
the events to the window over SSE. No foreign keys.

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports); ``tests/test_migrations.py``
checks the result equals the models' ``create_all``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0023_change_events"
down_revision: str | Sequence[str] | None = "0022_topic_thesis_rejected"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "change_events"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("ts", sa.DateTime(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("entity", sa.String(), nullable=False),
        sa.Column("op", sa.String(), nullable=False),
        sa.Column("ref", sa.String(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_change_events_ts", TABLE, ["ts"])
    op.create_index("ix_change_events_profile_id", TABLE, ["profile_id"])


def downgrade() -> None:
    if TABLE in set(sa.inspect(op.get_bind()).get_table_names()):
        op.drop_table(TABLE)  # its indexes go with it
