"""``finanse invest backfill`` and ``finanse invest performance`` (registered by the investments CLI).

finanse invest backfill [--all]
finanse invest performance [--range 1y] [--account ID] [--attribution]
"""

from __future__ import annotations

from typing import Annotated

import typer
from rich.table import Table

from finanse.core import cliutil
from finanse.core.db import get_session, init_db


def _num(value: float | None) -> str:
    return "-" if value is None else f"{value:,.2f}".replace(",", " ")


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.2f}%"


def backfill_cmd(
    all_profiles: Annotated[
        bool, typer.Option("--all", help="Every profile with investments enabled.")
    ] = False,
) -> None:
    """Fetch the full price history (held, sold and benchmark instruments, from the first transaction
    on) and the FX rates performance needs; later runs only fetch what is new."""
    from . import backfill

    init_db()
    profile_ids = None
    if not all_profiles:
        with get_session() as s:
            profile = cliutil.profile(s, create=False)
        if profile.id == 0:
            cliutil.console.print("No profile yet.")
            raise typer.Exit(1)
        profile_ids = [profile.id]
    try:
        report = backfill.run_backfill(profile_ids=profile_ids)
    except backfill.BackfillBusy as e:
        cliutil.err_console.print(f"[yellow]{e}[/]: a backfill is running elsewhere.")
        raise typer.Exit(1) from None
    c = cliutil.console
    for b in report.benchmarks:
        c.print(f"benchmark {b.proxy} ({b.profile}): {b.status}", markup=False)
        if b.message:
            c.print(f"  {b.message}", markup=False)
    errors = 0
    for item in report.instruments:
        head = f" history {item.head[0]}..{item.head[1]}" if item.head else ""
        c.print(
            f"{item.label} [{item.role}]: {item.status}{head}, {item.bars_written} bar(s)",
            markup=False,
        )
        for message in item.messages:
            c.print(f"  {message}", markup=False)
        errors += item.status == "error"
    for f in report.fx:
        c.print(f"fx {f['currency']}: {f['status']}, {f['rates']} rate(s)", markup=False)
        errors += f["status"] == "error"
    if not report.instruments and not report.fx:
        c.print("Nothing to backfill (no investments history).")
    if errors:
        raise typer.Exit(1)


def performance_cmd(
    range_key: Annotated[str, typer.Option("--range", help="1m | 3m | ytd | 1y | 3y | max")] = "1y",
    account: Annotated[list[int] | None, typer.Option(help="Brokerage account id(s).")] = None,
    attribution: Annotated[
        bool, typer.Option("--attribution", help="Also list P/L by instrument and bucket.")
    ] = False,
) -> None:
    """Return vs the benchmark from stored data: TWR, XIRR, max drawdown, the same-cash-flow
    simulation, rolling relative performance and (with --attribution) P/L by instrument."""
    from ..service import views
    from . import service

    try:
        service.check_range(range_key)
    except service.RangeError as e:
        raise typer.BadParameter(str(e)) from None
    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        try:
            ids = views.account_filter(s, profile, ",".join(map(str, account)) if account else None)
        except LookupError as e:
            raise typer.BadParameter(str(e)) from None
        perf = service.performance_view(s, profile, range_key=range_key, account_ids=ids)
        attr = (
            service.attribution_view(s, profile, range_key=range_key, account_ids=ids)
            if attribution
            else None
        )
    c = cliutil.console
    summary = perf["summary"]
    if summary is None:
        c.print("No investments history yet.")
        return
    cur = perf["base_currency"]
    c.print(f"{perf['range']}: {perf['start']} .. {perf['end']} ({cur})")
    table = Table(show_header=True)
    table.add_column("")
    table.add_column("portfolio", justify="right")
    table.add_column("benchmark", justify="right")
    bench = perf["benchmark"]
    sim = bench.get("simulation") or {}
    bdd = bench.get("max_drawdown") or {}
    rows = [
        ("value", _num(summary["end_value"]), _num(sim.get("end_value"))),
        ("net contributions", _num(summary["net_contributions"]), ""),
        ("P/L", _num(summary["pnl"]), _num(sim.get("pnl"))),
        ("TWR", _pct(summary["twr"]), _pct(bench.get("twr"))),
        ("TWR p.a.", _pct(summary["twr_annualized"]), _pct(bench.get("twr_annualized"))),
        ("XIRR", _pct(summary["xirr"]), _pct(sim.get("xirr"))),
        ("money-weighted", _pct(summary["mwr"]), _pct(sim.get("mwr"))),
        ("max drawdown", _pct(summary["max_drawdown"]["depth"]), _pct(bdd.get("depth"))),
    ]
    for label, a, b in rows:
        table.add_row(label, a, b)
    c.print(table)
    if bench["status"] != "ok":
        c.print(f"benchmark: {bench['status']} - {bench['message']}", markup=False)
    else:
        c.print(f"benchmark: {bench['id']} via {bench['proxy']}", markup=False)
    for window in perf["rolling"]:
        if window["windows"]:
            c.print(
                f"rolling {window['months']}m: latest excess {_pct(window['latest_excess'])}, "
                f"outperformed in {_pct(window['share_outperforming'])} of {window['windows']} "
                "window(s)"
            )
    for note in (perf["data_quality"] or {}).get("notes", []):
        c.print(f"[yellow]![/] {note['message']}")
    if attr is None:
        return
    t = Table(show_header=True)
    for col in ("instrument", "bucket", "P/L", "share"):
        t.add_column(col, justify="right" if col in ("P/L", "share") else "left")
    for row in attr["instruments"]:
        t.add_row(row["label"], row["bucket"], _num(row["pnl"]), _pct(row["share_of_pnl"]))
    c.print(t)
    conc = attr["concentration"]
    top2 = next((x["share"] for x in conc["top"] if x["n"] == 2), None)
    c.print(
        f"top 2 share of P/L: {_pct(top2)}; P/L without them: {_num(conc['pnl_without_top2'])} "
        f"({_pct(conc['pnl_without_top2_pct_of_contributions'])} of contributions); benchmark: "
        f"{_num(conc['benchmark_pnl'])} ({_pct(conc['benchmark_pnl_pct_of_contributions'])})"
    )


def register(app: typer.Typer) -> None:
    """Add the performance commands to the ``finanse invest`` sub-app."""
    app.command("backfill")(backfill_cmd)
    app.command("performance")(performance_cmd)
