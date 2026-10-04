"""Loans: amortization terms attached to MORTGAGE/LOAN accounts (many per profile)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlmodel import Session, select

from finanse.core import profiles
from finanse.core.accounts import get_account, get_or_create_account, upsert_balance
from finanse.core.institutions import MANUAL
from finanse.core.models import Account, AccountType, Source, utcnow
from finanse.core.text import normalize_iban

from . import amortization
from .models import Loan
from .valuation import loan_valuation

LOAN_TYPES = (AccountType.MORTGAGE, AccountType.LOAN)


def set_loan(
    session: Session,
    account_id: int,
    principal,
    annual_rate,
    term_months: int,
    start_date: date,
    origination_date: date | None = None,
    *,
    profile_id: int | None = None,
    payment_iban: str | None = None,
    payment_text: str | None = None,
) -> Loan:
    """Create/update amortization terms for a loan account of the profile.

    start_date = first installment date; origination_date = disbursement (debt
    exists from then). Between them the full principal is owed (no payment yet).
    Payment matching (``payment_iban`` / ``payment_text``) is only changed when
    given.
    """
    get_account(session, account_id, profile_id=profile_id)  # ValueError if not ours
    loan = session.exec(select(Loan).where(Loan.account_id == account_id)).first()
    if loan is None:
        loan = Loan(account_id=account_id, principal=Decimal(0), annual_rate=Decimal(0),
                    term_months=term_months, start_date=start_date)
    loan.principal = Decimal(str(principal))
    loan.annual_rate = Decimal(str(annual_rate))
    loan.term_months = term_months
    loan.start_date = start_date
    loan.origination_date = origination_date
    loan.updated_at = utcnow()  # balances recorded before this are superseded by the terms
    if payment_iban is not None:
        loan.payment_iban = normalize_iban(payment_iban) or None
    if payment_text is not None:
        loan.payment_text = payment_text.strip() or None
    session.add(loan)
    session.flush()
    return loan


def add_loan(
    session: Session,
    *,
    name: str,
    principal,
    annual_rate,
    term_months: int,
    start_date: date,
    origination_date: date | None = None,
    type: str = AccountType.LOAN,
    currency: str = "PLN",
    payment_iban: str | None = None,
    payment_text: str | None = None,
    profile_id: int | None = None,
) -> Loan:
    """Create (or update) a named loan in one step: its liability account plus the
    terms. Re-running with the same name updates that loan."""
    if str(type) not in LOAN_TYPES:
        raise ValueError(f"A loan account is 'mortgage' or 'loan', not '{type}'")
    pid = profiles.scope(session, profile_id, create=True)
    account = get_or_create_account(
        session,
        bank=MANUAL,
        name=name,
        external_id=f"manual:{name}",
        type=type,
        currency=currency,
        profile_id=pid,
    )
    return set_loan(
        session, account.id, principal, annual_rate, term_months, start_date, origination_date,
        profile_id=pid, payment_iban=payment_iban, payment_text=payment_text,
    )


def get_loan(session: Session, loan_id: int, *, profile_id: int | None = None) -> Loan:
    """A loan of the profile by its id; ValueError otherwise."""
    loan = session.get(Loan, loan_id)
    if loan is None:
        raise ValueError(f"No loan with id {loan_id}")
    try:
        get_account(session, loan.account_id, profile_id=profile_id)
    except ValueError:
        raise ValueError(f"No loan with id {loan_id}") from None
    return loan


def set_payment_matching(
    session: Session,
    loan_id: int,
    *,
    iban: str | None = None,
    text: str | None = None,
    profile_id: int | None = None,
) -> Loan:
    """How the budget recognises this loan's installments (empty string clears)."""
    loan = get_loan(session, loan_id, profile_id=profile_id)
    if iban is not None:
        loan.payment_iban = normalize_iban(iban) or None
    if text is not None:
        loan.payment_text = text.strip() or None
    session.add(loan)
    return loan


def list_loans(session: Session, profile_id: int | None = None) -> list[tuple[Loan, Account]]:
    """The profile's loans with their accounts, oldest first."""
    pid = profiles.scope(session, profile_id)
    rows = session.exec(
        select(Loan, Account)
        .where(Loan.account_id == Account.id, Account.profile_id == pid)
        .order_by(Loan.id)
    ).all()
    return [(loan, account) for loan, account in rows]


def record_balance(
    session: Session, loan_id: int, amount, *, on_date: date | None = None,
    profile_id: int | None = None,
) -> Loan:
    """Record what the bank says is still owed (wins over the schedule from that date)."""
    loan = get_loan(session, loan_id, profile_id=profile_id)
    account = session.get(Account, loan.account_id)
    upsert_balance(
        session, account, on_date or date.today(),  # noqa: DTZ011 - local dates
        Decimal(str(amount)), source=Source.MANUAL,
    )
    return loan


def loan_summary(session: Session, loan: Loan, account: Account | None, as_of: date) -> dict:
    """The API shape of one loan (the upstream ``/api/loan`` fields plus identity).

    ``outstanding`` is what net worth uses: the schedule, or a balance recorded after
    the terms (``balance_source`` says which); ``schedule_outstanding`` is the pure
    schedule."""
    from finanse.core.api import f

    summ = amortization.summarize(
        loan.principal, loan.annual_rate, loan.term_months, loan.start_date, as_of,
        origination_date=loan.origination_date,
    )
    valuation = loan_valuation(session, loan)
    outstanding = valuation.at(as_of)
    return {
        "id": loan.id,
        "account_id": loan.account_id,
        "name": account.name if account else None,
        "type": str(account.type) if account else None,
        "has_loan": True,
        "currency": account.currency if account else "PLN",
        "principal": f(summ.principal),
        "annual_rate": f(summ.annual_rate),
        "term_months": summ.term_months,
        "monthly_payment": f(summ.monthly_payment),
        "start_date": summ.start_date.isoformat(),
        "outstanding": f(outstanding),
        "schedule_outstanding": f(summ.outstanding),
        "balance_source": valuation.source(as_of),
        "months_elapsed": summ.months_elapsed,
        "paid_principal": f(summ.paid_principal),
        "paid_interest": f(summ.paid_interest),
        "remaining_interest": f(summ.remaining_interest),
        "total_interest": f(summ.total_interest),
        "payoff_date": summ.payoff_date.isoformat(),
        "payment_iban_tail": (loan.payment_iban or "")[-4:] or None,
        "payment_text": loan.payment_text,
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
