"""Profiles: every account (and learned rule, import batch) belongs to a profile.

Revision ID: 0002_profiles
Revises: 0001_baseline
Create Date: 2026-10-04

- New tables ``profiles`` and ``profile_modules``.
- An existing database with data gets one profile, ``default`` ("Domyślny"),
  owning every row, with the modules its data already uses enabled (budget:
  bank/cash accounts, transactions, rules or imports; assets: property, vehicle,
  investment or other positions; loans: loan terms or mortgage/loan accounts). A
  brand-new empty database gets no profile (the app's first-launch wizard creates
  one).
- ``profile_id`` (NOT NULL, FK) on ``accounts``, ``category_rules`` and
  ``import_batches``; account identity and learned rules become per profile
  (``uq_account_profile_bank_external``, ``uq_rule_profile_merchant``). Tables whose
  rows belong to an account (transactions, balances, loans, depreciations) are
  scoped through it and do not change.

SQLite rebuilds the altered tables (batch mode); the app backs the database up
before running this (see ``finanse.core.migrations.upgrade_to_head``) and checks
the foreign keys afterwards: a violation that did not exist before aborts.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_profiles"
down_revision: str | Sequence[str] | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_SLUG = "default"
DEFAULT_NAME = "Domyślny"

# Upstream account types (stored by enum NAME at this revision) per module.
BUDGET_TYPES = ("CHECKING", "SAVINGS", "CREDIT", "CASH")
ASSETS_TYPES = ("PROPERTY", "VEHICLE", "INVESTMENT", "OTHER")
LOANS_TYPES = ("MORTGAGE", "LOAN")
SCOPED_TABLES = ("accounts", "category_rules", "import_batches")


def _count(bind, sql: str, **params) -> int:
    return int(bind.execute(sa.text(sql), params).scalar() or 0)


def _types_in(types: Sequence[str]) -> str:
    return ", ".join(f"'{t}'" for t in types)


def _used_modules(bind) -> list[str]:
    used: list[str] = []
    if (
        _count(bind, f"SELECT COUNT(*) FROM accounts WHERE upper(type) IN ({_types_in(BUDGET_TYPES)})")
        or _count(bind, "SELECT COUNT(*) FROM transactions")
        or _count(bind, "SELECT COUNT(*) FROM category_rules")
        or _count(bind, "SELECT COUNT(*) FROM import_batches")
    ):
        used.append("budget")
    if _count(
        bind, f"SELECT COUNT(*) FROM accounts WHERE upper(type) IN ({_types_in(ASSETS_TYPES)})"
    ) or _count(bind, "SELECT COUNT(*) FROM depreciations"):
        used.append("assets")
    if _count(
        bind, f"SELECT COUNT(*) FROM accounts WHERE upper(type) IN ({_types_in(LOANS_TYPES)})"
    ) or _count(bind, "SELECT COUNT(*) FROM loans"):
        used.append("loans")
    return used or ["budget", "assets", "loans"]


def _fk_violations(bind) -> set[tuple]:
    if bind.dialect.name != "sqlite":
        return set()
    return {tuple(r) for r in bind.exec_driver_sql("PRAGMA foreign_key_check").fetchall()}


def upgrade() -> None:
    bind = op.get_bind()
    fk_before = _fk_violations(bind)

    op.create_table(
        "profiles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("base_currency", sa.String(), nullable=False),
        sa.Column("mcp_privacy", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_profiles_slug", "profiles", ["slug"], unique=True)
    op.create_table(
        "profile_modules",
        sa.Column("profile_id", sa.Integer(), nullable=False),
        sa.Column("module_id", sa.String(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("enabled_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"]),
        sa.PrimaryKeyConstraint("profile_id", "module_id"),
    )

    has_data = any(_count(bind, f"SELECT COUNT(*) FROM {t}") for t in SCOPED_TABLES)
    profile_id = None
    if has_data:
        # SQLAlchemy's SQLite DateTime text format (a raw datetime would go through
        # sqlite3's deprecated default adapter).
        now = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
        bind.execute(
            sa.text(
                "INSERT INTO profiles (slug, name, base_currency, mcp_privacy, created_at) "
                "VALUES (:slug, :name, 'PLN', 'strict', :now)"
            ),
            {"slug": DEFAULT_SLUG, "name": DEFAULT_NAME, "now": now},
        )
        profile_id = bind.execute(
            sa.text("SELECT id FROM profiles WHERE slug = :slug"), {"slug": DEFAULT_SLUG}
        ).scalar_one()
        for module_id in _used_modules(bind):
            bind.execute(
                sa.text(
                    "INSERT INTO profile_modules (profile_id, module_id, enabled, enabled_at) "
                    "VALUES (:pid, :mid, 1, :now)"
                ),
                {"pid": profile_id, "mid": module_id, "now": now},
            )

    # 1. Nullable column, filled with the default profile.
    for table in SCOPED_TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("profile_id", sa.Integer(), nullable=True))
        if profile_id is not None:
            bind.execute(sa.text(f"UPDATE {table} SET profile_id = :pid"), {"pid": profile_id})

    # 2. NOT NULL + FK + index; profile-aware unique constraints.
    with op.batch_alter_table("accounts") as batch:
        batch.alter_column("profile_id", existing_type=sa.Integer(), nullable=False)
        batch.drop_constraint("uq_account_bank_external", type_="unique")
        batch.create_unique_constraint(
            "uq_account_profile_bank_external", ["profile_id", "bank", "external_id"]
        )
        batch.create_foreign_key("fk_accounts_profile_id", "profiles", ["profile_id"], ["id"])
        batch.create_index("ix_accounts_profile_id", ["profile_id"])
    with op.batch_alter_table("category_rules") as batch:
        batch.alter_column("profile_id", existing_type=sa.Integer(), nullable=False)
        batch.drop_constraint("uq_rule_merchant", type_="unique")
        batch.create_unique_constraint(
            "uq_rule_profile_merchant", ["profile_id", "merchant_key"]
        )
        batch.create_foreign_key(
            "fk_category_rules_profile_id", "profiles", ["profile_id"], ["id"]
        )
        batch.create_index("ix_category_rules_profile_id", ["profile_id"])
    with op.batch_alter_table("import_batches") as batch:
        batch.alter_column("profile_id", existing_type=sa.Integer(), nullable=False)
        batch.create_foreign_key(
            "fk_import_batches_profile_id", "profiles", ["profile_id"], ["id"]
        )
        batch.create_index("ix_import_batches_profile_id", ["profile_id"])

    new_violations = _fk_violations(bind) - fk_before
    if new_violations:
        raise RuntimeError(
            f"0002_profiles: foreign key check failed after the migration ({sorted(new_violations)[:5]}); "
            "restore the backup taken before the upgrade (data dir: backups/)."
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _count(bind, "SELECT COUNT(*) FROM profiles") > 1:
        raise RuntimeError("0002_profiles: cannot downgrade a database with more than one profile")
    with op.batch_alter_table("import_batches") as batch:
        batch.drop_index("ix_import_batches_profile_id")
        batch.drop_constraint("fk_import_batches_profile_id", type_="foreignkey")
        batch.drop_column("profile_id")
    with op.batch_alter_table("category_rules") as batch:
        batch.drop_index("ix_category_rules_profile_id")
        batch.drop_constraint("fk_category_rules_profile_id", type_="foreignkey")
        batch.drop_constraint("uq_rule_profile_merchant", type_="unique")
        batch.create_unique_constraint("uq_rule_merchant", ["merchant_key"])
        batch.drop_column("profile_id")
    with op.batch_alter_table("accounts") as batch:
        batch.drop_index("ix_accounts_profile_id")
        batch.drop_constraint("fk_accounts_profile_id", type_="foreignkey")
        batch.drop_constraint("uq_account_profile_bank_external", type_="unique")
        batch.create_unique_constraint("uq_account_bank_external", ["bank", "external_id"])
        batch.drop_column("profile_id")
    op.drop_table("profile_modules")
    op.drop_index("ix_profiles_slug", table_name="profiles")
    op.drop_table("profiles")
