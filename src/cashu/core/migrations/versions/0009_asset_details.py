"""Manual position notes (F7 OB5).

Revision ID: 0009_asset_details
Revises: 0008_research_planned
Create Date: 2026-10-05

- New table ``asset_details`` (assets module): one row per manual position account with the owner's
  note (one line, max 500 characters, checked by the service), ``created_at`` / ``updated_at``.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Downgrade
refuses while the table holds a note, then drops it.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009_asset_details"
down_revision: str | Sequence[str] | None = "0008_research_planned"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "asset_details",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_asset_details_account_id", "asset_details", ["account_id"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    if "asset_details" not in sa.inspect(bind).get_table_names():
        return  # already gone (a refused downgrade further down may have left the version here)
    if bind.execute(sa.text("SELECT 1 FROM asset_details LIMIT 1")).first() is not None:
        raise RuntimeError("0009_asset_details: cannot downgrade, asset_details holds notes")
    op.drop_table("asset_details")  # drops its index too
