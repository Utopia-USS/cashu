"""``cashu mcp --profile <slug>``: serve one profile to an agent over MCP (stdio).

Add it to Claude Code with ``claude mcp add cashu-<slug> -- cashu mcp --profile <slug>``. The
profile is required (no silent default: a server must never serve another profile than the one it was
started for). stdout carries the protocol only; logs go to stderr.
"""

from __future__ import annotations

import logging
import sys
from typing import Annotated

import typer

from .. import cliutil


def mcp_cmd(
    profile: Annotated[
        str | None,
        typer.Option("--profile", "-p", help="Profile (slug) this server serves. Required."),
    ] = None,
) -> None:
    """Serve a profile's data to an AI agent over MCP (stdio), redacted by its privacy level."""
    root = cliutil._profile_slug  # the root `cashu --profile` option, if given
    if profile and root and profile != root:
        cliutil.err_console.print("[red]Two different profiles given (--profile twice).[/]")
        raise typer.Exit(2)
    slug = profile or root
    if not slug:
        cliutil.err_console.print(
            "[red]cashu mcp needs --profile <slug>[/] (one MCP server per profile)."
        )
        raise typer.Exit(2)
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    from .. import profiles
    from ..db import get_session, init_db

    init_db()
    with get_session() as s:
        if profiles.get_by_slug(s, slug) is None:
            known = ", ".join(p.slug for p in profiles.list_profiles(s)) or "none yet"
            cliutil.err_console.print(f"[red]No profile '{slug}'.[/] Profiles: {known}.")
            raise typer.Exit(1)
    from .server import run_stdio

    run_stdio(slug)


def register(app: typer.Typer) -> None:
    app.command("mcp")(mcp_cmd)
