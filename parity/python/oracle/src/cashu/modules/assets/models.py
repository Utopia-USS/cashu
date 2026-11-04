"""Assets tables: depreciation terms of depreciating assets (vehicles) and details of manual positions."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import Field, SQLModel

from cashu.core.models import utcnow
from cashu.core.types import DecimalText


class Depreciation(SQLModel, table=True):
    """Depreciation terms for a VEHICLE (or other depreciating asset) account.

    Value is modeled as declining-balance from the purchase price:
    ``value(t) = max(floor, purchase_price * (1 - annual_rate/100) ** years)``.
    """

    __tablename__ = "depreciations"
    __table_args__ = (UniqueConstraint("account_id", name="uq_depreciation_account"),)

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    purchase_price: Decimal = Field(sa_column=Column(DecimalText, nullable=False))
    purchase_date: dt.date
    annual_rate: Decimal = Field(sa_column=Column(DecimalText, nullable=False))  # percent, e.g. 15.0
    floor: Decimal | None = Field(default=None, sa_column=Column(DecimalText, nullable=True))
    created_at: dt.datetime = Field(default_factory=utcnow)


NOTE_MAX = 500


class AssetDetails(SQLModel, table=True):
    """Owner-written details of a manually valued position (F7 OB5): a short note, e.g. the status and
    deadline of an insolvency claim. One row per account, only when there is something to keep."""

    __tablename__ = "asset_details"

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", unique=True, index=True)
    note: str | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)
