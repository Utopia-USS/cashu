"""Macro reference series (P6): daily closes of the public series behind the macro regime cards.

Revision ID: 0019_macro_series
Revises: 0018_market_segments
Create Date: 2026-10-08

New table only (no existing table is altered):

- ``inv_macro_bars``: one daily close per macro series key (``modules/investments/macro/series.py``:
  acwi, spx, dxy, eem, dbc, us10y, us3m) and date, with its source and fetch time; UNIQUE(series,
  date). Shared reference data (not per profile), like ``inv_price_bars``.

Hand-written with plain SQLAlchemy types (no cashu / sqlmodel imports, so it never changes with the
models); ``tests/test_migrations.py`` checks the result equals the models' ``create_all``. Downgrade
drops the table: it only holds public market data the daily check fetches again.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019_macro_series"
down_revision: str | Sequence[str] | None = "0018_market_segments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "inv_macro_bars"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("series", sa.String(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("close", sa.String(), nullable=False),  # DecimalText is stored as text
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("series", "date", name="uq_inv_macro_bar"),
    )


def downgrade() -> None:
    # A failed earlier downgrade attempt may already have dropped it.
    if TABLE in set(sa.inspect(op.get_bind()).get_table_names()):
        op.drop_table(TABLE)
