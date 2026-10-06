"""Loans tables: amortization terms of MORTGAGE/LOAN accounts."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import Field, SQLModel

from cashu.core.models import utcnow
from cashu.core.types import DecimalText


class Loan(SQLModel, table=True):
    """Amortization terms for a MORTGAGE/LOAN account (the payoff simulator).

    A profile can have any number of loans (one per account). ``payment_iban`` /
    ``payment_text`` tell the budget how to recognise this loan's installments in
    bank transactions (category "loans", never a subscription). ``updated_at`` is
    when the terms were last set: a balance recorded for the account after that
    (a bank statement) takes precedence over the schedule from its date on.
    """

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
    updated_at: dt.datetime = Field(default_factory=utcnow)
    payment_iban: str | None = None  # lender account the installments go to
    payment_text: str | None = None  # phrase in the installment title (normalized text)
