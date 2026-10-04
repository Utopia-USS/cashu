"""Assets tables: depreciation terms of depreciating assets (vehicles)."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import Field, SQLModel

from finanse.core.models import utcnow
from finanse.core.types import DecimalText


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
