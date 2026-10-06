"""``finanse connectors add|list|show|remove|disable|test|secret set``.

There is deliberately no ``approve`` command: a connector is approved only by the owner in the app
(Settings > Konektory), after looking at its code. ``test`` runs a connector directory (also an
unapproved one) in the same sandbox and prints only a value-free report.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated

import typer
from rich.table import Table

from .. import cliutil

connectors_app = typer.Typer(
    help="Connectors: third-party converters / API fetchers the app runs after the owner approves "
    "them in the app.",
    no_args_is_help=True,
)
secret_app = typer.Typer(help="Secrets of a connector binding (OS keychain).", no_args_is_help=True)
connectors_app.add_typer(secret_app, name="secret")


def _fail(message: str, issues=()) -> None:
    cliutil.err_console.print(f"[red]{message}[/]")
    for issue in issues:
        cliutil.err_console.print(f"  - {issue}")
    raise typer.Exit(1)


@connectors_app.command("add")
def add_cmd(
    directory: Annotated[Path, typer.Argument(help="Connector directory (with connector.yaml).")],
    replace: Annotated[
        bool, typer.Option("--replace", help="Update an installed connector (keeps its bindings).")
    ] = False,
) -> None:
    """Install a connector (pending until the owner approves it in the app)."""
    from ..db import init_db
    from . import service

    init_db()
    try:
        done = service.install(directory, replace=replace, source="cli")
    except service.ConnectorError as e:
        _fail(str(e), e.issues)
    c = done.connector
    verb = "Updated" if done.replaced else "Installed"
    cliutil.console.print(
        f"[green]{verb}[/] {c.id} {c.version} ({c.module}, {c.kind}): status [bold]{c.status}[/], "
        f"sha256 {c.content_sha256[:12]}, interpreter {c.interpreter_path}"
    )
    if c.status != "approved":
        cliutil.console.print("Approve it in the app: Ustawienia > Konektory.")


@connectors_app.command("list")
def list_cmd() -> None:
    """Installed connectors and their status."""
    from ..db import get_session, init_db
    from . import service

    init_db()
    with get_session() as s:
        rows = service.list_connectors(s)
    if not rows:
        cliutil.console.print("No connectors installed (finanse connectors add <dir>).")
        return
    table = Table(title="Connectors")
    for column in ("id", "name", "version", "module", "kind", "status", "bindings", "last run"):
        table.add_column(column)
    for r in rows:
        last = r["last_run"]
        table.add_row(
            r["id"], r["name"], r["version"], r["module"], r["kind"],
            r["status"] + (" (content changed)" if r["content_changed"] else ""),
            str(r["bindings"]),
            f"{last['command']} {last['outcome']}" if last else "-",
        )
    cliutil.console.print(table)


@connectors_app.command("show")
def show_cmd(connector_id: Annotated[str, typer.Argument(help="Connector id.")]) -> None:
    """Manifest facts, files and status of one connector."""
    from ..db import get_session, init_db
    from . import service

    init_db()
    with get_session() as s:
        try:
            d = service.detail_dict(s, connector_id)
        except service.ConnectorError as e:
            _fail(str(e), e.issues)
    out = cliutil.console
    out.print(f"[bold]{d['id']}[/] {d['version']}: {d['name']}")
    changed = " (content changed since approval)" if d["content_changed"] else ""
    out.print(f"  module {d['module']}, kind {d['kind']}, status [bold]{d['status']}[/]{changed}")
    out.print(f"  run: {' '.join(d['run'] or [])} (timeout {d['timeout_s']} s)")
    out.print(f"  interpreter: {d['interpreter_path']}")
    out.print(f"  content sha256: {d['content_sha256']}")
    if d["approved_sha256"]:
        out.print(f"  approved sha256: {d['approved_sha256']} ({d['approved_at']})")
    if d["extensions"]:
        out.print(f"  extensions: {', '.join(d['extensions'])}")
    if d["hosts"]:
        out.print(f"  hosts: {', '.join(d['hosts'])}")
        out.print(f"  secrets: {', '.join(s['id'] for s in d['secrets']) or '-'}")
    for problem in d["problems"]:
        out.print(f"  [red]problem[/] {problem}")
    if d["diff"]:
        for key in ("added", "removed", "modified"):
            if d["diff"][key]:
                out.print(f"  {key} since approval: {', '.join(d['diff'][key])}")
    out.print(f"  files ({len(d['files'])}):")
    for f in d["files"]:
        out.print(f"    {f['path']}  {f['size']} B  {f['sha256'][:12]}")


@connectors_app.command("disable")
def disable_cmd(connector_id: Annotated[str, typer.Argument(help="Connector id.")]) -> None:
    """Stop a connector from running (approve it again in the app to enable it)."""
    from ..db import init_db
    from . import service

    init_db()
    try:
        service.disable(connector_id)
    except service.ConnectorError as e:
        _fail(str(e), e.issues)
    cliutil.console.print(f"{connector_id}: disabled")


@connectors_app.command("remove")
def remove_cmd(
    connector_id: Annotated[str, typer.Argument(help="Connector id.")],
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Do not ask for confirmation.")] = False,
) -> None:
    """Remove a connector: its files, bindings, their secrets and its run log."""
    from ..db import init_db
    from . import service

    init_db()
    if not yes and not typer.confirm(
        f"Remove {connector_id} with its bindings and their secrets?", default=False
    ):
        raise typer.Exit(1)
    try:
        removed = service.remove(connector_id)
    except service.ConnectorError as e:
        _fail(str(e), e.issues)
    cliutil.console.print(f"{connector_id}: removed ({removed.bindings} bindings)")
    if removed.secrets_left:
        cliutil.err_console.print(
            f"[yellow]{removed.secrets_left} keychain entries could not be deleted.[/]"
        )


@connectors_app.command("test")
def test_cmd(
    directory: Annotated[Path, typer.Argument(help="Connector directory (also an unapproved one).")],
    file: Annotated[
        Path | None, typer.Option("--file", help="Export file to detect + convert (file kind).")
    ] = None,
    module: Annotated[
        str | None, typer.Option("--module", help="Expected module (investments | budget).")
    ] = None,
    fixture: Annotated[
        Path | None,
        typer.Option("--fixture", help="Recorded synthetic API response, given as the `fixture` "
                     "param of an offline fetch (fetch kind)."),
    ] = None,
    check_manifest: Annotated[
        bool, typer.Option("--check-manifest", help="Only validate the manifest and the directory.")
    ] = False,
) -> None:
    """Run a connector in the sandbox and print a value-free report (counts and problem kinds only)."""
    from . import devtest

    report = devtest.run_test(
        directory, file=file, module=module, fixture=fixture, check_manifest=check_manifest
    )
    if report.runs:
        _record_test_runs(directory, report)
    typer.echo(report.text())
    raise typer.Exit(0 if report.ok else 1)


def _record_test_runs(directory: Path, report) -> None:
    """Developer runs go to the run log too (no profile); a failing DB never hides the report."""
    from ..db import init_db
    from . import manifest as mf
    from . import service

    try:
        init_db()
        cid = mf.load_dir(directory).manifest.id
        for result in report.runs:
            service.record_run(result, cid)
    except Exception as e:  # noqa: BLE001 - the report matters more than its log row
        cliutil.err_console.print(f"[yellow]Run not recorded ({type(e).__name__}).[/]")


@secret_app.command("set")
def secret_set_cmd(
    binding: Annotated[int, typer.Argument(help="Binding id (see the app, Ustawienia > Konektory).")],
    secret_id: Annotated[str, typer.Argument(help="Secret id from the connector's manifest.")],
    stdin: Annotated[
        bool, typer.Option("--stdin", help="Read the value from standard input (scripts).")
    ] = False,
) -> None:
    """Store a secret of a binding of the active profile in the OS keychain (hidden input)."""
    from .. import secrets
    from ..db import get_session, init_db
    from . import service

    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
    try:
        service.get_binding(profile, binding)
    except service.ConnectorError as e:
        _fail(str(e), e.issues)
    value = sys.stdin.readline() if stdin else typer.prompt(secret_id, hide_input=True)
    value = value.strip()
    if not value:
        _fail("Empty value, nothing stored.")
    try:
        now_set = service.set_binding_secrets(profile, binding, {secret_id: value})
    except service.ConnectorError as e:
        _fail(str(e), e.issues)
    except secrets.SecretsError as e:
        _fail(str(e))
    cliutil.console.print(
        f"[green]Stored[/] {secret_id} for binding {binding} in the keychain; set: {', '.join(now_set)}"
    )


def register(app: typer.Typer) -> None:
    app.add_typer(connectors_app, name="connectors")
