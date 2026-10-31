"""``cashu sync status|link|seed|ack|prune|apply``: the Python side of the sync bridge (S30 outbox, S31b
inbound applier).

TRANSITIONAL(S49). Developer / shipper commands, so plain English output (no catalog): counts and
flags only, never values.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from . import cliutil, sync_apply, sync_outbox
from .db import get_session, init_db

sync_app = typer.Typer(
    help="Sync bridge (developer preview, CASHU_SYNC=1): status, vault link, shipper acks, inbound apply.",
    no_args_is_help=True,
)


@sync_app.command("status")
def status_cmd(
    as_json: Annotated[bool, typer.Option("--json", help="Machine-readable counts.")] = False,
) -> None:
    """Pending / acked outbox rows per profile, rows without a gid, vault and salt presence."""
    from sqlmodel import select

    from .models import Profile

    init_db()
    with get_session() as s:
        report = sync_outbox.status(s)
        slugs = {p.id: p.slug for p in s.exec(select(Profile)).all()}
    if as_json:
        out = dict(report)
        out["profiles"] = {
            (slugs.get(pid, str(pid)) if pid is not None else "shared"): v
            for pid, v in report["profiles"].items()
        }
        typer.echo(json.dumps(out, sort_keys=True, default=str))
        return
    typer.echo(f"capture: {'on' if report['enabled'] else 'off'} (CASHU_SYNC=1 turns it on)")
    if not report["tables"]:
        typer.echo("the database has no outbox tables yet (run `cashu init-db`)")
        return
    if not report["profiles"]:
        typer.echo("outbox empty")
    for pid, v in sorted(report["profiles"].items(), key=lambda kv: (kv[0] is None, kv[0] or 0)):
        who = slugs.get(pid, str(pid)) if pid is not None else "shared"
        vault = "linked" if v.get("vault") else "not linked"
        salt = "" if not v.get("vault") else (", salt in keychain" if v.get("salt") else ", no salt")
        typer.echo(
            f"{who}: {v['pending']} pending ({v['without_gid']} without gid), {v['acked']} acked; "
            f"vault {vault}{salt}"
        )
    typer.echo(f"gid map entries: {report.get('ids', 0)}")


@sync_app.command("link")
def link_cmd(
    vault_id: Annotated[str, typer.Argument(help="The profile's vault id (32 lower-case hex).")],
) -> None:
    """Record which vault the current profile (``--profile``) is."""
    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        try:
            sync_outbox.link_vault(s, profile.id, vault_id)
        except ValueError as e:
            cliutil.err_console.print(f"[red]{e}[/]")
            raise typer.Exit(1) from None
        typer.echo(f"{profile.slug}: vault linked")


@sync_app.command("ack")
def ack_cmd(
    through: Annotated[int, typer.Option(help="Ack every outbox row with id <= this.")],
    ids: Annotated[
        Path | None,
        typer.Option(help="JSON lines {profile_id, table, local_id, gid} the shipper computed."),
    ] = None,
) -> None:
    """Mark outbox rows as shipped (the shipper, S31a) and store the gids it computed."""
    init_db()
    gids = []
    if ids is not None:
        gids = [json.loads(line) for line in ids.read_text(encoding="utf-8").splitlines() if line.strip()]
    with get_session() as s:
        try:
            n = sync_outbox.ack(s, through, gids)
        except (ValueError, KeyError) as e:
            cliutil.err_console.print(f"[red]{e}[/]")
            raise typer.Exit(1) from None
    typer.echo(f"acked {n} row(s), {len(gids)} gid(s) stored")


@sync_app.command("seed")
def seed_cmd(
    ids: Annotated[
        Path,
        typer.Option(help="The genesis exporter's ids.jsonl of this profile's vault (S26)."),
    ],
) -> None:
    """Seed the gid map of the current profile (``--profile``) from a genesis export and link its
    vault, so existing rows resolve for the outbox and the inbound applier. All or nothing: any
    conflict writes nothing and exits 1. Counts only."""
    init_db()
    entries = [json.loads(line) for line in ids.read_text(encoding="utf-8").splitlines() if line.strip()]
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        try:
            counts = sync_outbox.seed_ids(s, profile.id, entries)
        except ValueError as e:
            cliutil.err_console.print(f"[red]{e}[/]")
            raise typer.Exit(1) from None
    typer.echo(json.dumps(counts, sort_keys=True))
    if counts["conflicts"]:
        cliutil.err_console.print("[red]conflicting mappings: nothing was seeded[/]")
        raise typer.Exit(1)


@sync_app.command("prune")
def prune_cmd() -> None:
    """Delete acked outbox rows (unacked rows are never deleted)."""
    init_db()
    with get_session() as s:
        n = sync_outbox.prune(s)
    typer.echo(f"pruned {n} acked row(s)")


@sync_app.command("apply")
def apply_cmd(
    stdin: Annotated[
        bool, typer.Option("--stdin", help="Read the events as JSON lines from standard input.")
    ] = False,
) -> None:
    """Apply events of other devices (JSON lines of logical envelopes, a JSON array = one batch) to
    the current profile (``--profile``) through the app's services; parked events are retried.
    Prints one JSON line of counts (never values)."""
    import sys

    if not stdin:
        cliutil.err_console.print("[red]give --stdin (the sync daemon pipes the events)[/]")
        raise typer.Exit(2)
    init_db()
    with get_session() as s:
        profile = cliutil.profile(s, create=False)
        pid = profile.id
    if not pid:  # None or profiles.NO_PROFILE
        cliutil.err_console.print("[red]no profile to apply to[/]")
        raise typer.Exit(1)
    try:
        summary = sync_apply.apply_lines(sys.stdin, profile_id=pid)
    except sync_apply.SyncApplyError as e:
        cliutil.err_console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    typer.echo(json.dumps(summary, sort_keys=True))
