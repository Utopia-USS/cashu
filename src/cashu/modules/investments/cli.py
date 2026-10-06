"""Investments CLI: the ``cashu invest ...`` sub-app (no top-level commands).

cashu invest accounts add NAME --broker xtb [--wrapper ike] [--currency PLN]
cashu invest accounts list
cashu invest import FILE --account ID [--mapping m.yaml] [--importer auto] [--dry-run]
cashu invest validate FILE [--mapping m.yaml]
cashu invest positions [--account ID]
cashu invest signals
cashu invest strategy init [--template passive_etf] [--force]
cashu invest strategy validate
cashu invest run [--offline] [--all]
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer
from rich.table import Table

from cashu.core import cliutil
from cashu.core.db import get_session, init_db

from .templates import STRATEGY_TEMPLATE_NAMES


def _num(value: float | None, digits: int = 2) -> str:
    return "-" if value is None else f"{value:,.{digits}f}".replace(",", " ")


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


# --------------------------------------------------------------------------- #
# accounts
# --------------------------------------------------------------------------- #


def accounts_add_cmd(
    name: Annotated[str, typer.Argument(help="e.g. 'XTB IKE'.")],
    broker: Annotated[
        str, typer.Option(help="Broker or exchange id: dif, xtb, binance, zonda, manual.")
    ],
    wrapper: Annotated[str, typer.Option(help="regular | ike | ikze | oipe | other")] = "regular",
    currency: Annotated[str, typer.Option(help="Account (reporting) currency.")] = "PLN",
) -> None:
    """Add a brokerage account to the active profile."""
    from .service import accounts

    init_db()
    with get_session() as s:
        try:
            acc = accounts.add_account(
                s,
                cliutil.profile(s).id,
                name=name,
                broker=broker,
                wrapper=wrapper,
                currency=currency,
            )
        except accounts.AccountError as e:
            raise typer.BadParameter(str(e)) from None
        account_id = acc.id
    cliutil.console.print(
        f"[green]Brokerage account[/] '{name}' (id {account_id}, {broker}, {wrapper})."
    )


def accounts_list_cmd() -> None:
    """List the active profile's brokerage accounts."""
    from .service import views

    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        rows = views.accounts_view(s, profile)
    if not rows:
        cliutil.console.print(
            "No brokerage accounts. Add one: cashu invest accounts add NAME --broker xtb"
        )
        return
    table = Table(title="Brokerage accounts")
    for col in (
        "id",
        "name",
        "broker",
        "wrapper",
        "currency",
        "importer",
        "snapshot",
        "last import",
    ):
        table.add_column(col)
    for r in rows:
        table.add_row(
            str(r["id"]),
            r["name"],
            r["broker_name"],
            r["wrapper"],
            r["currency"],
            r["importer"] or "-",
            r["snapshot_date"] or "-",
            (r["last_import"] or {}).get("at", "-")[:10],
        )
    cliutil.console.print(table)


# --------------------------------------------------------------------------- #
# import / validate
# --------------------------------------------------------------------------- #


def _read_mapping(mapping: Path | None) -> str | None:
    if mapping is None:
        return None
    try:
        return mapping.read_text(encoding="utf-8")
    except OSError as e:
        raise typer.BadParameter(f"Cannot read the mapping: {e}") from None


def import_cmd(
    file: Annotated[
        Path,
        typer.Argument(
            exists=True, dir_okay=False, help="cashu-import CSV/JSON or a CSV export."
        ),
    ],
    account: Annotated[
        int,
        typer.Option("--account", "-a", help="Brokerage account id (see `invest accounts list`)."),
    ],
    mapping: Annotated[Path | None, typer.Option(help="Generic CSV mapping (YAML).")] = None,
    importer: Annotated[str, typer.Option(help="auto | cashu | generic_csv")] = "auto",
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Preview only, write nothing.")
    ] = False,
    apply_corrections: Annotated[
        bool, typer.Option(help="Also apply every reconciliation correction the preview proposes.")
    ] = False,
) -> None:
    """Import a broker file into a brokerage account (preview, then commit)."""
    from .importing import ImportFile
    from .service import imports

    init_db()
    request = imports.ImportRequest(
        ImportFile(file.name, file.read_bytes()), account, importer, _read_mapping(mapping)
    )
    with get_session() as s:
        profile = cliutil.profile(s)
        try:
            preview = imports.preview(s, profile, request)
        except imports.ImportFailure as e:
            raise typer.BadParameter(str(e)) from None
    plan = preview.plan
    c = cliutil.console
    c.print(f"{file.name}: importer {preview.importer_id or '-'}")
    if plan is not None:
        c.print(
            f"  rows: {len(plan.rows)}, new: {plan.new_count}, duplicates: {plan.duplicate_count}, "
            f"positions: {len(plan.positions)}, renames: {len(plan.renames)}, "
            f"delistings: {len(plan.status_changes)}, new instruments: {len(plan.new_instruments)}"
        )
        for inst in plan.new_instruments:
            c.print(f"  new instrument: {inst.label} ({inst.currency}, {inst.asset_class.value})")
    for w in preview.warnings:
        c.print(f"  [yellow]warning[/] {w}")
    for e in preview.errors:
        c.print(f"  [red]error[/] {e}")
    corrections: list[str] = []
    if preview.reconciliation is not None:
        for d in preview.reconciliation.mismatches:
            label = (
                plan.instruments[d.instrument_id].label
                if d.instrument_id in plan.instruments
                else d.instrument_id
            )
            c.print(
                f"  reconciliation {label}: broker {d.broker_quantity}, history {d.computed_quantity} "
                f"(delta {d.delta})"
            )
        corrections = [x.diff.instrument_id for x in preview.reconciliation.corrections]
    if not preview.can_commit:
        c.print("[red]Not imported[/]: fix the errors above.")
        raise typer.Exit(1)
    if dry_run:
        c.print("Dry run: nothing written.")
        return
    try:
        result = imports.commit(preview, corrections=corrections if apply_corrections else ())
    except imports.ImportFailure as e:
        raise typer.BadParameter(str(e)) from None
    c.print(
        f"[green]Imported[/] {result.inserted} transaction(s) (batch {result.batch_id}), "
        f"{result.duplicates} duplicate(s) skipped, {len(result.new_instrument_ids)} new instrument(s), "
        f"{result.corrections} correction(s). Archived: {result.archive_path}"
    )


