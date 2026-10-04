"""Loans tables: amortization terms of MORTGAGE/LOAN accounts."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import Field, SQLModel

from finanse.core.models import utcnow
from finanse.core.types import DecimalText


class Loan(SQLModel, table=True):
    """Amortization terms for a MORTGAGE/LOAN account (the payoff simulator)."""

    __tablename__ = "loans"
    __table_args__ = (UniqueConstraint("account_id", name="uq_loan_account"),)

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    principal: Decimal = Field(sa_column=Column(DecimalText, nullable=False))
    annual_rate: Decimal = Field(sa_column=Column(DecimalText, nullable=False))  # percent, e.g. 6.27
    term_months: int
    start_date: dt.date  # first installment date
    origination_date: dt.date | None = None  # disbursement (debt exists from here)
    created_at: dt.datetime = Field(default_factory=utcnow)
