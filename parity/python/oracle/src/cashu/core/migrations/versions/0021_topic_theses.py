"""Topic theses (P9): the owner's thesis on a market topic (segment), one per profile and topic.

Revision ID: 0021_topic_theses
Revises: 0020_power_segment
Create Date: 2026-10-09

New table only (no existing table is altered):

- ``inv_topic_theses``: profile (named FK, indexed), ``segment`` (catalog key of
  ``modules/investments/research/segments.py``), ``thesis`` (<= 600 characters, checked by the service),
  ``invalidation`` (nullable, <= 400), ``draft`` (an agent proposal waiting for the owner),
  ``created_by`` (``owner`` | ``agent``), ``core_changed_at``, ``created_at``, ``updated_at``;
  UNIQUE(profile_id, segment).

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Downgrade
refuses while the table holds a thesis (dropping it would lose the owner's text), then drops it.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0021_topic_theses"
down_revision: str | Sequence[str] | None = "0020_power_segment"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_topic_theses"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("segment", sa.String(), nullable=False),
        sa.Column("thesis", sa.String(), nullable=False),
        sa.Column("invalidation", sa.String(), nullable=True),
        sa.Column("draft", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("core_changed_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], name=f"fk_{TABLE}_profile_id"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "segment", name="uq_inv_topic_thesis"),
    )
    op.create_index(f"ix_{TABLE}_profile_id", TABLE, ["profile_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in set(sa.inspect(bind).get_table_names()):
        return  # already gone (a refused downgrade further down may have left the version here)
    if bind.execute(sa.text(f"SELECT 1 FROM {TABLE} LIMIT 1")).first() is not None:
        raise RuntimeError(f"0021_topic_theses: cannot downgrade, {TABLE} holds topic theses")
    op.drop_table(TABLE)  # drops its index too
