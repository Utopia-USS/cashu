"""Alerts, the watchlist, signal polarity and snooze, per-profile instrument overrides.

Revision ID: 0007_alerts_watchlist
Revises: 0006_agent
Create Date: 2026-10-05

- New table ``alerts`` (profile-scoped): a condition from a fixed catalog (``kind`` + JSON ``params``)
  on an instrument, a bucket or the portfolio, with polarity, severity, title, note, source
  (user | agent), status (active | triggered | snoozed | muted | expired), cooldown, expiry, snooze and
  the last check / trigger.
- New table ``watchlist_items`` (profile-scoped, unique per profile and instrument): instruments the
  profile watches without holding them.
- New table ``inv_profile_instruments`` (unique per profile and instrument): a profile's overrides of
  the owner-editable attributes of a shared instrument (name, asset class, tags, region, sector,
  valuation mode, status, reviewed flag; NULL = the shared default). Existing shared values stay the
  default of every profile (nothing is moved: which profile set them is unknown).
- ``inv_signals.polarity`` (positive | negative | neutral, NOT NULL, default ``neutral``) and
  ``inv_signals.snoozed_until`` (nullable) added in batch mode (ALTER TABLE ADD COLUMN on SQLite: the
  table is not rebuilt, so its partial unique index stays untouched); existing signals get the default
  polarity of their rule kind.

Hand-written with plain SQLAlchemy types (no finanse / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. The app backs
the database up before running it (``finanse.core.migrations.upgrade_to_head``) and the foreign keys are
checked before and after. Downgrade refuses while the new tables hold data, then drops the polarity
column and the tables.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007_alerts_watchlist"
down_revision: str | Sequence[str] | None = "0006_agent"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("inv_profile_instruments", "alerts", "watchlist_items")

# Default polarity of the built-in rule kinds when this revision was written (the kinds declare it in
# code; copied here so the migration never changes with the code). Other kinds stay neutral
# (``allocation_drift`` included: owner decision F6, drift is a neutral review item).
_KIND_POLARITY = {
    "negative": (
        "position_concentration",
        "loss_from_cost",
        "cash_level",
        "contribution_gap",
        "tagged_weight",
    ),
    "positive": ("gain_from_cost", "drawdown_from_high"),
}


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
    text, ts = sa.String, sa.DateTime

    profile_id, profile_fk = _profile("inv_profile_instruments")
    op.create_table(
        "inv_profile_instruments",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("name", text(), nullable=True),
        sa.Column("asset_class", text(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("region", text(), nullable=True),
        sa.Column("sector", text(), nullable=True),
        sa.Column("valuation_mode", text(), nullable=True),
        sa.Column("status", text(), nullable=True),
        sa.Column("needs_classification", sa.Boolean(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "instrument_id", name="uq_inv_profile_instrument"),
    )
    _index("inv_profile_instruments", "instrument_id")
    _index("inv_profile_instruments", "profile_id")

    profile_id, profile_fk = _profile("alerts")
    op.create_table(
        "alerts",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("scope", text(), nullable=False),
        sa.Column("kind", text(), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("polarity", text(), nullable=False),
        sa.Column("severity", text(), nullable=False),
        sa.Column("title", text(), nullable=False),
        sa.Column("note", text(), nullable=True),
        sa.Column("source", text(), nullable=False),
        sa.Column("created_by", text(), nullable=False),
        sa.Column("status", text(), nullable=False),
        sa.Column("cooldown_days", sa.Integer(), nullable=True),
        sa.Column("expires_at", ts(), nullable=True),
        sa.Column("snoozed_until", ts(), nullable=True),
        sa.Column("last_triggered_at", ts(), nullable=True),
        sa.Column("last_checked_at", ts(), nullable=True),
        sa.Column("last_value", text(), nullable=True),
        sa.Column("created_at", ts(), nullable=False),
        sa.Column("updated_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
    )
    _index("alerts", "instrument_id")
    _index("alerts", "profile_id")

    profile_id, profile_fk = _profile("watchlist_items")
    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.Integer(), nullable=False),
        profile_id,
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("note", text(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("source", text(), nullable=False),
        sa.Column("added_at", ts(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["inv_instruments.id"]),
        profile_fk,
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("profile_id", "instrument_id", name="uq_watchlist_profile_instrument"),
    )
    _index("watchlist_items", "instrument_id")
    _index("watchlist_items", "profile_id")

    with op.batch_alter_table("inv_signals") as batch:
        batch.add_column(sa.Column("polarity", text(), nullable=False, server_default="neutral"))
        batch.add_column(sa.Column("snoozed_until", ts(), nullable=True))
    signals = sa.table("inv_signals", sa.column("kind", text()), sa.column("polarity", text()))
    for polarity, kinds in _KIND_POLARITY.items():
        op.execute(signals.update().where(signals.c.kind.in_(kinds)).values(polarity=polarity))

    new_violations = _fk_violations(bind) - fk_before
    if new_violations:
        raise RuntimeError(
            f"0007_alerts_watchlist: foreign key check failed after the migration "
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
            f"0007_alerts_watchlist: cannot downgrade, tables hold data ({', '.join(used)})"
        )
    # A plain DROP COLUMN (SQLite >= 3.35): no rebuild, the partial unique index of the open signals
    # is kept as it is. Signals of deleted alerts (kind "alert:...") stay as history rows.
    op.drop_column("inv_signals", "snoozed_until")
    op.drop_column("inv_signals", "polarity")
    for table in reversed(TABLES):
        op.drop_table(table)  # drops its indexes too
