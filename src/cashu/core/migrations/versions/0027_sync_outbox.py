"""Sync outbox (S30, the strangler bridge to the event log): ``sync_outbox``, ``sync_ids``, ``sync_vaults``.

Revision ID: 0027_sync_outbox
Revises: 0026_thesis_exit_plan_changed_at
Create Date: 2026-10-31

TRANSITIONAL(S49). Field-level changes of every synced table, written in the same transaction as the
change while ``CASHU_SYNC=1`` (``core/sync_outbox.py``); with the flag off nothing writes these tables.
No foreign keys.

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports); ``tests/test_migrations.py``
checks the result equals the models' ``create_all``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0027_sync_outbox"
down_revision: str | Sequence[str] | None = "0026_thesis_exit_plan_changed_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OUTBOX, IDS, VAULTS = "sync_outbox", "sync_ids", "sync_vaults"


def upgrade() -> None:
    op.create_table(
        OUTBOX,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("ts", sa.DateTime(), nullable=False),
        sa.Column("txn", sa.String(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("table_name", sa.String(), nullable=False),
        sa.Column("op", sa.String(), nullable=False),
        sa.Column("local_id", sa.String(), nullable=False),
        sa.Column("gid", sa.String(), nullable=True),
        sa.Column("fields", sa.JSON(), nullable=False),
        sa.Column("prev", sa.JSON(), nullable=True),
        sa.Column("key", sa.JSON(), nullable=True),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("acked_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sync_outbox_profile_id", OUTBOX, ["profile_id"])
    op.create_index("ix_sync_outbox_acked_at", OUTBOX, ["acked_at"])
    op.create_index("ix_sync_outbox_row", OUTBOX, ["table_name", "local_id"])
    op.create_table(
        IDS,
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("table_name", sa.String(), nullable=False),
        sa.Column("local_id", sa.String(), nullable=False),
        sa.Column("gid", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("profile_id", "table_name", "local_id"),
        sa.UniqueConstraint("profile_id", "table_name", "gid", name="uq_sync_ids_gid"),
    )
    op.create_table(
        VAULTS,
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("vault_id", sa.String(), nullable=False),
        sa.Column("linked_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("profile_id"),
        sa.UniqueConstraint("vault_id"),
    )


def downgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in (VAULTS, IDS, OUTBOX):
        if table in existing:
            op.drop_table(table)  # its indexes go with it
