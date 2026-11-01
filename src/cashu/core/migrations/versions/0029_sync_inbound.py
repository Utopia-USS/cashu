"""Sync inbound applier (S31b): ``sync_inbound`` (applied / parked event ids) and ``sync_clock``.

Revision ID: 0029_sync_inbound
Revises: 0028_sync_outbox
Create Date: 2026-10-31

TRANSITIONAL(S49). ``core/sync_apply.py`` applies events from other devices through the services:
``sync_inbound`` makes it idempotent by event id and holds parked events for a retry, ``sync_clock``
keeps per field the ``(hlc, eid)`` of the last inbound write (LWW-F). No foreign keys.

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports); ``tests/test_migrations.py``
checks the result equals the models' ``create_all``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0029_sync_inbound"
down_revision: str | Sequence[str] | None = "0028_sync_outbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INBOUND, CLOCK = "sync_inbound", "sync_clock"


def upgrade() -> None:
    op.create_table(
        INBOUND,
        sa.Column("eid", sa.String(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("hlc", sa.String(), nullable=False),
        sa.Column("gid", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("digest", sa.String(), nullable=False),
        sa.Column("body", sa.JSON(), nullable=True),
        sa.Column("received_at", sa.DateTime(), nullable=False),
        sa.Column("settled_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("eid"),
    )
    op.create_index("ix_sync_inbound_status", INBOUND, ["status"])
    op.create_table(
        CLOCK,
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("table_name", sa.String(), nullable=False),
        sa.Column("local_id", sa.String(), nullable=False),
        sa.Column("field", sa.String(), nullable=False),
        sa.Column("hlc", sa.String(), nullable=False),
        sa.Column("eid", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("profile_id", "table_name", "local_id", "field"),
    )


def downgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in (CLOCK, INBOUND):
        if table in existing:
            op.drop_table(table)  # its indexes go with it
