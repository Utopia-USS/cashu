"""Rename the market segment key ``uranium`` to ``power`` (P7: the topic "Energetyka: atom i OZE").

Revision ID: 0020_power_segment
Revises: 0019_macro_series
Create Date: 2026-10-09

Data only (no table or column changes): every stored ``uranium`` segment becomes ``power`` in
``inv_profile_instruments.segment`` (the profile's instrument segment) and ``research_notes.segment``
(segment notes). Defensive: nothing should hold the old key yet; the step is idempotent.

Downgrade maps ``power`` back to ``uranium`` (the key the 0019 code knows).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020_power_segment"
down_revision: str | Sequence[str] | None = "0019_macro_series"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("inv_profile_instruments", "research_notes")


def _rename(old: str, new: str) -> None:
    for table in TABLES:
        op.execute(
            sa.text(f"UPDATE {table} SET segment = :new WHERE segment = :old").bindparams(
                old=old, new=new
            )
        )


def upgrade() -> None:
    _rename("uranium", "power")


def downgrade() -> None:
    _rename("power", "uranium")
