"""Where cashU runs from: a source checkout / venv, or the packaged desktop app.

The macOS app (``cashU.app``, built by ``scripts/build_macos.sh`` with PyInstaller) is one
binary, ``cashU.app/Contents/MacOS/cashu``, that handles every CLI command (``worker run``,
``mcp --profile <slug>``, ...) and opens the desktop window when started without arguments (from
Finder). Code that hands a command line to another program (the launchd agent, the Claude Code /
Claude Desktop MCP snippets) asks this module for it, so a packaged install points at the bundled
binary and a developer setup keeps the plain ``cashu`` script.

Package data (the built SPA, Alembic migrations, templates) is found through ``__file__`` /
``importlib.resources`` both in a checkout and in the bundle (PyInstaller keeps the package layout
under ``sys._MEIPASS``); only files outside the package (the Claude Code skills) need a lookup here.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from datetime import UTC, datetime
from pathlib import Path

from . import paths

CLI_NAME = "cashu"
# PyInstaller data folder of the bundled Claude Code skills (repo: .claude/skills).
BUNDLED_SKILLS = "skills"


def frozen() -> bool:
    """True inside the packaged app (PyInstaller sets ``sys.frozen``)."""
    return bool(getattr(sys, "frozen", False))


def executable() -> Path | None:
    """The packaged app's binary (``.../cashU.app/Contents/MacOS/cashu``); None from source."""
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
    "cashU.app runs from a temporary location chosen by macOS (App Translocation). "
    "Move cashU.app to the Applications folder, open it from there, and try again."
)
# What the MCP snippets show instead of a command while translocated (PK3): a shell comment, so a
# copied line does nothing, and the UI text says what to do (Polish: shown in the app as is).
TRANSLOCATED_SNIPPET = (
    "# cashU.app działa z tymczasowej lokalizacji macOS. Przenieś cashU.app do folderu "
    "Programy, otwórz ją stamtąd i skopiuj to polecenie ponownie."
)


def cli_program() -> list[str]:
    """The command that runs the cashU CLI from another program: the bundled binary in the
    packaged app, else the ``cashu`` script on PATH (the venv)."""
    exe = executable()
    return [str(exe)] if exe is not None else [CLI_NAME]


# --------------------------------------------------------------------------- #
# MCP snippets (Settings > Agent AI, module setup pages)
# --------------------------------------------------------------------------- #


def mcp_server_name(slug: str) -> str:
    return f"cashu-{slug}"


def mcp_args(slug: str) -> list[str]:
    return ["mcp", "--profile", slug]


def mcp_command(slug: str) -> str:
    """``cashu mcp --profile <slug>`` (the bundled binary's absolute path when packaged).
    While the app is translocated: :data:`TRANSLOCATED_SNIPPET` (the path would break on the
    next launch)."""
    if translocated():
        return TRANSLOCATED_SNIPPET
    return shlex.join([*cli_program(), *mcp_args(slug)])


def claude_mcp_add(slug: str) -> str:
    """The ``claude mcp add`` line that registers the profile's MCP server in Claude Code
    (:data:`TRANSLOCATED_SNIPPET` while translocated)."""
    if translocated():
        return TRANSLOCATED_SNIPPET
    return shlex.join(
        ["claude", "mcp", "add", mcp_server_name(slug), "--", *cli_program(), *mcp_args(slug)]
    )


def mcp_server_entry(slug: str) -> dict:
    """``{"command": ..., "args": [...]}``: how an MCP client starts the profile's server. While
    translocated the command is empty and ``error`` says why (an MCP client then fails at once
    instead of working until the next launch)."""
    if translocated():
        return {"command": "", "args": mcp_args(slug), "error": TRANSLOCATED_SNIPPET[2:]}
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


# --------------------------------------------------------------------------- #
# Moved / renamed app (PK11)
# --------------------------------------------------------------------------- #

APP_LOCATION_FILE = "app-location.json"


def app_location_path() -> Path:
    return paths.data_dir() / APP_LOCATION_FILE


def _read_location() -> dict:
    try:
        data = json.loads(app_location_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_location(data: dict) -> None:
    path = app_location_path()
    paths.ensure_private_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def note_app_location() -> str | None:
    """Called by the desktop app on every launch: remember where cashU.app runs from. When it
    ran from somewhere else before (moved, renamed "cashU 2.app", reinstalled elsewhere), keep
    that previous location as ``moved_from`` until the configs written with the old path are
    fixed (:func:`clear_app_move`). Nothing is rewritten here. Returns ``moved_from``. A
    translocated launch is not recorded (its path is random)."""
    bundle = app_bundle()
    if bundle is None or translocated():
        return None
    data = _read_location()
    current = str(bundle)
    previous = data.get("bundle")
    if isinstance(previous, str) and previous != current:
        data["moved_from"] = previous
        data["moved_at"] = datetime.now(UTC).replace(microsecond=0).isoformat()
    if previous != current or not app_location_path().exists():
        data["bundle"] = current
        _write_location(data)
    moved = data.get("moved_from")
    return moved if isinstance(moved, str) and moved != current else None


def app_moved_from() -> str | None:
    """The previous location of cashU.app when it was moved since configs were last fixed
    (None from source, or when nothing moved)."""
    data = _read_location()
    moved, bundle = data.get("moved_from"), data.get("bundle")
    return moved if isinstance(moved, str) and moved != bundle else None


def note_mcp_started() -> None:
    """Called when ``cashu mcp`` starts: some agent client was given an MCP line, so a later move of
    the app can leave it pointing at the old path (F7 review R8). Recorded once; best effort."""
    try:
        data = _read_location()
        if not data.get("mcp_started_at"):
            data["mcp_started_at"] = datetime.now(UTC).replace(microsecond=0).isoformat()
            _write_location(data)
    except OSError:
        pass


def mcp_ever_started() -> bool:
    return bool(_read_location().get("mcp_started_at"))


def app_moved_at() -> str | None:
    value = _read_location().get("moved_at") if app_moved_from() else None
    return value if isinstance(value, str) else None


def clear_app_move() -> None:
    """The MCP part of a move is fixed (the owner confirmed re-adding the MCP lines, or a workspace
    update rewrote its .mcp.json): forget the old location. A worker re-install does not clear it:
    the worker part is derived from the installed job itself (F7 review R8)."""
    data = _read_location()
    if data.pop("moved_from", None) is not None:
        data.pop("moved_at", None)
        _write_location(data)
