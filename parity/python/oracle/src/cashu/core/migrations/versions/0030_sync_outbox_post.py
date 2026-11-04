"""Sync outbox ``post``: the full row after an insert or update (S31a P-B).

Revision ID: 0030_sync_outbox_post
Revises: 0029_sync_inbound
Create Date: 2026-11-01

TRANSITIONAL(S49). ``sync_outbox.post`` (nullable JSON): for ``insert`` and ``update`` rows every column
of the changed row as stored (all but ``profile_id``, derived and excluded columns included), so the
shipper stamps events with the row's own timestamp columns and builds whole-value events from it. NULL
for ``delete`` (its ``fields`` hold the last state) and explicit ops. Adds only a ``sync_*`` column.

Numbered after the owner's 0027_alert_tag and the renumbered sync chain (0028_sync_outbox,
0029_sync_inbound).

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports); ``tests/test_migrations.py``
checks the result equals the models' ``create_all``. A plain ALTER TABLE ADD COLUMN (the column comes
last, no rebuild).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0030_sync_outbox_post"
down_revision: str | Sequence[str] | None = "0029_sync_inbound"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "sync_outbox"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("post", sa.JSON(), nullable=True))


def downgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    if "post" in columns:
        op.drop_column(TABLE, "post")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
