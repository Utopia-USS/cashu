"""Loans CLI commands (`set-loan` at the top level; `finanse loans ...` for the rest)."""

from __future__ import annotations

from datetime import date as _date
from decimal import Decimal
from typing import Annotated

import typer
from rich.table import Table

from finanse.core import cliutil
from finanse.core.db import get_session, init_db
from finanse.core.models import AccountType


def _parse_date(value: str | None, default: _date | None = None) -> _date | None:
    return _date.fromisoformat(value) if value else default


def _term_months(years: int | None, months: int | None) -> int:
    if months is not None:
        return months
    return (years if years is not None else 30) * 12


StartOption = Annotated[
    str | None,
    typer.Option("--start", help="First installment YYYY-MM-DD (default: 1st of this month)."),
]
OriginationOption = Annotated[
    str | None,
    typer.Option("--origination", help="Disbursement YYYY-MM-DD (debt exists from here)."),
]
YearsOption = Annotated[int | None, typer.Option(help="Loan term in years (default 30).")]
MonthsOption = Annotated[int | None, typer.Option(help="Loan term in months (wins over --years).")]
PaymentIbanOption = Annotated[
    str | None,
    typer.Option("--payment-iban", help="Lender account the installments go to (to recognise them)."),
]
PaymentTextOption = Annotated[
    str | None,
    typer.Option("--payment-text", help="Phrase in the installment title (to recognise them)."),
]


def _first_of_month() -> _date:
    return _date.today().replace(day=1)  # noqa: DTZ011 - local dates


def set_loan_cmd(
    account_id: int,
    principal: float,
    rate: float,
    years: YearsOption = None,
    months: MonthsOption = None,
    start: StartOption = None,
    origination: OriginationOption = None,
) -> None:
    """Set amortization terms for a loan account (drives the payoff simulator)."""
    from .service import set_loan

    sd = _parse_date(start, _first_of_month())
    od = _parse_date(origination)
    term = _term_months(years, months)
    init_db()
    with get_session() as s:
        try:
            set_loan(
                s, account_id, principal, rate, term, sd, origination_date=od,
                profile_id=cliutil.profile(s).id,
            )
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
    length = f"{term // 12} yr" if term % 12 == 0 else f"{term} mo"
    cliutil.console.print(
        f"[green]Loan[/] account {account_id}: {principal:,.0f} @ {rate}% / {length}, "
        f"1st installment {sd}" + (f", origination {od}" if od else "")
    )


def loans_list_cmd() -> None:
    """List the active profile's loans."""
    from .service import list_loans
    from .valuation import loan_valuation

    today = _date.today()  # noqa: DTZ011 - local dates
    with get_session() as s:
        rows = list_loans(s, cliutil.profile(s, create=False).id)
        table = Table(title="Loans")
        for col in ("id", "name", "type", "rate", "start", "term", "outstanding", "source"):
            table.add_column(col)
        for loan, acc in rows:
            val = loan_valuation(s, loan)
            table.add_row(
                str(loan.id), acc.name, str(acc.type), f"{loan.annual_rate}%",
                loan.start_date.isoformat(), f"{loan.term_months} mo",
                cliutil.fmt(val.at(today), acc.currency), val.source(today),
            )
    if not rows:
        cliutil.console.print("No loans. Add one: finanse loans add NAME --principal ... --rate ...")
        return
    cliutil.console.print(table)


def loans_add_cmd(
    principal: Annotated[float, typer.Option(help="Amount borrowed.")],
    rate: Annotated[float, typer.Option(help="Annual interest rate in percent, e.g. 6.5.")],
    name: Annotated[
        str | None,
        typer.Argument(help="New loan, e.g. 'Hipoteka' (or the exact name of an existing "
                            "mortgage/loan account to update)."),
    ] = None,
    account: Annotated[
        str | None,
        typer.Option("--account", help="Attach to an existing mortgage/loan account (id or "
                                       "exact name) instead of NAME."),
    ] = None,
    years: YearsOption = None,
    months: MonthsOption = None,
    start: StartOption = None,
    origination: OriginationOption = None,
    type: Annotated[str, typer.Option(help="mortgage | loan")] = AccountType.LOAN,
    currency: Annotated[str, typer.Option()] = "PLN",
    payment_iban: PaymentIbanOption = None,
    payment_text: PaymentTextOption = None,
) -> None:
    """Add (or update, same name) a loan: its account and its terms in one step.

    Terms only ever attach to a mortgage/loan account; a name already used by a
    property or savings account is refused (use --account for an existing one)."""
    from finanse.core.models import Account

    from .service import add_loan

    init_db()
    with get_session() as s:
        try:
            loan = add_loan(
                s, name=name, account=account, principal=principal, annual_rate=rate,
                term_months=_term_months(years, months),
                start_date=_parse_date(start, _first_of_month()),
                origination_date=_parse_date(origination), type=type, currency=currency,
                payment_iban=payment_iban, payment_text=payment_text,
                profile_id=cliutil.profile(s).id,
            )
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
        loan_id, account_id = loan.id, loan.account_id
        acc = s.get(Account, account_id)
        label, cur = acc.name, acc.currency
    cliutil.console.print(
        f"[green]Loan[/] '{label}' (loan id {loan_id}, account id {account_id}): "
        f"{cliutil.fmt(Decimal(str(principal)), cur)} @ {rate}%"
    )


def loans_set_payment_cmd(
    loan_id: int,
    iban: Annotated[
        str | None, typer.Option("--iban", help="Lender account (empty string clears).")
    ] = None,
    text: Annotated[
        str | None, typer.Option("--text", help="Title phrase (empty string clears).")
    ] = None,
) -> None:
    """Tell the budget how to recognise this loan's installments (then re-categorize)."""
    from .service import set_payment_matching

    if iban is None and text is None:
        raise typer.BadParameter("Give --iban and/or --text.")
    with get_session() as s:
        try:
            set_payment_matching(s, loan_id, iban=iban, text=text, profile_id=cliutil.profile(s).id)
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
    cliutil.console.print(
        f"[green]Loan {loan_id}[/]: installment matching saved. Run `finanse categorize` "
        "to apply it to existing transactions."
    )


def loans_set_balance_cmd(
    loan_id: int,
    amount: Annotated[float, typer.Argument(help="Outstanding amount from the bank.")],
    date: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
) -> None:
    """Record what the bank says is still owed; it wins over the schedule from that date."""
    from .service import record_balance

    with get_session() as s:
        try:
            record_balance(
                s, loan_id, amount, on_date=_parse_date(date), profile_id=cliutil.profile(s).id
            )
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
    cliutil.console.print(f"[green]Loan {loan_id}[/]: outstanding {amount:,.2f} recorded.")


def register(app: typer.Typer) -> None:
    """Top-level (legacy) commands."""
    app.command("set-loan")(set_loan_cmd)


def register_module(app: typer.Typer) -> None:
    """Commands of the `finanse loans` sub-app."""
    app.command("list")(loans_list_cmd)
    app.command("add")(loans_add_cmd)
    app.command("set-payment")(loans_set_payment_cmd)
    app.command("set-balance")(loans_set_balance_cmd)
    register(app)
