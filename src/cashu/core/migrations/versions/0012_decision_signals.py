"""One decision, several signals (F9, asset detail Q25).

Revision ID: 0012_decision_signals
Revises: 0011_research_read
Create Date: 2026-10-06

- New table ``inv_decision_signals (decision_id, signal_id)``: the signals one decision covers (the
  asset page's single decision settles every open signal of the position). Primary key on both
  columns, ``decision_id`` cascades on delete, index ``ix_inv_decision_signals_signal_id``.
- Backfill: one link per decision with ``inv_decisions.signal_id``. That column stays (= the first
  linked signal, for older readers and the journal's grouping).

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Downgrade
refuses while a decision links a signal its ``signal_id`` column cannot hold (a decision over several
signals), then drops the table.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0012_decision_signals"
down_revision: str | Sequence[str] | None = "0011_research_read"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_decision_signals"
INDEX = "ix_inv_decision_signals_signal_id"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("decision_id", sa.Integer(), nullable=False),
        sa.Column("signal_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["decision_id"], ["inv_decisions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["signal_id"], ["inv_signals.id"]),
        sa.PrimaryKeyConstraint("decision_id", "signal_id"),
    )
    op.create_index(INDEX, TABLE, ["signal_id"], unique=False)
    op.execute(
        f"INSERT INTO {TABLE} (decision_id, signal_id) "
        "SELECT id, signal_id FROM inv_decisions WHERE signal_id IS NOT NULL"
    )


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE not in sa.inspect(bind).get_table_names():
        return  # already gone (a refused downgrade further down may have left the version here)
    extra = bind.execute(
        sa.text(
            f"SELECT 1 FROM {TABLE} l JOIN inv_decisions d ON d.id = l.decision_id "
            "WHERE d.signal_id IS NULL OR d.signal_id != l.signal_id LIMIT 1"
        )
    ).first()
    if extra is not None:
        raise RuntimeError(
            "0012_decision_signals: cannot downgrade, a decision covers several signals "
            "(the older schema links one)"
        )
    op.drop_table(TABLE)  # drops its index too