def validate_cmd(
    file: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    mapping: Annotated[Path | None, typer.Option(help="Generic CSV mapping (YAML).")] = None,
) -> None:
    """Check an import file without a database (exit 1 when it cannot be imported)."""
    from .importing import CsvMapping, CsvMappingError, validate_import_file

    mapping_obj = None
    text = _read_mapping(mapping)
    if text is not None:
        try:
            mapping_obj = CsvMapping.from_yaml(text)
        except CsvMappingError as e:
            for issue in e.issues:
                cliutil.console.print(f"mapping {issue.path}: {issue.message}")
            raise typer.Exit(1) from None
    report = validate_import_file(file, mapping=mapping_obj)
    cliutil.console.print(report.summary(), markup=False, highlight=False)
    if not report.ok:
        raise typer.Exit(1)


# --------------------------------------------------------------------------- #
# positions / signals
# --------------------------------------------------------------------------- #


def positions_cmd(
    account: Annotated[
        int | None, typer.Option("--account", "-a", help="Only this brokerage account.")
    ] = None,
) -> None:
    """Positions of the active profile (values in the base currency, stored prices)."""
    from .service import views

    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        try:
            ids = views.account_filter(s, profile, str(account) if account is not None else None)
        except LookupError as e:
            raise typer.BadParameter(str(e)) from None
        data = views.positions(s, profile, account_ids=ids)
    base = data["base_currency"]
    if not data["positions"] and not data["cash"]:
        cliutil.console.print(
            "No positions yet. Import a file: cashu invest import FILE --account ID"
        )
        return
    table = Table(title=f"Positions as of {data['as_of']} ({base})")
    for col in ("instrument", "class", "qty", "price", "date", f"value {base}", "weight", "result"):
        table.add_column(col)
    for r in data["positions"]:
        inst = r["instrument"]
        table.add_row(
            inst["label"],
            inst["asset_class"],
            _num(r["quantity"], 4),
            f"{_num(r['price'], 4)} {r['price_currency'] or ''}".strip(),
            (r["price_date"] or "-") + (" (stale)" if r["is_stale"] else ""),
            _num(r["value"]),
            _pct(r["weight"]),
            _pct(r["unrealized_pct"]),
        )
    for c in data["cash"]:
        table.add_row(
            f"cash {c['account_name'] or ''}".strip(),
            "cash",
            _num(c["amount"]),
            c["currency"],
            "",
            _num(c["amount_base"]),
            "",
            "",
        )
    table.add_row("[bold]total[/]", "", "", "", "", f"[bold]{_num(data['total'])}[/]", "", "")
    cliutil.console.print(table)


def signals_cmd(
    history: Annotated[
        bool, typer.Option("--history", help="Resolved and expired signals.")
    ] = False,
) -> None:
    """Open signals of the active profile (or their history)."""
    from .service import views

    init_db()
    with get_session() as s:
        rows = views.signals_view(
            s, cliutil.profile(s, create=False), "history" if history else "open"
        )
    if not rows:
        cliutil.console.print("No signals.")
        return
    table = Table(title="Signals")
    for col in ("id", "severity", "status", "rule", "message", "since"):
        table.add_column(col)
    for r in rows:
        table.add_row(
            str(r["id"]),
            r["severity"],
            r["status"],
            r["rule_id"],
            r["message"],
            (r["first_seen_at"] or "")[:10],
        )
    cliutil.console.print(table)


