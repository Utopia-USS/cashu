"""Research layer, planned deposits, alert soft delete.

Revision ID: 0008_research_planned
Revises: 0007_alerts_watchlist
Create Date: 2026-10-05

- New table ``research_runs`` (profile-scoped): one research pass by the agent (started / finished,
  status running | done | failed, JSON scope and counts, created_by).
- New table ``research_notes`` (profile-scoped): a sourced fact or sentiment reading about an
  instrument (held, watched or candidate) or a theme: kind, polarity, strength 1-3, thesis relation and
  the thesis field it bears on, title, summary, JSON sources (at least one URL), JSON details
  (candidate criteria), candidate key, the research signal it created, observed / expires / dismissed
  timestamps and the candidate cooldown.
- New table ``inv_planned_deposits`` (profile-scoped): deposits the owner plans to make (amount,
  currency, planned date, optional account, note, status planned | booked | cancelled, the
  transaction that booked it).
- ``alerts.deleted_at`` (nullable) added in batch mode (ALTER TABLE ADD COLUMN on SQLite, no rebuild):
  soft delete, so an alert can be restored with the same id.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. The app backs
the database up before running it (``finanse.core.migrations.upgrade_to_head``) and the foreign keys are
checked before and after. Downgrade refuses while the new tables hold data or an alert is soft-deleted
(dropping the column would bring it back), then drops the column and the tables.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008_research_planned"
down_revision: str | Sequence[str] | None = "0007_alerts_watchlist"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("inv_planned_deposits", "research_runs", "research_notes")


def _fk_violations(bind) -> set[tuple]:
    if bind.dialect.name != "sqlite":
        return set()
    return {tuple(r) for r in bind.exec_driver_sql("PRAGMA foreign_key_check").fetchall()}


def _profile(table: str) -> tuple[sa.Column, sa.ForeignKeyConstraint]:
    return (
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], name=f"fk_{table}_profile_id"),
    )


def _index(table: str, column: str) -> None:
    op.create_index(f"ix_{table}_{column}", table, [column], unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    fk_before = _fk_violations(bind)
    text, dec, ts = sa.String, sa.String, sa.DateTime  # DecimalText is stored as text

    profile_id, profile_fk = _profile("inv_planned_deposits")
    op.create_table(
        "inv_planned_deposits",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("amount", dec(), nullable=False),
        sa.Column("currency", text(), nullable=False),
        sa.Column("planned_date", sa.Date(), nullable=False),
        sa.Column("note", text(), nullable=True),
        sa.Column("status", text(), nullable=False),
        sa.Column("booked_txn_id", sa.Integer(), nullable=True),
        sa.Column("booked_at", ts(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["booked_txn_id"], ["inv_transactions.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_planned_deposits", "account_id")
    _index("inv_planned_deposits", "profile_id")

    profile_id, profile_fk = _profile("research_runs")
    op.create_table(
        "research_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("started_at", ts(), nullable=False),
        sa.Column("finished_at", ts(), nullable=True),
        sa.Column("status", text(), nullable=False),
        sa.Column("scope", sa.JSON(), nullable=False),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("created_by", text(), nullable=False),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("research_runs", "profile_id")

    profile_id, profile_fk = _profile("research_notes")
    op.create_table(
        "research_notes",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("run_id", sa.Integer(), nullable=True),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("theme", text(), nullable=True),
        sa.Column("kind", text(), nullable=False),
        sa.Column("polarity", text(), nullable=False),
        sa.Column("strength", sa.Integer(), nullable=False),
        sa.Column("thesis_relation", text(), nullable=False),
        sa.Column("thesis_field", text(), nullable=True),
        sa.Column("title", text(), nullable=False),
        sa.Column("summary", text(), nullable=False),
        sa.Column("sources", sa.JSON(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("candidate_key", text(), nullable=True),
        sa.Column("signal_id", sa.Integer(), nullable=True),
        sa.Column("observed_at", ts(), nullable=False),
        sa.Column("expires_at", ts(), nullable=False),
        sa.Column("created_by", text(), nullable=False),
        sa.Column("dismissed_at", ts(), nullable=True),
        sa.Column("cooldown_until", ts(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["research_runs.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["signal_id"], ["inv_signals.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("research_notes", "candidate_key")
    _index("research_notes", "instrument_id")
    _index("research_notes", "profile_id")
    _index("research_notes", "run_id")

    with op.batch_alter_table("alerts") as batch:
        batch.add_column(sa.Column("deleted_at", ts(), nullable=True))

    new_violations = _fk_violations(bind) - fk_before
    if new_violations:
        raise RuntimeError(
            f"0008_research_planned: foreign key check failed after the migration "
            f"({sorted(new_violations)[:5]}); restore the backup taken before the upgrade "
            "(data dir: backups/)."
        )


def downgrade() -> None:
    bind = op.get_bind()
    used = [
        t for t in TABLES if bind.execute(sa.text(f"SELECT 1 FROM {t} LIMIT 1")).first() is not None
    ]
    if bind.execute(sa.text("SELECT 1 FROM alerts WHERE deleted_at IS NOT NULL LIMIT 1")).first():
        used.append("alerts.deleted_at")
    if used:
        raise RuntimeError(
            f"0008_research_planned: cannot downgrade, tables hold data ({', '.join(used)})"
        )
    op.drop_column("alerts", "deleted_at")  # plain DROP COLUMN (SQLite >= 3.35), no rebuild
    for table in reversed(TABLES):
        op.drop_table(table)  # drops its indexes too
