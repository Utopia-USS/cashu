"""Core CLI commands: database, server, data dir, accounts, balances, secrets."""

from __future__ import annotations

import enum
import os
import sys
from typing import Annotated

import typer
from rich.table import Table
from sqlmodel import select

from ..config import settings
from . import account_types, cliutil, paths
from .accounts import get_account
from .db import get_session, init_db
from .models import Account

secrets_app = typer.Typer(help="Secrets in the OS keychain (instead of .env).")
profiles_app = typer.Typer(help="Profiles (a person or household: accounts, modules, privacy).")


def init_db_cmd() -> None:
    """Create the SQLite database and tables."""
    from . import db

    init_db()
    cliutil.console.print(f"[green]Database ready[/] at {db.engine.url.render_as_string(hide_password=True)}")


def serve_cmd(
    host: Annotated[
        str | None,
        typer.Option(envvar="FINANSE_HOST", show_default="127.0.0.1", help="Interface to bind."),
    ] = None,
    port: Annotated[
        int | None, typer.Option(envvar="FINANSE_PORT", show_default="8500", help="Port.")
    ] = None,
    reload: Annotated[bool, typer.Option(help="Auto-reload on code changes (dev).")] = False,
) -> None:
    """Launch the web dashboard (net worth, cashflow, subscriptions).

    Loopback only; every API call needs the per-launch token, which the served
    page carries and which is written to <data dir>/api-token for local tools."""
    import uvicorn

    from . import security

    host = host or settings.host
    port = port or settings.port
    init_db()
    cfg = security.configure(port=port)
    token_file = security.write_token_file(cfg.token)
    if host not in security.LOOPBACK_HOSTS:
        cliutil.console.print(
            f"[yellow]Binding to {host}:[/] the API only answers requests addressed to "
            "127.0.0.1/localhost, so other machines cannot use the dashboard."
        )
    if reload:  # the reloader re-imports the app in a worker process
        os.environ[security.TOKEN_ENV] = cfg.token
        os.environ["FINANSE_PORT"] = str(port)
    cliutil.console.print(f"[green]Dashboard:[/] http://127.0.0.1:{port}")
    cliutil.console.print(f"[dim]Data dir: {paths.data_dir()} (API token: {token_file.name})[/]")
    try:
        uvicorn.run("finanse.api.app:app", host=host, port=port, reload=reload)
    finally:
        security.remove_token_file(cfg.token, token_file)


def migrate_data_cmd(
    force: Annotated[
        bool,
        typer.Option(help="Replace a database already in the data dir (backed up first)."),
    ] = False,
) -> None:
    """Copy legacy data from the repo's data/ dir into the per-user data dir.

    Copies the database (with a timestamped backup), Open Banking sessions and
    private key. migrate-data does not change the originals; if this version
    already upgraded the legacy database in place, it names the copy from before
    that upgrade."""
    from . import legacy

    try:
        result = legacy.migrate_legacy_data(force=force)
    except legacy.MigrationError as e:
        cliutil.console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    cliutil.console.print(f"[green]Migrated[/] {result.source} -> {result.database}")
    cliutil.console.print(f"  backup: {result.backup}")
    if result.replaced_backup:
        cliutil.console.print(f"  previous data-dir database backed up to {result.replaced_backup}")
    cliutil.console.print(f"  tables: {', '.join(f'{k}={v}' for k, v in sorted(result.tables.items()))}")
    for p in result.copied:
        cliutil.console.print(f"  copied: {p}")
    for s in result.skipped:
        cliutil.console.print(f"  [yellow]skipped:[/] {s}")
    legacy_dir = result.source.parent
    if not result.upgraded_in_place:
        cliutil.console.print(
            f"The files in {legacy_dir} were not changed; delete them once the dashboard "
            f"looks right (the backup above keeps a copy)."
        )
    elif result.pre_upgrade_backup is not None:
        cliutil.console.print(
            f"The legacy database in {legacy_dir} had already been upgraded in place by this "
            f"version; its copy from before that upgrade is {result.pre_upgrade_backup}. "
            f"Delete {legacy_dir} once the dashboard looks right (that copy stays)."
        )
    else:
        cliutil.console.print(
            f"[yellow]The legacy database in {legacy_dir} had already been upgraded in place "
            "by this version and no copy from before that upgrade was found.[/] Keep "
            f"{legacy_dir} if you may go back to the upstream version."
        )
    cliutil.console.print(
        "Settings pointing at the old defaults (data/finanse.db, data/enablebanking_private.pem) "
        "are ignored from now on. Restart `finanse serve` if it is running."
    )


