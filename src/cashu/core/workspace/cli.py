"""``cashu workspace init|update|path``: the profile's agent workspace for Claude Code."""

from __future__ import annotations

from typing import Annotated

import typer

from .. import cliutil

workspace_app = typer.Typer(
    help="Per-profile agent workspace for Claude Code (CLAUDE.md, MCP server, skills).",
    no_args_is_help=True,
)

ProfileOption = Annotated[
    str | None,
    typer.Option("--profile", "-p", help="Profile (slug). Default: the root --profile option."),
]
ForceOption = Annotated[
    bool,
    typer.Option(
        help="Replace managed skills edited in the workspace (a backup goes to "
        ".claude/cashu-backup/)."
    ),
]

_ACTIONS = {
    "created": "[green]created[/]",
    "updated": "[green]updated[/]",
    "replaced": "[green]replaced[/]",
    "removed": "removed",
    "backed_up": "[yellow]backed up[/]",
    "kept": "[yellow]kept[/]",
    "released": "[yellow]kept (edited, now yours)[/]",
}


def _slug(profile: str | None) -> str | None:
    root = cliutil._profile_slug
    if profile and root and profile != root:
        cliutil.err_console.print("[red]Two different profiles given (--profile twice).[/]")
        raise typer.Exit(2)
    return profile or root


def _run(profile: str | None, *, path: str | None, force: bool, routine: bool | None) -> None:
    from ..db import get_session, init_db
    from . import service

    init_db()
    cliutil.set_profile(_slug(profile))
    with get_session() as s:
        p = cliutil.profile(s, create=False)
        if p.id == 0:
            cliutil.err_console.print(
                "[red]No profile yet.[/] Create one with `cashu profiles add`."
            )
            raise typer.Exit(1)
        try:
            result = service.apply(s, p, path=path, force=force, routine=routine)
        except service.WorkspaceError as e:
            cliutil.err_console.print(f"[red]{e}[/]")
            raise typer.Exit(1) from None
    for change in result["changes"]:
        label = _ACTIONS.get(change["action"], change["action"])
        cliutil.console.print(f"{label}  {change['kind']} {change['name']}")
    if not result["changes"]:
        cliutil.console.print("Workspace is up to date.")
    if result.get("moved_from"):
        cliutil.console.print(
            f"The previous workspace stays where it was: {result['moved_from']}",
            soft_wrap=True,
            markup=False,
        )
    left = [i for i in result["outdated"] if i["reason"] in ("modified", "conflict")]
    for item in left:
        cliutil.console.print(
            f"[yellow]{item['kind']} {item['name']}: {item['reason']}[/] (--force replaces it, "
            "with a backup)"
        )
    cliutil.console.print(f"Workspace: {result['path']}", soft_wrap=True, markup=False)
    cliutil.console.print(
        f"Start Claude Code there: {result['claude_command']}", soft_wrap=True, markup=False
    )


RoutineOption = Annotated[
    bool | None,
    typer.Option(
        "--routine-permissions/--no-routine-permissions",
        help="Let the unattended Saturday research routine search the web and write notes in "
        "research/ and notes/ without asking (default: off; omitted = keep the current choice).",
        show_default=False,
    ),
]


@workspace_app.command("init")
def init_cmd(
    profile: ProfileOption = None,
    path: Annotated[
        str | None,
        typer.Option(help="Folder for the workspace (default: ~/Documents/cashU/<slug>)."),
    ] = None,
    force: ForceOption = False,
    routine_permissions: RoutineOption = None,
) -> None:
    """Create the profile's workspace (or update it when it exists)."""
    _run(profile, path=path, force=force, routine=routine_permissions)


@workspace_app.command("update")
def update_cmd(
    profile: ProfileOption = None,
    force: ForceOption = False,
    routine_permissions: RoutineOption = None,
) -> None:
    """Refresh the managed files (CLAUDE.md sections, .mcp.json, settings, skills); user files
    stay as they are."""
    _run(profile, path=None, force=force, routine=routine_permissions)


@workspace_app.command("path")
def path_cmd(profile: ProfileOption = None) -> None:
    """Print the workspace folder (also before it is created)."""
    from ..db import get_session, init_db
    from . import service

    init_db()
    cliutil.set_profile(_slug(profile))
    with get_session() as s:
        p = cliutil.profile(s, create=False)
        if p.id == 0:
            cliutil.err_console.print("[red]No profile yet.[/]")
            raise typer.Exit(1)
        typer.echo(str(service.workspace_path(p.slug)))


def register(app: typer.Typer) -> None:
    app.add_typer(workspace_app, name="workspace")
