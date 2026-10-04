"""Loans' net-worth contributor: a loan account is worth its amortized outstanding."""

from __future__ import annotations

from collections.abc import Mapping

from sqlmodel import Session, select

from finanse.core.models import Account
from finanse.core.networth import ComputedValuation, Valuation

from . import amortization
from .models import Loan


class LoansContributor:
    def valuations(
        self, session: Session, accounts: Mapping[int, Account]
    ) -> dict[int, Valuation]:
        out: dict[int, Valuation] = {}
        if not accounts:
            return out
        loans = session.exec(select(Loan).where(Loan.account_id.in_(list(accounts)))).all()
        for loan in loans:
            rows = amortization.schedule(
                loan.principal, loan.annual_rate, loan.term_months, loan.start_date
            )
            out[loan.account_id] = ComputedValuation(
                lambda d, rows=rows, orig=loan.origination_date: amortization.outstanding(
                    rows, d, orig
                )
            )
        return out