def accounts_cmd() -> None:
    """List the active profile's accounts."""
    with get_session() as s:
        pid = cliutil.profile(s, create=False).id
        rows = s.exec(select(Account).where(Account.profile_id == pid)).all()
    table = Table(title="Accounts")
    for col in ("id", "bank", "name", "iban", "type", "currency", "active"):
        table.add_column(col)
    for a in rows:
        table.add_row(
            str(a.id), a.bank, a.name, a.iban or "—",
            str(a.type), a.currency, "yes" if a.active else "no",
        )
    cliutil.console.print(table)


def _profile_account(session, account_id: int) -> Account:
    try:
        return get_account(session, account_id, profile_id=cliutil.profile(session).id)
    except ValueError:
        raise typer.BadParameter(f"No account with id {account_id}") from None


def set_account_type(account_id: int, account_type: str) -> None:
    """Set an account's type (checking/savings/credit/investment/...)."""
    known = account_types.ids()
    if account_type not in known:
        raise typer.BadParameter(f"Unknown account type '{account_type}'. Known: {', '.join(known)}.")
    with get_session() as s:
        acc = _profile_account(s, account_id)
        acc.type = account_type
        s.add(acc)
    cliutil.console.print(f"[green]Account {account_id} -> {account_type}[/]")


def set_account_name(account_id: int, name: str) -> None:
    """Give an account a human-friendly name."""
    with get_session() as s:
        acc = _profile_account(s, account_id)
        acc.name = name
        s.add(acc)
    cliutil.console.print(f"[green]Account {account_id} -> '{name}'[/]")


def set_balance_cmd(
    account_id: int,
    value: float,
    date: Annotated[str | None, typer.Option("--date", help="YYYY-MM-DD (default: today).")] = None,
) -> None:
    """Record a balance snapshot (update a mortgage, revalue a property, ...)."""
    from datetime import date as _date
    from decimal import Decimal

    from .accounts import set_balance

    on_date = _date.fromisoformat(date) if date else None
    with get_session() as s:
        try:
            acc = set_balance(
                s, account_id, value, on_date=on_date, profile_id=cliutil.profile(s).id
            )
        except ValueError as e:
            raise typer.BadParameter(str(e)) from None
        cliutil.console.print(
            f"[green]{acc.name}[/] -> {cliutil.fmt(Decimal(str(value)), acc.currency)}"
        )


# --------------------------------------------------------------------------- #
# Profiles
# --------------------------------------------------------------------------- #

@profiles_app.command("list")
def profiles_list_cmd() -> None:
    """List profiles (* = the default for commands run without --profile)."""
    from . import profiles

    init_db()
    with get_session() as s:
        rows = profiles.list_profiles(s)
        default = profiles.default_profile(s)
        table = Table(title="Profiles")
        for col in ("", "slug", "name", "currency", "agent privacy", "modules"):
            table.add_column(col)
        for p in rows:
            table.add_row(
                "*" if default is not None and p.id == default.id else "",
                p.slug, p.name, p.base_currency, p.mcp_privacy,
                ", ".join(profiles.enabled_modules(s, p.id)) or "-",
            )
    if not rows:
        cliutil.console.print("No profiles yet. Add one: finanse profiles add NAME")
        return
    cliutil.console.print(table)


