"""Investments module tables.

Revision ID: 0005_investments
Revises: 0004_loan_payments
Create Date: 2026-10-05

New tables only (prefixed ``inv_``; no existing table is altered, so no batch
rebuild is needed). Shared reference data: ``inv_instruments`` (+ aliases, unique
per namespace and value, with a ``guessed`` flag), ``inv_price_bars`` (currency,
source, fetched_at) and ``inv_fx_rates``. Profile-scoped through the brokerage
account: ``inv_account_settings``, ``inv_transactions`` (Decimal as text, dedup
hash unique per account, ``created_at`` = chronological import rank) and
``inv_position_snapshots``. Profile-scoped by ``profile_id``: import batches,
instrument renames, manual valuations, strategy versions, rule runs, signals
(partial unique index on the open dedup keys), the notification log (unique per
signal and severity), decisions and theses.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it
never changes with the models); ``tests/test_migrations.py`` checks the result
equals the models' ``create_all``. The app backs the database up before running
it (``finanse.core.migrations.upgrade_to_head``) and the foreign keys are checked
afterwards. Downgrade drops the tables and refuses while they hold data.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005_investments"
down_revision: str | Sequence[str] | None = "0004_loan_payments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Creation order (foreign keys point backwards); dropped in reverse.
TABLES = (
    "inv_instruments",
    "inv_instrument_aliases",
    "inv_price_bars",
    "inv_fx_rates",
    "inv_account_settings",
    "inv_import_batches",
    "inv_transactions",
    "inv_position_snapshots",
    "inv_instrument_renames",
    "inv_manual_valuations",
    "inv_strategy_versions",
    "inv_rule_runs",
    "inv_signals",
    "inv_notification_log",
    "inv_decisions",
    "inv_theses",
)


def _fk_violations(bind) -> set[tuple]:
    if bind.dialect.name != "sqlite":
        return set()
    return {tuple(r) for r in bind.exec_driver_sql("PRAGMA foreign_key_check").fetchall()}


def _id() -> sa.Column:
    return sa.Column("id", sa.Integer(), nullable=False)


def _profile(table: str) -> tuple[sa.Column, sa.ForeignKeyConstraint]:
    return (
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], name=f"fk_{table}_profile_id"),
    )


def _index(table: str, *cols: str) -> None:
    op.create_index(f"ix_{table}_{'_'.join(cols)}", table, list(cols), unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    fk_before = _fk_violations(bind)
    text, dec, ts = sa.String, sa.String, sa.DateTime  # DecimalText is stored as text

    op.create_table(
        "inv_instruments",
        _id(),
        sa.Column("name", text(), nullable=False),
        sa.Column("currency", text(), nullable=False),
        sa.Column("asset_class", text(), nullable=False),
        sa.Column("symbol", text(), nullable=True),
        sa.Column("isin", text(), nullable=True),
        sa.Column("mic", text(), nullable=True),
        sa.Column("region", text(), nullable=True),
        sa.Column("sector", text(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("needs_classification", sa.Boolean(), nullable=False),
        sa.Column("valuation_mode", text(), nullable=False),
        sa.Column("status", text(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_instruments", "isin")
    _index("inv_instruments", "symbol")

    op.create_table(
        "inv_instrument_aliases",
        _id(),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("namespace", text(), nullable=False),
        sa.Column("value", text(), nullable=False),
        sa.Column("guessed", sa.Boolean(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("namespace", "value", name="uq_inv_alias_namespace_value"),
    )
    _index("inv_instrument_aliases", "instrument_id")

    op.create_table(
        "inv_price_bars",
        _id(),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("close", dec(), nullable=False),
        sa.Column("open", dec(), nullable=True),
        sa.Column("high", dec(), nullable=True),
        sa.Column("low", dec(), nullable=True),
        sa.Column("volume", sa.Integer(), nullable=True),
        sa.Column("currency", text(), nullable=True),
        sa.Column("source", text(), nullable=False),
        sa.Column("fetched_at", ts(), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("instrument_id", "date", name="uq_inv_price_bar"),
    )

    op.create_table(
        "inv_fx_rates",
        _id(),
        sa.Column("base", text(), nullable=False),
        sa.Column("quote", text(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("rate", dec(), nullable=False),
        sa.Column("source", text(), nullable=False),
        sa.Column("fetched_at", ts(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("base", "quote", "date", name="uq_inv_fx_rate"),
    )

    op.create_table(
        "inv_account_settings",
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("wrapper", text(), nullable=False),
        sa.Column("importer", text(), nullable=True),
        sa.Column("mapping_yaml", text(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("account_id"),
    )

    profile_id, profile_fk = _profile("inv_import_batches")
    op.create_table(
        "inv_import_batches",
        _id(),
        profile_id,
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("importer", text(), nullable=False),
        sa.Column("broker", text(), nullable=False),
        sa.Column("file_name", text(), nullable=False),
        sa.Column("file_sha256", text(), nullable=False),
        sa.Column("archive_path", text(), nullable=True),
        sa.Column("txn_count", sa.Integer(), nullable=False),
        sa.Column("duplicate_count", sa.Integer(), nullable=False),
        sa.Column("position_count", sa.Integer(), nullable=False),
        sa.Column("rename_count", sa.Integer(), nullable=False),
        sa.Column("status_change_count", sa.Integer(), nullable=False),
        sa.Column("instrument_count", sa.Integer(), nullable=False),
        sa.Column("correction_count", sa.Integer(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_import_batches", "account_id")
    _index("inv_import_batches", "file_sha256")
    _index("inv_import_batches", "profile_id")

    op.create_table(
        "inv_transactions",
        _id(),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("type", text(), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("settle_date", sa.Date(), nullable=True),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("quantity", dec(), nullable=True),
        sa.Column("price", dec(), nullable=True),
        sa.Column("currency", text(), nullable=False),
        sa.Column("gross_amount", dec(), nullable=False),
        sa.Column("fee", dec(), nullable=False),
        sa.Column("tax", dec(), nullable=False),
        sa.Column("cash_amount", dec(), nullable=False),
        sa.Column("cash_currency", text(), nullable=False),
        sa.Column("fx_rate", dec(), nullable=True),
        sa.Column("split_ratio", dec(), nullable=True),
        sa.Column("note", text(), nullable=True),
        sa.Column("source", text(), nullable=False),
        sa.Column("import_batch_id", sa.Integer(), nullable=True),
        sa.Column("external_ref", text(), nullable=True),
        sa.Column("dedup_hash", text(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["import_batch_id"], ["inv_import_batches.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "dedup_hash", name="uq_inv_txn_account_hash"),
    )
    _index("inv_transactions", "account_id")
    _index("inv_transactions", "import_batch_id")
    _index("inv_transactions", "instrument_id")
    _index("inv_transactions", "trade_date")

    op.create_table(
        "inv_position_snapshots",
        _id(),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("quantity", dec(), nullable=False),
        sa.Column("currency", text(), nullable=False),
        sa.Column("avg_price", dec(), nullable=True),
        sa.Column("market_value", dec(), nullable=True),
        sa.Column("import_batch_id", sa.Integer(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["import_batch_id"], ["inv_import_batches.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id", "instrument_id", "as_of", name="uq_inv_position_snapshot"
        ),
    )
    _index("inv_position_snapshots", "account_id")

    profile_id, profile_fk = _profile("inv_instrument_renames")
    op.create_table(
        "inv_instrument_renames",
        _id(),
        profile_id,
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("old_instrument_id", sa.Integer(), nullable=False),
        sa.Column("new_instrument_id", sa.Integer(), nullable=False),
        sa.Column("note", text(), nullable=True),
        sa.Column("import_batch_id", sa.Integer(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["old_instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["new_instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["import_batch_id"], ["inv_import_batches.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "profile_id", "date", "old_instrument_id", "new_instrument_id", name="uq_inv_rename"
        ),
    )
    _index("inv_instrument_renames", "profile_id")

    profile_id, profile_fk = _profile("inv_manual_valuations")
    op.create_table(
        "inv_manual_valuations",
        _id(),
        profile_id,
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("unit_value", dec(), nullable=False),
        sa.Column("currency", text(), nullable=False),
        sa.Column("note", text(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "instrument_id", "as_of", name="uq_inv_manual_valuation"),
    )
    _index("inv_manual_valuations", "instrument_id")
    _index("inv_manual_valuations", "profile_id")

    profile_id, profile_fk = _profile("inv_strategy_versions")
    op.create_table(
        "inv_strategy_versions",
        _id(),
        profile_id,
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("sha256", text(), nullable=False),
        sa.Column("yaml_text", text(), nullable=False),
        sa.Column("md_text", text(), nullable=True),
        sa.Column("state", text(), nullable=False),
        sa.Column("issues", sa.JSON(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "version", name="uq_inv_strategy_version"),
    )
    _index("inv_strategy_versions", "profile_id")

    profile_id, profile_fk = _profile("inv_rule_runs")
    op.create_table(
        "inv_rule_runs",
        _id(),
        profile_id,
        sa.Column("trigger", text(), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("status", text(), nullable=False),
        sa.Column("strategy_version_id", sa.Integer(), nullable=True),
        sa.Column("stats", sa.JSON(), nullable=False),
        sa.Column("errors", sa.JSON(), nullable=False),
        sa.Column("report", sa.JSON(), nullable=False),
        sa.Column("started_at", ts(), nullable=False),
        sa.Column("finished_at", ts(), nullable=True),
        profile_fk,
        sa.ForeignKeyConstraint(["strategy_version_id"], ["inv_strategy_versions.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_rule_runs", "profile_id")

    profile_id, profile_fk = _profile("inv_signals")
    op.create_table(
        "inv_signals",
        _id(),
        profile_id,
        sa.Column("rule_id", text(), nullable=False),
        sa.Column("kind", text(), nullable=False),
        sa.Column("dedup_key", text(), nullable=False),
        sa.Column("severity", text(), nullable=False),
        sa.Column("status", text(), nullable=False),
        sa.Column("message", text(), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("first_seen_at", ts(), nullable=False),
        sa.Column("last_seen_at", ts(), nullable=False),
        sa.Column("created_run_id", sa.Integer(), nullable=True),
        sa.Column("last_run_id", sa.Integer(), nullable=True),
        sa.Column("acknowledged_at", ts(), nullable=True),
        sa.Column("closed_at", ts(), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["created_run_id"], ["inv_rule_runs.id"]),
        sa.ForeignKeyConstraint(["last_run_id"], ["inv_rule_runs.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_signals", "profile_id")
    op.create_index(
        "uq_inv_signals_open_key",
        "inv_signals",
        ["profile_id", "dedup_key"],
        unique=True,
        sqlite_where=sa.text("status IN ('active', 'acknowledged')"),
    )

    profile_id, profile_fk = _profile("inv_notification_log")
    op.create_table(
        "inv_notification_log",
        _id(),
        profile_id,
        sa.Column("signal_id", sa.Integer(), nullable=False),
        sa.Column("severity", text(), nullable=False),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("sent_at", ts(), nullable=True),
        sa.Column("channel", text(), nullable=True),
        profile_fk,
        sa.ForeignKeyConstraint(["signal_id"], ["inv_signals.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("signal_id", "severity", name="uq_inv_notification_signal_severity"),
    )
    _index("inv_notification_log", "profile_id")

    profile_id, profile_fk = _profile("inv_decisions")
    op.create_table(
        "inv_decisions",
        _id(),
        profile_id,
        sa.Column("signal_id", sa.Integer(), nullable=True),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("action", text(), nullable=False),
        sa.Column("quantity", dec(), nullable=True),
        sa.Column("price", dec(), nullable=True),
        sa.Column("currency", text(), nullable=True),
        sa.Column("reason", text(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        profile_fk,
        sa.ForeignKeyConstraint(["signal_id"], ["inv_signals.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_decisions", "profile_id")
    _index("inv_decisions", "signal_id")

    profile_id, profile_fk = _profile("inv_theses")
    op.create_table(
        "inv_theses",
        _id(),
        profile_id,
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("entry_type", text(), nullable=False),
        sa.Column("thesis", text(), nullable=False),
        sa.Column("invalidation", text(), nullable=True),
        sa.Column("exit_plan", text(), nullable=True),
        sa.Column("size_plan", text(), nullable=True),
        sa.Column("reviewed_at", ts(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("inv_theses", "instrument_id")
    _index("inv_theses", "profile_id")

    new_violations = _fk_violations(bind) - fk_before
    if new_violations:
        raise RuntimeError(
            f"0005_investments: foreign key check failed after the migration "
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
            f"0005_investments: cannot downgrade, investments tables hold data ({', '.join(used)})"
        )
    for table in reversed(TABLES):
        op.drop_table(table)  # drops its indexes too
