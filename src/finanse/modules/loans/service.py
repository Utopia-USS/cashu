"""Loans: amortization terms attached to MORTGAGE/LOAN accounts."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from . import amortization
from .models import Loan


def set_loan(
    session: Session,
    account_id: int,
    principal,
    annual_rate,
    term_months: int,
    start_date: date,
    origination_date: date | None = None,
) -> Loan:
    """Create/update amortization terms for a loan account.

    start_date = first installment date; origination_date = disbursement (debt
    exists from then). Between them the full principal is owed (no payment yet).
    """
    existing = session.exec(select(Loan).where(Loan.account_id == account_id)).first()
    if existing is not None:
        existing.principal = Decimal(str(principal))
        existing.annual_rate = Decimal(str(annual_rate))
        existing.term_months = term_months
        existing.start_date = start_date
        existing.origination_date = origination_date
        session.add(existing)
        return existing
    loan = Loan(
        account_id=account_id,
        principal=Decimal(str(principal)),
        annual_rate=Decimal(str(annual_rate)),
        term_months=term_months,
        start_date=start_date,
        origination_date=origination_date,
    )
    session.add(loan)
    return loan


def loan_schedules(session: Session) -> dict[int, tuple[Loan, list]]:
    """account_id -> (Loan, amortization schedule)."""
    out: dict[int, tuple[Loan, list]] = {}
    for loan in session.exec(select(Loan)).all():
        rows = amortization.schedule(
            loan.principal, loan.annual_rate, loan.term_months, loan.start_date
        )
        out[loan.account_id] = (loan, rows)
    return out
