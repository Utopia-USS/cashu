"""Registry ids: institutions and account types are plain string ids.

Revision ID: 0003_registry_ids
Revises: 0002_profiles
Create Date: 2026-10-04

The closed ``Bank`` and ``AccountType`` enums were stored by member NAME
(``MBANK``, ``CHECKING``) in short VARCHAR columns. They become registries
(``core.institutions``, ``core.account_types``) that modules extend, so the
columns hold the registry id instead: the lowercase upstream enum value
(``mbank``, ``checking``; every upstream name lowercased is its value), in an
unbounded VARCHAR. Columns: ``accounts.bank``, ``accounts.type``,
``import_batches.bank``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_registry_ids"
down_revision: str | Sequence[str] | None = "0002_profiles"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_BANK = sa.Enum("MBANK", "ERSTE", "PEKAO", "MANUAL", name="bank")
OLD_ACCOUNT_TYPE = sa.Enum(
    "CHECKING", "SAVINGS", "CREDIT", "INVESTMENT", "CASH",
    "PROPERTY", "VEHICLE", "MORTGAGE", "LOAN", "OTHER",
    name="accounttype",
)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("UPDATE accounts SET bank = lower(bank), type = lower(type)"))
    bind.execute(sa.text("UPDATE import_batches SET bank = lower(bank) WHERE bank IS NOT NULL"))
    with op.batch_alter_table("accounts") as batch:
        batch.alter_column("bank", existing_type=OLD_BANK, type_=sa.String(), existing_nullable=False)
        batch.alter_column(
            "type", existing_type=OLD_ACCOUNT_TYPE, type_=sa.String(), existing_nullable=False
        )
    with op.batch_alter_table("import_batches") as batch:
        batch.alter_column("bank", existing_type=OLD_BANK, type_=sa.String(), existing_nullable=True)


def downgrade() -> None:
    bind = op.get_bind()
    banks = {b.lower() for b in OLD_BANK.enums}
    types = {t.lower() for t in OLD_ACCOUNT_TYPE.enums}
    used_banks = {r[0] for r in bind.execute(sa.text(
        "SELECT bank FROM accounts UNION SELECT bank FROM import_batches WHERE bank IS NOT NULL"
    ))}
    used_types = {r[0] for r in bind.execute(sa.text("SELECT type FROM accounts"))}
    if used_banks - banks or used_types - types:
        raise RuntimeError(
            "0003_registry_ids: cannot downgrade, the database uses institutions or account "
            f"types the old enums do not have: {sorted((used_banks - banks) | (used_types - types))}"
        )
    with op.batch_alter_table("import_batches") as batch:
        batch.alter_column("bank", existing_type=sa.String(), type_=OLD_BANK, existing_nullable=True)
    with op.batch_alter_table("accounts") as batch:
        batch.alter_column("type", existing_type=sa.String(), type_=OLD_ACCOUNT_TYPE,
                           existing_nullable=False)
        batch.alter_column("bank", existing_type=sa.String(), type_=OLD_BANK, existing_nullable=False)
    bind.execute(sa.text("UPDATE accounts SET bank = upper(bank), type = upper(type)"))
    bind.execute(sa.text("UPDATE import_batches SET bank = upper(bank) WHERE bank IS NOT NULL"))
