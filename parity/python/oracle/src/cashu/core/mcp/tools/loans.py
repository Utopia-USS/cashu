"""Loans MCP tool: ``loans_summary`` (adapter over ``modules.loans.service``)."""

from __future__ import annotations

from decimal import Decimal

from cashu.core import profiles

from .. import labels as L
from ..registry import ToolContext, ToolSpec


def _average_monthly_income(ctx: ToolContext, currency: str, months: int = 3) -> Decimal | None:
    from cashu.modules.budget.analytics import monthly_cashflow

    rows = monthly_cashflow(ctx.session, currency=currency, profile_id=ctx.profile_id)[-months:]
    income = sum((r.income for r in rows), Decimal(0))
    return income / len(rows) if rows and income else None


def loans_summary(ctx: ToolContext) -> dict:
    from cashu.modules.loans import amortization
    from cashu.modules.loans.service import list_loans
    from cashu.modules.loans.valuation import loan_valuation

    budget_on = "budget" in profiles.enabled_modules(ctx.session, ctx.profile_id)
    labels = ctx.account_labels
    incomes: dict[str, Decimal | None] = {}
    items = []
    for loan, account in list_loans(ctx.session, ctx.profile_id):
        summ = amortization.summarize(
            loan.principal,
            loan.annual_rate,
            loan.term_months,
            loan.start_date,
            ctx.today,
            origination_date=loan.origination_date,
        )
        valuation = loan_valuation(ctx.session, loan)
        outstanding = valuation.at(ctx.today)
        currency = account.currency if account else "PLN"
        income_share = L.pct(None)
        if budget_on:
            if currency not in incomes:
                incomes[currency] = _average_monthly_income(ctx, currency)
            income_share = L.share(summ.monthly_payment, incomes[currency])
        items.append(
            {
                "loan_id": L.ref(loan.id),
                "account": L.account(labels.get(loan.account_id)),
                "name": L.identifier(account.name if account else None),
                "type": L.category(str(account.type) if account else None),
                "currency": L.category(currency),
                "annual_rate_pct": L.pct(summ.annual_rate, 4),
                "term_months": L.count(summ.term_months),
                "months_elapsed": L.count(summ.months_elapsed),
                "remaining_months": L.count(max(0, summ.term_months - summ.months_elapsed)),
                "payoff_date": L.date(summ.payoff_date),
                "paid_share_of_principal": L.share(summ.paid_principal, summ.principal),
                "outstanding_share_of_principal": L.share(outstanding, summ.principal),
                "installment_share_of_income": income_share,
                "balance_source": L.category(valuation.source(ctx.today)),
                "payment_account": L.identifier(loan.payment_iban),
                "payment_text": L.identifier(loan.payment_text),
                "principal": L.amount(summ.principal),
                "outstanding": L.amount(outstanding),
                "monthly_payment": L.amount(summ.monthly_payment),
                "remaining_interest": L.amount(summ.remaining_interest),
            }
        )
    note = (
        "installment_share_of_income: monthly installment vs the average monthly income of the last 3 "
        "months (budget module)"
        if budget_on
        else "installment_share_of_income needs the budget module"
    )
    return {"loans": items, "base_note": L.text(note)}


TOOLS = (
    ToolSpec(
        "loans_summary",
        "loans",
        "Per loan: interest rate, remaining months, payoff date, paid share, installment as a share "
        "of income (when the budget module is on).",
        loans_summary,
    ),
)