@profiles_app.command("add")
def profiles_add_cmd(
    name: Annotated[str, typer.Argument(help="Display name, e.g. 'Jan' or 'Dom'.")],
    currency: Annotated[
        str,
        typer.Option(help="Base currency: the net worth headline (other currencies are "
                          "shown separately, not converted)."),
    ] = "PLN",
    modules_: Annotated[
        str,
        typer.Option("--modules", help="Comma-separated module ids (budget,assets,loans,...)."),
    ] = "budget,assets,loans",
    privacy: Annotated[
        str, typer.Option(help="What MCP tools may send: strict | amounts.")
    ] = "strict",
) -> None:
    """Create a profile (its slug is derived from the name)."""
    from . import profiles

    init_db()
    wanted = [m.strip() for m in modules_.split(",") if m.strip()]
    with get_session() as s:
        try:
            p = profiles.create_profile(
                s, name=name, base_currency=currency, modules_=wanted, mcp_privacy=privacy
            )
        except profiles.ProfileError as e:
            raise typer.BadParameter(str(e)) from None
        slug, enabled = p.slug, profiles.enabled_modules(s, p.id)
    cliutil.console.print(
        f"[green]Profile[/] '{name}' -> slug [bold]{slug}[/] (modules: {', '.join(enabled) or '-'}). "
        f"Use it with: finanse --profile {slug} ..."
    )


# --------------------------------------------------------------------------- #
# Secrets (OS keychain)
# --------------------------------------------------------------------------- #

class SecretName(str, enum.Enum):
    ANTHROPIC = "anthropic"  # Anthropic API key (categorization backend `anthropic`)


@secrets_app.command("set")
def secrets_set_cmd(
    name: SecretName,
    stdin: Annotated[
        bool, typer.Option("--stdin", help="Read the value from standard input (scripts).")
    ] = False,
) -> None:
    """Store a secret in the OS keychain (asked for with hidden input)."""
    from . import secrets

    value = sys.stdin.readline() if stdin else typer.prompt(f"{name.value}", hide_input=True)
    value = value.strip()
    if not value:
        cliutil.console.print("[red]Empty value, nothing stored.[/]")
        raise typer.Exit(1)
    try:
        secrets.set_secret(name.value, value)
    except secrets.SecretsError as e:
        cliutil.console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    cliutil.console.print(f"[green]Stored[/] {name.value} in the keychain ({secrets.mask(value)}).")


@secrets_app.command("get")
def secrets_get_cmd(
    name: SecretName,
    reveal: Annotated[bool, typer.Option(help="Print the full value.")] = False,
) -> None:
    """Show whether a secret is stored (masked unless --reveal)."""
    from . import secrets

    value = secrets.get_secret(name.value)
    if value is None:
        hint = ""
        if name is SecretName.ANTHROPIC and settings.resolved_api_key:
            hint = " (an environment variable fallback is set)"
        cliutil.console.print(f"{name.value}: not in the keychain{hint}")
        raise typer.Exit(1)
    if reveal:
        typer.echo(value)
    else:
        cliutil.console.print(f"{name.value}: stored in the keychain ({secrets.mask(value)})")


@secrets_app.command("delete")
def secrets_delete_cmd(name: SecretName) -> None:
    """Remove a secret from the OS keychain."""
    from . import secrets

    try:
        removed = secrets.delete_secret(name.value)
    except secrets.SecretsError as e:
        cliutil.console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    cliutil.console.print(f"{name.value}: {'deleted' if removed else 'was not stored'}")


def register(app: typer.Typer) -> None:
    """Add these commands to `app` (the root CLI and/or a module sub-app)."""
    app.command("init-db")(init_db_cmd)
    app.command("serve")(serve_cmd)
    app.command("migrate-data")(migrate_data_cmd)
    app.command("accounts")(accounts_cmd)
    app.command("set-account-type")(set_account_type)
    app.command("set-account-name")(set_account_name)
    app.command("set-balance")(set_balance_cmd)
    app.add_typer(profiles_app, name="profiles")
    app.add_typer(secrets_app, name="secrets")

    from .worker.cli import worker_app

    app.add_typer(worker_app, name="worker")
