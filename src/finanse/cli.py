"""Command-line interface for the finance tracker.

The root app is the composition layer: core commands (database, server, data
dir, accounts, secrets) plus the commands of every registered module
(``core.modules``), and the cross-module ``stats`` report.
"""

from __future__ import annotations

from typing import Annotated

import typer
from rich.table import Table

from .core import cli as core_cli
from .core import cliutil, modules, paths
from .core.db import get_session
from .core.mcp import cli as mcp_cli
from .core.workspace import cli as workspace_cli
from .desktop import cli as desktop_cli

app = typer.Typer(add_completion=False, help="Personal finance tracker — bank ingestion & stats.")


@app.callback()
def _main(
    ctx: typer.Context,
    profile: Annotated[
        str | None,
        typer.Option(
            "--profile",
            "-p",
            help="Profile (slug) to work on. Default: FINANSE_PROFILE, else the oldest profile.",
        ),
    ] = None,
) -> None:
    cliutil.set_profile(profile)
    # Data still in the legacy <repo>/data/ dir: say so on every command.
    notice = paths.legacy_notice()
    if notice and ctx.invoked_subcommand != "migrate-data":
        cliutil.err_console.print(f"[yellow]Notice:[/] {notice}")


# Core commands, then every module's commands: at the top level (the upstream
# command names keep working) and as a sub-app per module (`finanse loans list`).
core_cli.register(app)
mcp_cli.register(app)  # finanse mcp --profile <slug>
desktop_cli.register(app)  # finanse app (desktop window), finanse skills
workspace_cli.register(app)  # finanse workspace init|update|path
for _spec in modules.all_modules():
    if _spec.cli is None and _spec.cli_module is None:
        continue
    if _spec.cli is not None:
        _spec.cli(app)
    _sub = typer.Typer(help=_spec.cli_help or _spec.name, no_args_is_help=True)
    (_spec.cli_module or _spec.cli)(_sub)
    app.add_typer(_sub, name=_spec.cli_name or _spec.id)


# --------------------------------------------------------------------------- #
# Stats (cross-module report)
# --------------------------------------------------------------------------- #

@app.command("stats")
def stats_cmd(
    months: Annotated[int, typer.Option(help="How many recent months to show.")] = 12,
) -> None:
    """Print net worth, monthly cashflow, recurring payments and spending, per currency."""
    from sqlmodel import select

    from .core.networth import net_worth
    from .core.profiles import account_ids_query
    from .modules.budget.analytics import (
        detect_recurring,
        monthly_cashflow,
        reference_date,
        spending_by_category,
    )
    from .modules.budget.models import Transaction

    with get_session() as s:
        pid = cliutil.profile(s, create=False).id
        totals, lines = net_worth(s, profile_id=pid)
        currencies = sorted(set(s.exec(
            select(Transaction.currency).where(Transaction.account_id.in_(account_ids_query(pid)))
        ).all()))
        cashflow = {c: monthly_cashflow(s, currency=c, profile_id=pid) for c in currencies}
        recurring = detect_recurring(s, profile_id=pid)
        ref = reference_date(s, profile_id=pid)
        cats = {
            c: spending_by_category(s, currency=c, year=ref.year, month=ref.month, profile_id=pid)
            for c in currencies
        } if ref else {}

    nw = Table(title="Net worth")
    for col in ("account", "type", "currency", "as of", "balance"):
        nw.add_column(col)
    for ln in lines:
        nw.add_row(
            f"{ln.account.bank} · {ln.account.name}",
            str(ln.account.type),
            ln.account.currency,
            ln.as_of.isoformat() if ln.as_of else "—",
            cliutil.fmt(ln.contribution, ln.account.currency),
        )
    for currency, total in sorted(totals.items()):
        nw.add_row(f"[bold]TOTAL {currency}[/]", "", "", "", f"[bold]{cliutil.fmt(total, currency)}[/]")
    cliutil.console.print(nw)

    # One table per currency: amounts in different currencies are never mixed.
    for currency in currencies:
        rows = cashflow[currency][-months:]
        if not rows:
            continue
        cf = Table(title=f"Monthly cashflow {currency} (internal transfers excluded)")
        for col in ("month", "income", "expense", "net"):
            cf.add_column(col)
        for mc in rows:
            cf.add_row(
                mc.label, cliutil.fmt(mc.income, currency), cliutil.fmt(mc.expense, currency),
                cliutil.fmt(mc.net, currency),
            )
        cliutil.console.print(cf)

    if recurring:
        rt = Table(title="Recurring payment candidates (likely subscriptions)")
        for col in ("payee", "amount", "count", "~every", "last"):
            rt.add_column(col)
        for c in recurring[:25]:
            rt.add_row(
                c.counterparty, cliutil.fmt(c.typical_amount, c.currency), str(c.occurrences),
                f"{c.median_gap_days}d", c.last_date.isoformat(),
            )
        cliutil.console.print(rt)

    for currency, spend in cats.items():
        if not spend:
            continue
        ct = Table(title=f"Spending by category — {ref.year}-{ref.month:02d} ({currency})")
        ct.add_column("category")
        ct.add_column("amount", justify="right")
        for c in spend[:15]:
            ct.add_row(c.label, cliutil.fmt(c.amount, currency))
        cliutil.console.print(ct)


if __name__ == "__main__":
    app()
