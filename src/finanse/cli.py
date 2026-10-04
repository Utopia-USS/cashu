"""Command-line interface for the finance tracker.

The root app is the composition layer: core commands (database, server, data
dir, accounts, secrets) plus the commands of every registered module
(``core.modules``), and the cross-module ``stats`` report.
"""

from __future__ import annotations

import typer
from rich.table import Table

from .core import cli as core_cli
from .core import cliutil, modules, paths
from .core.db import get_session

app = typer.Typer(add_completion=False, help="Personal finance tracker — bank ingestion & stats.")


@app.callback()
def _main(ctx: typer.Context) -> None:
    # Data still in the legacy <repo>/data/ dir: say so on every command.
    notice = paths.legacy_notice()
    if notice and ctx.invoked_subcommand != "migrate-data":
        cliutil.err_console.print(f"[yellow]Notice:[/] {notice}")


core_cli.register(app)
for _spec in modules.all_modules():
    if _spec.cli is not None:
        _spec.cli(app)


# --------------------------------------------------------------------------- #
# Stats (cross-module report)
# --------------------------------------------------------------------------- #

@app.command("stats")
def stats_cmd(months: int = typer.Option(12, help="How many recent months to show.")) -> None:
    """Print net worth, monthly cashflow, and recurring-payment candidates."""
    from .core.networth import net_worth
    from .modules.budget.analytics import (
        detect_recurring,
        monthly_cashflow,
        reference_date,
        spending_by_category,
    )

    with get_session() as s:
        totals, lines = net_worth(s)
        cashflow = monthly_cashflow(s)
        recurring = detect_recurring(s)
        ref = reference_date(s)
        cats = spending_by_category(s, year=ref.year, month=ref.month) if ref else []

    nw = Table(title="Net worth")
    for col in ("account", "type", "currency", "as of", "balance"):
        nw.add_column(col)
    for ln in lines:
        nw.add_row(
            f"{ln.account.bank.value} · {ln.account.name}",
            ln.account.type.value,
            ln.account.currency,
            ln.as_of.isoformat() if ln.as_of else "—",
            cliutil.fmt(ln.contribution, ln.account.currency),
        )
    for currency, total in sorted(totals.items()):
        nw.add_row(f"[bold]TOTAL {currency}[/]", "", "", "", f"[bold]{cliutil.fmt(total, currency)}[/]")
    cliutil.console.print(nw)

    cf = Table(title="Monthly cashflow (internal transfers excluded)")
    for col in ("month", "income", "expense", "net"):
        cf.add_column(col)
    for mc in cashflow[-months:]:
        cf.add_row(mc.label, cliutil.fmt(mc.income), cliutil.fmt(mc.expense), cliutil.fmt(mc.net))
    cliutil.console.print(cf)

    if recurring:
        rt = Table(title="Recurring payment candidates (likely subscriptions)")
        for col in ("payee", "amount", "count", "~every", "last"):
            rt.add_column(col)
        for c in recurring[:25]:
            rt.add_row(
                c.counterparty, cliutil.fmt(c.typical_amount), str(c.occurrences),
                f"{c.median_gap_days}d", c.last_date.isoformat(),
            )
        cliutil.console.print(rt)

    if cats:
        ct = Table(title=f"Spending by category — {ref.year}-{ref.month:02d}")
        ct.add_column("category")
        ct.add_column("amount", justify="right")
        for c in cats[:15]:
            ct.add_row(c.label, cliutil.fmt(c.amount))
        cliutil.console.print(ct)


if __name__ == "__main__":
    app()
