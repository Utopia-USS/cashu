"""Where finanse runs from: a source checkout / venv, or the packaged desktop app.

The macOS app (``Finanse.app``, built by ``scripts/build_macos.sh`` with PyInstaller) is one
binary, ``Finanse.app/Contents/MacOS/finanse``, that handles every CLI command (``worker run``,
``mcp --profile <slug>``, ...) and opens the desktop window when started without arguments (from
Finder). Code that hands a command line to another program (the launchd agent, the Claude Code /
Claude Desktop MCP snippets) asks this module for it, so a packaged install points at the bundled
binary and a developer setup keeps the plain ``finanse`` script.

Package data (the built SPA, Alembic migrations, templates) is found through ``__file__`` /
``importlib.resources`` both in a checkout and in the bundle (PyInstaller keeps the package layout
under ``sys._MEIPASS``); only files outside the package (the Claude Code skills) need a lookup here.
"""

from __future__ import annotations

import shlex
import sys
from pathlib import Path

from . import paths

CLI_NAME = "finanse"
# PyInstaller data folder of the bundled Claude Code skills (repo: .claude/skills).
BUNDLED_SKILLS = "skills"


def frozen() -> bool:
    """True inside the packaged app (PyInstaller sets ``sys.frozen``)."""
    return bool(getattr(sys, "frozen", False))


def executable() -> Path | None:
    """The packaged app's binary (``.../Finanse.app/Contents/MacOS/finanse``); None from source."""
    return Path(sys.executable) if frozen() else None


def bundle_dir() -> Path | None:
    """Where PyInstaller unpacked the package data (``sys._MEIPASS``); None from source."""
    if not frozen():
        return None
    meipass = getattr(sys, "_MEIPASS", None)
    return Path(meipass) if meipass else Path(sys.executable).parent


def app_bundle() -> Path | None:
    """The ``.app`` folder the binary runs from (macOS), else None."""
    exe = executable()
    if exe is None or len(exe.parents) < 3:
        return None
    macos, contents, app = exe.parents[0], exe.parents[1], exe.parents[2]
    if macos.name == "MacOS" and contents.name == "Contents" and app.suffix == ".app":
        return app
    return None


def translocated() -> bool:
    """True when macOS runs the app from a random read-only copy (Gatekeeper "App Translocation" of
    a quarantined app opened from Downloads): its path changes on every launch, so it must not be
    written into a launchd agent or an MCP config. Moving the app to /Applications fixes it."""
    exe = executable()
    return exe is not None and "/AppTranslocation/" in str(exe)


TRANSLOCATED_HINT = (
    "Finanse.app runs from a temporary location chosen by macOS (App Translocation). "
    "Move Finanse.app to the Applications folder, open it from there, and try again."
)


def cli_program() -> list[str]:
    """The command that runs the finanse CLI from another program: the bundled binary in the
    packaged app, else the ``finanse`` script on PATH (the venv)."""
    exe = executable()
    return [str(exe)] if exe is not None else [CLI_NAME]


# --------------------------------------------------------------------------- #
# MCP snippets (Settings > Agent AI, module setup pages)
# --------------------------------------------------------------------------- #


def mcp_server_name(slug: str) -> str:
    return f"finanse-{slug}"


def mcp_args(slug: str) -> list[str]:
    return ["mcp", "--profile", slug]


def mcp_command(slug: str) -> str:
    """``finanse mcp --profile <slug>`` (the bundled binary's absolute path when packaged)."""
    return shlex.join([*cli_program(), *mcp_args(slug)])


def claude_mcp_add(slug: str) -> str:
    """The ``claude mcp add`` line that registers the profile's MCP server in Claude Code."""
    return shlex.join(
        ["claude", "mcp", "add", mcp_server_name(slug), "--", *cli_program(), *mcp_args(slug)]
    )


def mcp_server_entry(slug: str) -> dict:
    """``{"command": ..., "args": [...]}``: how an MCP client starts the profile's server."""
    program = cli_program()
    return {"command": program[0], "args": [*program[1:], *mcp_args(slug)]}


def claude_desktop_config(slug: str) -> dict:
    """The ``mcpServers`` entry for Claude Desktop's ``claude_desktop_config.json``."""
    return {"mcpServers": {mcp_server_name(slug): mcp_server_entry(slug)}}


# --------------------------------------------------------------------------- #
# Files outside the Python package
# --------------------------------------------------------------------------- #


def skills_dir() -> Path | None:
    """The Claude Code setup skills: bundled in the app, else ``<repo>/.claude/skills``."""
    base = bundle_dir()
    candidate = (
        base / BUNDLED_SKILLS if base is not None else paths.PROJECT_ROOT / ".claude" / "skills"
    )
    return candidate if candidate.is_dir() else None