# --------------------------------------------------------------------------- #
# strategy
# --------------------------------------------------------------------------- #


def strategy_init_cmd(
    template: Annotated[
        str, typer.Option(help=f"One of: {', '.join(STRATEGY_TEMPLATE_NAMES)}.")
    ] = "passive_etf",
    force: Annotated[bool, typer.Option(help="Overwrite existing strategy files.")] = False,
) -> None:
    """Write strategy.yaml / strategy.md for the active profile from a template."""
    from .service import strategy

    init_db()
    with get_session() as s:
        slug = cliutil.profile(s).slug
    try:
        written = strategy.init_files(slug, template, force=force)
    except KeyError as e:
        raise typer.BadParameter(str(e.args[0])) from None
    except strategy.StrategyExists as e:
        raise typer.BadParameter(f"{e} (use --force to overwrite)") from None
    for path in written:
        cliutil.console.print(f"[green]Written[/] {path}")


def strategy_validate_cmd() -> None:
    """Validate the active profile's strategy files (exit 1 when invalid); stores a new version when
    they changed."""
    from .service import strategy

    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        st = strategy.load(s, profile, record=profile.id != 0)
    c = cliutil.console
    if st.state == "missing":
        c.print(f"No strategy yet ({st.yaml_path}). Create one: cashu invest strategy init")
        raise typer.Exit(1)
    version = f" (version {st.version.version})" if st.version is not None else ""
    c.print(f"strategy.yaml: {st.state}{version}", highlight=False)
    if st.read_error:
        c.print(f"  error {st.read_error}", markup=False)
    for issue in st.issues:
        c.print(f"  {issue}", markup=False, highlight=False)
    for rule in st.inactive_rules:
        c.print(f"  inactive rule {rule.rule_id or rule.index} (line {rule.line})", markup=False)
    if st.state == "invalid":
        raise typer.Exit(1)


# --------------------------------------------------------------------------- #
# run
# --------------------------------------------------------------------------- #


def run_cmd(
    offline: Annotated[
        bool, typer.Option("--offline", help="No market refresh: stored prices only.")
    ] = False,
    all_profiles: Annotated[
        bool, typer.Option("--all", help="Every profile with investments enabled (worker mode).")
    ] = False,
) -> None:
    """Run the daily check now: market refresh, valuation, rules, signals."""
    from .service import daily

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
        report = daily.run_daily_check("cli", profile_ids=profile_ids, offline=offline)
    except daily.RunBusy as e:
        cliutil.err_console.print(f"[yellow]{e}[/]: the daily check is running elsewhere.")
        raise typer.Exit(1) from None
    c = cliutil.console
    if report.market is not None:
        stats = report.market.to_stats()
        c.print(
            f"market: {stats['instruments_ok']} ok, {stats['instruments_no_data']} no data, "
            f"{stats['instruments_skipped']} skipped, {stats['instruments_error']} error(s); "
            f"fx {stats['fx_ok']} ok, {stats['fx_error']} error(s)"
        )
    elif report.market_error:
        c.print(f"[yellow]market refresh failed:[/] {report.market_error}")
    for p in report.profiles:
        s = p.stats
        c.print(
            f"{p.slug}: {p.status} (strategy {p.strategy}); holdings {s.get('holdings', 0)}, "
            f"total {s.get('total_base', '-')} {s.get('base_currency', '')}; "
            f"signals new {s.get('signals_new', 0)}, escalated {s.get('signals_escalated', 0)}, "
            f"resolved {s.get('signals_resolved', 0)}"
        )
        for sig in p.new_signals + p.escalated_signals:
            c.print(f"  [{sig['severity']}] {sig['message']}", markup=False)
        for err in p.errors:
            c.print(f"  [yellow]![/] {err}")
    if any(p.status == "failed" for p in report.profiles):
        raise typer.Exit(1)


def register_module(app: typer.Typer) -> None:
    """Commands of the `cashu invest` sub-app."""
    from .performance.cli import register as register_performance  # backfill, performance

    register_performance(app)
    accounts_app = typer.Typer(help="Brokerage accounts.", no_args_is_help=True)
    strategy_app = typer.Typer(
        help="Strategy files (strategy.yaml + strategy.md).", no_args_is_help=True
    )
    accounts_app.command("add")(accounts_add_cmd)
    accounts_app.command("list")(accounts_list_cmd)
    strategy_app.command("init")(strategy_init_cmd)
    strategy_app.command("validate")(strategy_validate_cmd)
    app.add_typer(accounts_app, name="accounts")
    app.add_typer(strategy_app, name="strategy")
    app.command("import")(import_cmd)
    app.command("validate")(validate_cmd)
    app.command("positions")(positions_cmd)
    app.command("signals")(signals_cmd)
    app.command("run")(run_cmd)
    from .cli_alerts import register as register_alerts  # alerts, watchlist

    register_alerts(app)
