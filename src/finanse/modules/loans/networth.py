"""Loans' net-worth contributor: a loan account is worth what is still owed (the
amortization schedule, anchored on balances recorded after the terms; see
``valuation``)."""

from __future__ import annotations

from collections.abc import Mapping

from sqlmodel import Session, select

from finanse.core.models import Account
from finanse.core.networth import Valuation

from .models import Loan
from .service import LOAN_TYPES
from .valuation import loan_valuation


class LoansContributor:
    def valuations(
        self, session: Session, accounts: Mapping[int, Account]
    ) -> dict[int, Valuation]:
        if not accounts:
            return {}
        # Terms are only honoured on mortgage/loan accounts: rows left on another type
        # (written before add_loan/set_loan checked it) must not replace its value.
        ids = [aid for aid, acc in accounts.items() if str(acc.type) in LOAN_TYPES]
        if not ids:
            return {}
        loans = session.exec(select(Loan).where(Loan.account_id.in_(ids))).all()
        return {loan.account_id: loan_valuation(session, loan) for loan in loans}
