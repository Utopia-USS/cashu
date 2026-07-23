"""Mortgage/loan amortization — annuity schedule, outstanding balance over time.

Pure functions; no DB. Used both for the net-worth liability (outstanding as of
today, so interest accrues and payments reduce it automatically) and for the
loan-tab payoff simulator (full schedule).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from dateutil.relativedelta import relativedelta

CENTS = Decimal("0.01")


def _dec(x) -> Decimal:
    return x if isinstance(x, Decimal) else Decimal(str(x))


def monthly_payment(principal, annual_rate_pct, term_months: int) -> Decimal:
    """Fixed annuity installment."""
    P = _dec(principal)
    i = _dec(annual_rate_pct) / Decimal("100") / Decimal("12")
    n = term_months
    if i == 0:
        return (P / n).quantize(CENTS, ROUND_HALF_UP)
    factor = (Decimal(1) + i) ** n
    return (P * i * factor / (factor - 1)).quantize(CENTS, ROUND_HALF_UP)


@dataclass
class ScheduleRow:
    n: int
    date: date
    payment: Decimal
    interest: Decimal
    principal: Decimal
    balance: Decimal


def schedule(principal, annual_rate_pct, term_months: int, start_date: date) -> list[ScheduleRow]:
    """Month-by-month amortization. First payment falls on start_date."""
    P = _dec(principal)
    i = _dec(annual_rate_pct) / Decimal("100") / Decimal("12")
    pay = monthly_payment(principal, annual_rate_pct, term_months)
    rows: list[ScheduleRow] = []
    bal = P
    for k in range(1, term_months + 1):
        interest = (bal * i).quantize(CENTS, ROUND_HALF_UP)
        principal_part = pay - interest
        this_pay = pay
        if k == term_months or principal_part >= bal:  # last / final settle
            principal_part = bal
            this_pay = (principal_part + interest).quantize(CENTS, ROUND_HALF_UP)
        bal = (bal - principal_part).quantize(CENTS, ROUND_HALF_UP)
        rows.append(
            ScheduleRow(
                n=k,
                date=start_date + relativedelta(months=k - 1),
                payment=this_pay,
                interest=interest,
                principal=principal_part.quantize(CENTS, ROUND_HALF_UP),
                balance=bal,
            )
        )
        if bal <= 0:
            break
    return rows


def outstanding(
    rows: list[ScheduleRow], as_of: date, origination_date: date | None = None
) -> Decimal:
    """Remaining principal owed as of `as_of`.

    - Before origination (disbursement): 0 (the loan didn't exist yet).
    - Between origination and the first installment: the full principal
      (debt taken on, no payment made yet).
    - After: the amortized balance following payments dated on/before `as_of`.

    origination_date defaults to the first installment date (no gap).
    """
    if not rows:
        return Decimal("0")
    orig = origination_date or rows[0].date
    if as_of < orig:
        return Decimal("0")
    original_principal = rows[0].balance + rows[0].principal
    if as_of < rows[0].date:
        return original_principal
    bal = rows[0].balance
    for r in rows:
        if r.date <= as_of:
            bal = r.balance
        else:
            break
    return bal


@dataclass
class LoanSummary:
    principal: Decimal
    annual_rate: Decimal
    term_months: int
    start_date: date
    monthly_payment: Decimal
    outstanding: Decimal
    months_elapsed: int
    paid_principal: Decimal
    paid_interest: Decimal
    total_interest: Decimal
    remaining_interest: Decimal
    payoff_date: date
    schedule: list[ScheduleRow]


def summarize(
    principal,
    annual_rate_pct,
    term_months: int,
    start_date: date,
    as_of: date,
    origination_date: date | None = None,
) -> LoanSummary:
    rows = schedule(principal, annual_rate_pct, term_months, start_date)
    P = _dec(principal)
    out = outstanding(rows, as_of, origination_date)
    elapsed = sum(1 for r in rows if r.date <= as_of)
    paid_interest = sum((r.interest for r in rows if r.date <= as_of), Decimal("0"))
    total_interest = sum((r.interest for r in rows), Decimal("0"))
    return LoanSummary(
        principal=P,
        annual_rate=_dec(annual_rate_pct),
        term_months=term_months,
        start_date=start_date,
        monthly_payment=monthly_payment(principal, annual_rate_pct, term_months),
        outstanding=out,
        months_elapsed=elapsed,
        paid_principal=(P - out).quantize(CENTS, ROUND_HALF_UP),
        paid_interest=paid_interest.quantize(CENTS, ROUND_HALF_UP),
        total_interest=total_interest.quantize(CENTS, ROUND_HALF_UP),
        remaining_interest=(total_interest - paid_interest).quantize(CENTS, ROUND_HALF_UP),
        payoff_date=rows[-1].date if rows else start_date,
        schedule=rows,
    )
