"""Loans CLI commands."""

from __future__ import annotations

import typer

from finanse.core import cliutil
from finanse.core.db import get_session, init_db


def set_loan_cmd(
    account_id: int,
    principal: float,
    rate: float,
    years: int = typer.Option(30, help="Loan term in years."),
    start: str = typer.Option(None, "--start", help="First installment YYYY-MM-DD (default: 1st of this month)."),
    origination: str = typer.Option(None, "--origination", help="Disbursement YYYY-MM-DD (debt exists from here)."),
) -> None:
    """Set amortization terms for a loan account (drives the payoff simulator)."""
    from datetime import date as _date

    from .service import set_loan

    sd = _date.fromisoformat(start) if start else _date.today().replace(day=1)
    od = _date.fromisoformat(origination) if origination else None
    init_db()
    with get_session() as s:
        set_loan(s, account_id, principal, rate, years * 12, sd, origination_date=od)
    cliutil.console.print(
        f"[green]Loan[/] account {account_id}: {principal:,.0f} @ {rate}% / {years} yr, "
        f"1st installment {sd}" + (f", origination {od}" if od else "")
    )


def register(app: typer.Typer) -> None:
    """Add these commands to `app` (the root CLI and/or a module sub-app)."""
    app.command("set-loan")(set_loan_cmd)
