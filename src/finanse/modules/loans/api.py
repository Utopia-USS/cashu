"""Loans API routes."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter
from sqlmodel import select

from finanse.core.api import f
from finanse.core.db import get_session
from finanse.core.models import Account

from . import amortization
from .models import Loan

router = APIRouter()


@router.get("/loan")
def loan_info() -> dict:
    with get_session() as s:
        loan = s.exec(select(Loan)).first()
        if loan is None:
            return {"has_loan": False}
        acc = s.get(Account, loan.account_id)
        summ = amortization.summarize(
            loan.principal, loan.annual_rate, loan.term_months, loan.start_date, date.today(),
            origination_date=loan.origination_date,
        )
    return {
        "has_loan": True,
        "currency": acc.currency if acc else "PLN",
        "principal": f(summ.principal),
        "annual_rate": f(summ.annual_rate),
        "term_months": summ.term_months,
        "monthly_payment": f(summ.monthly_payment),
        "start_date": summ.start_date.isoformat(),
        "outstanding": f(summ.outstanding),
        "months_elapsed": summ.months_elapsed,
        "paid_principal": f(summ.paid_principal),
        "paid_interest": f(summ.paid_interest),
        "remaining_interest": f(summ.remaining_interest),
        "total_interest": f(summ.total_interest),
        "payoff_date": summ.payoff_date.isoformat(),
        "series": [{"date": r.date.isoformat(), "balance": f(r.balance)} for r in summ.schedule],
        "schedule": [
            {
                "n": r.n,
                "date": r.date.isoformat(),
                "payment": f(r.payment),
                "interest": f(r.interest),
                "principal": f(r.principal),
                "balance": f(r.balance),
            }
            for r in summ.schedule
        ],
    }
