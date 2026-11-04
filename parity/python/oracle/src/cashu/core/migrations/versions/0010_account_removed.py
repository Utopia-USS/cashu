"""Removable manual positions (F7 MB2).

Revision ID: 0010_account_removed
Revises: 0009_asset_details
Create Date: 2026-10-05

- ``accounts.removed_at`` (nullable timestamp): set when the owner removes a manual position or a
  vehicle (``DELETE /assets/manual/{id}``). The account, its balances and details stay so it can be
  restored; every view and net worth (current and history) leave it out while it is set. The existing
  ``active`` flag does not fit: net worth history still counts an inactive account.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. A plain
ALTER TABLE ADD COLUMN (no rebuild of ``accounts``, which many tables reference). Downgrade refuses
while a position is removed (dropping the column would bring it back), then drops the column.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010_account_removed"
down_revision: str | Sequence[str] | None = "0009_asset_details"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("removed_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("accounts")}
    if "removed_at" not in columns:
        return  # already gone (a refused downgrade further down may have left the version here)
    removed = bind.execute(
        sa.text("SELECT 1 FROM accounts WHERE removed_at IS NOT NULL LIMIT 1")
    ).first()
    if removed is not None:
        raise RuntimeError(
            "0010_account_removed: cannot downgrade, removed positions would reappear "
            "(restore or delete them first)"
        )
    op.drop_column("accounts", "removed_at")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
