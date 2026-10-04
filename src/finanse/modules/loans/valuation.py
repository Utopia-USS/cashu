"""What a loan account is worth (owed) on a given date.

The amortization schedule gives the outstanding principal for any date. A
balance recorded for the loan account *after* its terms were last set (a bank
statement entered with ``set-balance``, or a statement import) is more
authoritative than the model: from its date on the loan is worth that figure,
reduced by the principal the schedule repays after it. Balances recorded before
the terms (e.g. the placeholder value given to ``add-position``) are superseded by
the terms and ignored, as before.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core.models import Balance

from . import amortization
from .models import Loan

ZERO = Decimal("0.00")


def _naive_utc(ts: dt.datetime) -> dt.datetime:
    """Stored timestamps come back naive (UTC); fresh objects are aware."""
    return ts.astimezone(dt.UTC).replace(tzinfo=None) if ts.tzinfo else ts


class LoanValuation:
    def __init__(self, loan: Loan, anchors: list[tuple[dt.date, Decimal]]):
        self.loan = loan
        self.rows = amortization.schedule(
            loan.principal, loan.annual_rate, loan.term_months, loan.start_date
        )
        self.anchors = sorted(anchors)

    def scheduled(self, d: dt.date) -> Decimal:
        return amortization.outstanding(self.rows, d, self.loan.origination_date)

    def anchor(self, d: dt.date) -> tuple[dt.date, Decimal] | None:
        last = None
        for ad, amount in self.anchors:
            if ad <= d:
                last = (ad, amount)
            else:
                break
        return last

    def at(self, d: dt.date) -> Decimal:
        anchor = self.anchor(d)
        if anchor is None:
            return self.scheduled(d)
        ad, amount = anchor
        repaid_since = self.scheduled(ad) - self.scheduled(d)
        return max(ZERO, abs(amount) - repaid_since)

    def latest(self, as_of: dt.date | None) -> tuple[dt.date, Decimal]:
        ref = as_of or dt.date.today()  # noqa: DTZ011 - naive local date, like the booking dates
        return ref, self.at(ref)

    def axis_dates(self) -> list[dt.date]:
        return [d for d, _ in self.anchors]

    def source(self, d: dt.date) -> str:
        """"recorded" when a recorded balance drives the value at ``d``, else "schedule"."""
        return "recorded" if self.anchor(d) is not None else "schedule"


def loan_valuation(session: Session, loan: Loan) -> LoanValuation:
    terms_set = _naive_utc(loan.updated_at)
    by_date: dict[dt.date, tuple[dt.datetime, Decimal]] = {}
    for b in session.exec(select(Balance).where(Balance.account_id == loan.account_id)).all():
        recorded = _naive_utc(b.created_at)
        if recorded <= terms_set:
            continue
        current = by_date.get(b.date)
        if current is None or recorded >= current[0]:
            by_date[b.date] = (recorded, b.amount)  # latest recorded figure per day
    return LoanValuation(loan, [(d, amount) for d, (_ts, amount) in by_date.items()])
