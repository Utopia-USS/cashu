"""``cashu app`` (desktop window) and ``cashu skills`` (the bundled Claude Code skills)."""

from __future__ import annotations

import filecmp
import shutil
from pathlib import Path
from typing import Annotated

import typer

from ..core import cliutil, runtime
from ..core.env import env
from . import DEBUG_ENV

skills_app = typer.Typer(
    help="Claude Code setup skills shipped with cashU.", no_args_is_help=True
)

DEFAULT_SKILLS_DEST = Path("~/.claude/skills")


def app_cmd(
    debug: Annotated[
        bool,
        typer.Option(
            help="Developers: allow the WebKit inspector and log requests to the app log. "
            f"Same as {DEBUG_ENV}=1."
        ),
    ] = False,
) -> None:
    """Open the dashboard in a desktop window (the packaged app's default).

    The server runs inside this process on 127.0.0.1 (random port, per-launch token) and stops
    when the window is closed. One window per data dir."""
    from . import shell

    debug = debug or env(DEBUG_ENV) == "1"
    log_file = shell.setup_logging(requests=debug)
    try:
        launch = shell.run(debug=debug, log_file=log_file)
    except shell.AlreadyRunning as e:
        cliutil.err_console.print(f"[yellow]{e}[/]")
        raise typer.Exit(0 if e.focused else 1) from None
    except shell.DesktopError as e:
        cliutil.err_console.print(f"[red]{e}[/]")
        raise typer.Exit(1) from None
    if launch.error:
        cliutil.err_console.print(f"[red]{launch.error}[/] (log: {log_file})")
        raise typer.Exit(1)


def _same_tree(a: Path, b: Path) -> bool:
    cmp = filecmp.dircmp(a, b)
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    _match, mismatch, errors = filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)
    if mismatch or errors:
        return False
    return all(_same_tree(a / d, b / d) for d in cmp.common_dirs)


def _skill_dirs(source: Path) -> list[Path]:
    return sorted(p for p in source.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


@skills_app.command("path")
def skills_path_cmd() -> None:
    """Print where the shipped skills are (inside the app, or .claude/skills in a checkout)."""
    source = runtime.skills_dir()
    if source is None:
        cliutil.err_console.print("[red]No skills found in this installation.[/]")
        raise typer.Exit(1)
    typer.echo(str(source))


@skills_app.command("install")
def skills_install_cmd(
    dest: Annotated[
        Path,
        typer.Option(help="Claude Code skills folder (personal skills: ~/.claude/skills)."),
    ] = DEFAULT_SKILLS_DEST,
    force: Annotated[
        bool, typer.Option(help="Replace a skill of the same name that differs from this version.")
    ] = False,
) -> None:
    """Copy all shipped skills (/budget-setup, /investments-setup, ...) into one Claude Code skills
    folder (default: your personal skills, for every folder you open).

    Per profile, prefer `cashu workspace init --profile <slug>`: a workspace folder with only the
    enabled modules' skills, the profile's MCP server and rules that keep Claude Code out of the
    cashU data. Each skill folder is self-contained (its references travel with it)."""
    source = runtime.skills_dir()
    if source is None:
        cliutil.err_console.print("[red]No skills found in this installation.[/]")
        raise typer.Exit(1)
    dest = dest.expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    skipped = 0
    for skill in _skill_dirs(source):
        target = dest / skill.name
        if not target.exists():
            shutil.copytree(skill, target)
            cliutil.console.print(f"[green]installed[/] /{skill.name} -> {target}")
        elif target.is_dir() and _same_tree(skill, target):
            cliutil.console.print(f"up to date  /{skill.name}")
        elif force and target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
            shutil.copytree(skill, target)
            cliutil.console.print(f"[green]replaced[/]  /{skill.name} -> {target}")
        else:
            skipped += 1
            cliutil.console.print(
                f"[yellow]skipped[/]   /{skill.name}: {target} exists and differs (--force replaces it)"
            )
    cliutil.console.print(
        "Restart Claude Code to pick up new skills. Each skill talks to a profile's MCP server: "
        "see Settings > Agent AI in the app for the `claude mcp add` line, or create the "
        "profile's agent workspace (server, skills and permissions in one folder): "
        "`cashu workspace init --profile <slug>`."
    )
    if skipped:
        raise typer.Exit(1)


def register(app: typer.Typer) -> None:
    app.command("app")(app_cmd)
    app.add_typer(skills_app, name="skills")
