"""Connectors: installed connectors, their bindings to accounts and the run log (F10).

Revision ID: 0016_connectors
Revises: 0015_recommendation_reason
Create Date: 2026-10-06

New tables only (no existing table is altered, so no batch rebuild is needed):

- ``connectors``: one row per installed connector (global; text primary key = the manifest id): manifest,
  current content hash and resolved interpreter, status (pending | approved | changed | disabled) and the
  owner's approval pinned as hash + interpreter + approved file list;
- ``connector_bindings``: a fetch connector bound to an account of a profile (params, auto-commit, cursor,
  scheduling state; UNIQUE(account_id, connector_id)); secrets stay in the OS keychain;
- ``connector_runs``: one row per sandboxed run (outcome, error kind, counts, redacted stderr tail);
  ``profile_id`` is nullable (developer test runs), no foreign key on connector / binding ids.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Downgrade drops
the tables and refuses while connectors or bindings exist (the run log alone may be dropped).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0016_connectors"
down_revision: str | Sequence[str] | None = "0015_recommendation_reason"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("connectors", "connector_bindings", "connector_runs")


def upgrade() -> None:
    text, ts = sa.String, sa.DateTime

    op.create_table(
        "connectors",
        sa.Column("id", text(), nullable=False),
        sa.Column("name", text(), nullable=False),
        sa.Column("version", text(), nullable=False),
        sa.Column("module", text(), nullable=False),
        sa.Column("kind", text(), nullable=False),
        sa.Column("manifest_json", sa.JSON(), nullable=False),
        sa.Column("content_sha256", text(), nullable=False),
        sa.Column("interpreter_path", text(), nullable=False),
        sa.Column("status", text(), nullable=False),
        sa.Column("approved_sha256", text(), nullable=True),
        sa.Column("approved_interpreter", text(), nullable=True),
        sa.Column("approved_files_json", sa.JSON(), nullable=True),
        sa.Column("approved_at", ts(), nullable=True),
        sa.Column("installed_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.Column("source", text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "connector_bindings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("connector_id", text(), nullable=False),
        sa.Column("params_json", sa.JSON(), nullable=False),
        sa.Column("auto_commit", sa.Boolean(), nullable=False),
        sa.Column("cursor", text(), nullable=True),
        sa.Column("last_run_at", ts(), nullable=True),
        sa.Column("last_status", text(), nullable=True),
        sa.Column("last_ok_at", ts(), nullable=True),
        sa.Column("backoff_until", ts(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(
            ["profile_id"], ["profiles.id"], name="fk_connector_bindings_profile_id"
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["connector_id"], ["connectors.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "connector_id", name="uq_connector_binding_account"),
    )
    for column in ("profile_id", "account_id", "connector_id"):
        op.create_index(
            f"ix_connector_bindings_{column}", "connector_bindings", [column], unique=False
        )

    op.create_table(
        "connector_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("connector_id", text(), nullable=False),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("binding_id", sa.Integer(), nullable=True),
        sa.Column("command", text(), nullable=False),
        sa.Column("started_at", ts(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("outcome", text(), nullable=False),
        sa.Column("error_kind", text(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("records", sa.Integer(), nullable=False),
        sa.Column("bytes_in", sa.Integer(), nullable=False),
        sa.Column("bytes_out", sa.Integer(), nullable=False),
        sa.Column("denied_hosts_json", sa.JSON(), nullable=False),
        sa.Column("stderr_tail", text(), nullable=True),
        sa.Column("proposal_id", sa.Integer(), nullable=True),
        sa.Column("batch_ref", text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["profile_id"], ["profiles.id"], name="fk_connector_runs_profile_id"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("connector_id", "profile_id"):
        op.create_index(f"ix_connector_runs_{column}", "connector_runs", [column], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    # A failed earlier downgrade attempt may already have dropped them (SQLite DDL is not always
    # rolled back with the migration transaction).
    existing = set(sa.inspect(bind).get_table_names())
    used = [
        t
        for t in ("connectors", "connector_bindings")
        if t in existing and bind.execute(sa.text(f"SELECT 1 FROM {t} LIMIT 1")).first() is not None
    ]
    if used:
        raise RuntimeError(
            f"0016_connectors: cannot downgrade, connector tables hold data ({', '.join(used)}); "
            "remove the connectors first (finanse connectors remove <id>)"
        )
    for table in reversed(TABLES):
        if table in existing:
            op.drop_table(table)  # drops its indexes too
