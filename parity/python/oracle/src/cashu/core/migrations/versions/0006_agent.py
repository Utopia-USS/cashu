"""Agent layer tables: proposals, MCP call audit log, weekly reviews.

Revision ID: 0006_agent
Revises: 0005_investments
Create Date: 2026-10-05

New tables only (no existing table is altered, so no batch rebuild is needed), each owned by a profile
(``profile_id``, named foreign key, indexed):

- ``proposals``: changes an agent suggested over MCP (strategy, custom rule, import), pending until the
  owner approves or rejects them in the app;
- ``mcp_calls``: one audit row per MCP tool call (tool, privacy level, time, outcome, argument names and
  JSON types, never values);
- ``reviews``: weekly review records per module (done_at, notes, stats).

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. The app backs
the database up before running it (``finanse.core.migrations.upgrade_to_head``) and the foreign keys are
checked afterwards. Downgrade drops the tables and refuses while they hold data.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006_agent"
down_revision: str | Sequence[str] | None = "0005_investments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("proposals", "mcp_calls", "reviews")


def _fk_violations(bind) -> set[tuple]:
    if bind.dialect.name != "sqlite":
        return set()
    return {tuple(r) for r in bind.exec_driver_sql("PRAGMA foreign_key_check").fetchall()}


def _profile(table: str) -> tuple[sa.Column, sa.ForeignKeyConstraint]:
    return (
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], name=f"fk_{table}_profile_id"),
    )


def _index_profile(table: str) -> None:
    op.create_index(f"ix_{table}_profile_id", table, ["profile_id"], unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    fk_before = _fk_violations(bind)
    text, ts = sa.String, sa.DateTime

    profile_id, profile_fk = _profile("proposals")
    op.create_table(
        "proposals",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("kind", text(), nullable=False),
        sa.Column("status", text(), nullable=False),
        sa.Column("summary", text(), nullable=False),
        sa.Column("reason", text(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("source", text(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("reviewed_at", ts(), nullable=True),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index_profile("proposals")

    profile_id, profile_fk = _profile("mcp_calls")
    op.create_table(
        "mcp_calls",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("tool", text(), nullable=False),
        sa.Column("privacy", text(), nullable=False),
        sa.Column("called_at", ts(), nullable=False),
        sa.Column("args", sa.JSON(), nullable=False),
        sa.Column("outcome", text(), nullable=False),
        sa.Column("error_kind", text(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index_profile("mcp_calls")

    profile_id, profile_fk = _profile("reviews")
    op.create_table(
        "reviews",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("module", text(), nullable=False),
        sa.Column("done_at", ts(), nullable=False),
        sa.Column("notes", text(), nullable=True),
        sa.Column("stats", sa.JSON(), nullable=False),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index_profile("reviews")

    new_violations = _fk_violations(bind) - fk_before
    if new_violations:
        raise RuntimeError(
            f"0006_agent: foreign key check failed after the migration "
            f"({sorted(new_violations)[:5]}); restore the backup taken before the upgrade "
            "(data dir: backups/)."
        )


def downgrade() -> None:
    bind = op.get_bind()
    used = [
        t for t in TABLES if bind.execute(sa.text(f"SELECT 1 FROM {t} LIMIT 1")).first() is not None
    ]
    if used:
        raise RuntimeError(
            f"0006_agent: cannot downgrade, agent tables hold data ({', '.join(used)})"
        )
    for table in reversed(TABLES):
        op.drop_table(table)  # drops its indexes too
