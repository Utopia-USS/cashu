"""Loans CLI commands."""

from __future__ import annotations

from typing import Annotated

import typer

from finanse.core import cliutil
from finanse.core.db import get_session, init_db


def set_loan_cmd(
    account_id: int,
    principal: float,
    rate: float,
    years: Annotated[int, typer.Option(help="Loan term in years.")] = 30,
    start: Annotated[
        str | None,
        typer.Option("--start", help="First installment YYYY-MM-DD (default: 1st of this month)."),
    ] = None,
    origination: Annotated[
        str | None,
        typer.Option("--origination", help="Disbursement YYYY-MM-DD (debt exists from here)."),
    ] = None,
) -> None:
    """Set amortization terms for a loan account (drives the payoff simulator)."""
    from datetime import date as _date

    from .service import set_loan

    sd = _date.fromisoformat(start) if start else _date.today().replace(day=1)  # noqa: DTZ011
    od = _date.fromisoformat(origination) if origination else None
    init_db()
    with get_session() as s:
        try:
            set_loan(
                s, account_id, principal, rate, years * 12, sd, origination_date=od,
                profile_id=cliutil.profile(s).id,
            )
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
    cliutil.console.print(
        f"[green]Loan[/] account {account_id}: {principal:,.0f} @ {rate}% / {years} yr, "
        f"1st installment {sd}" + (f", origination {od}" if od else "")
    )


def register(app: typer.Typer) -> None:
    """Add these commands to `app` (the root CLI and/or a module sub-app)."""
    app.command("set-loan")(set_loan_cmd)
