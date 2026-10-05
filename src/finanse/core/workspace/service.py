"""Create, update and inspect a profile's agent workspace.

The workspace folder (default ``~/Documents/finanse/<slug>/``; ``FINANSE_WORKSPACES_DIR`` moves the
default root, tests use it) is where the owner runs Claude Code for one profile. Its location is
stored in ``<data dir>/profiles/<slug>/workspace.json`` (no table). finanse manages:

- the CLAUDE.md sections between ``finanse:begin`` / ``finanse:end`` markers (render.py),
- ``.mcp.json``: this profile's server only (other finanse servers are dropped, the user's other
  servers stay),
- ``.claude/settings.json``: allow rules for this server's tools, deny rules for Claude Code's file
  tools on the data dir, the database and raw export locations (merged into the user's settings),
- ``.claude/skills/<name>/``: copies of the enabled modules' skills, versioned by content hash in
  ``.claude/finanse-workspace.json`` (the manifest). Skills the user added are never touched; a
  managed copy the user edited is kept and reported (``force`` backs it up, then replaces it),
- the folders ``notes/``, ``research/``, ``scripts/``, ``inbox/`` (and a ``.gitignore`` for
  ``inbox/`` when the folder has none).

Opt-in per profile (``routine_permissions`` in the config, default off): allow rules that let the
unattended Saturday research routine search the web and write to ``research/`` and ``notes/``
without a prompt. Switching it off removes only the rules finanse added; the deny rules stay.

Everything else in the folder belongs to the user. An update is idempotent.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import unicodedata
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import Session

from ... import __version__
from .. import locks, modules, paths, profiles, runtime
from ..models import Profile
from . import render, skills
from .render import FOLDERS, INBOX, RESEARCH_SKILL, Context, ToolInfo

log = logging.getLogger(__name__)

WORKSPACES_ENV = "FINANSE_WORKSPACES_DIR"
CONFIG_FILE = "workspace.json"
FORMAT = 1
CLAUDE_MD = "CLAUDE.md"
MCP_FILE = ".mcp.json"
SETTINGS_FILE = Path(".claude") / "settings.json"
MANIFEST_FILE = Path(".claude") / "finanse-workspace.json"
SKILLS_DIR = Path(".claude") / "skills"
BACKUP_DIR = Path(".claude") / "finanse-backup"
GITIGNORE = ".gitignore"
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


class WorkspaceError(ValueError):
    """The workspace cannot be created or updated (message is safe to show, English). ``code`` is
    the stable key the app localizes: ``path_required``, ``path_relative``, ``path_is_file``,
    ``path_home``, ``path_hidden``, ``path_data_dir``, ``path_checkout``, ``translocated``,
    ``workspace_taken``, ``busy``, ``invalid_path`` (other)."""

    code = "invalid_path"

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code


class WorkspaceTaken(WorkspaceError):
    code = "workspace_taken"


class WorkspaceBusy(WorkspaceError):
    code = "busy"


# --------------------------------------------------------------------------- #
# Where the workspace is
# --------------------------------------------------------------------------- #


def default_root() -> Path:
    raw = os.environ.get(WORKSPACES_ENV, "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return Path.home() / "Documents" / "finanse"


def default_path(slug: str) -> Path:
    return default_root() / _checked(slug)


def _checked(slug: str) -> str:
    if not _SLUG.match(slug or ""):
        raise WorkspaceError(f"invalid profile slug {slug!r}")
    return slug


def config_path(slug: str) -> Path:
    return paths.data_dir() / "profiles" / _checked(slug) / CONFIG_FILE


def read_config(slug: str) -> dict:
    """``{"path": ..., "routine_permissions": bool}`` as stored, ``{}`` before the first create."""
    try:
        raw = json.loads(config_path(slug).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def configured_path(slug: str) -> Path | None:
    """The workspace folder recorded for the profile (set when it was created), else None."""
    value = read_config(slug).get("path")
    return Path(value) if isinstance(value, str) and value else None


def routine_permissions(slug: str) -> bool:
    """Opt-in (default off): the unattended research routine may search and write notes."""
    return read_config(slug).get("routine_permissions") is True


def workspace_path(slug: str) -> Path:
    return configured_path(slug) or default_path(slug)


def _write_config(slug: str, path: Path, routine: bool) -> None:
    target = config_path(slug)
    root = paths.ensure_private_dir(paths.data_dir())
    paths.ensure_private_dir(paths.ensure_private_dir(root / "profiles") / slug)
    data = {"path": str(path), "routine_permissions": routine}
    _write_text(target, json.dumps(data, indent=2) + "\n", mode=0o600)


def _key(value: Path) -> str:
    return unicodedata.normalize("NFC", os.path.normcase(str(value))).casefold().rstrip(os.sep)


def inside(path: Path, root: Path) -> bool:
    """``path`` is ``root`` or below it (case- and Unicode-insensitive, like macOS / Windows)."""
    p, r = _key(path), _key(root)
    return p == r or p.startswith(r + os.sep)


def protected_places() -> tuple[Path, ...]:
    """What Claude Code must not read in a workspace session: the data dir (DB, backups, import
    archive, Open Banking files, per-profile files), the legacy repo data dir and the repo's
    statements folder (a source checkout's raw bank exports)."""
    found = [paths.data_dir(), paths.storage_dir()]
    for extra in (paths.LEGACY_DIR, paths.PROJECT_ROOT / "statements"):
        if extra.is_dir():
            found.append(extra)
    out: list[Path] = []
    # (depth, path): a stable order, so the rendered CLAUDE.md boundaries and settings.json deny
    # rules are the same in every process (set order differs between runs; F7 OB6)
    for place in sorted({p.resolve() for p in found}, key=lambda p: (len(p.parts), str(p))):
        if not any(inside(place, kept) for kept in out):
            out.append(place)
    return tuple(out)


def _source_checkout() -> Path | None:
    root = paths.PROJECT_ROOT
    return (
        root
        if (root / "pyproject.toml").is_file() and (root / "src" / "finanse").is_dir()
        else None
    )


def check_path(raw: str | Path, slug: str, session: Session) -> Path:
    """A usable workspace folder for ``slug``, absolute and resolved."""
    text = str(raw or "").strip()
    if not text or "\x00" in text:
        raise WorkspaceError("path is required", "path_required")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise WorkspaceError(
            "the workspace path must be absolute (or start with ~)", "path_relative"
        )
    path = path.resolve()
    if path.exists() and not path.is_dir():
        raise WorkspaceError("the workspace path is a file, not a folder", "path_is_file")
    if path == Path(path.anchor) or path == Path.home().resolve():
        raise WorkspaceError(
            "choose a dedicated folder, not the home folder or the disk root", "path_home"
        )
    if any(part.startswith(".") for part in path.parts[1:]):
        raise WorkspaceError(
            "a workspace cannot be inside a hidden folder (the import tools refuse files there)",
            "path_hidden",
        )
    for place in protected_places():
        if inside(path, place) or inside(place, path):
            raise WorkspaceError(
                "the workspace must be outside the finanse data dir and must not contain it",
                "path_data_dir",
            )
    checkout = _source_checkout()
    if checkout is not None and inside(path, checkout):
        raise WorkspaceError(
            "the workspace cannot be inside the finanse source checkout", "path_checkout"
        )
    for other in profiles.list_profiles(session):
        if other.slug == slug:
            continue
        theirs = configured_path(other.slug)
        if theirs is not None and (inside(path, theirs) or inside(theirs, path)):
            raise WorkspaceTaken("this folder is, or contains, the workspace of another profile")
    manifest = _read_json(path / MANIFEST_FILE)[0]
    if manifest and manifest.get("profile") not in (None, slug):
        raise WorkspaceTaken("this folder is the workspace of another profile")
    return path


# --------------------------------------------------------------------------- #
# Context: what the workspace should contain
# --------------------------------------------------------------------------- #


def cli_program() -> list[str]:
    """How the workspace starts the finanse CLI: the bundled binary in the packaged app, else the
    ``finanse`` script next to this interpreter (a venv works without being activated), else the
    one on PATH."""
    if runtime.frozen():
        return runtime.cli_program()
    script = Path(sys.executable).parent / ("finanse.exe" if os.name == "nt" else "finanse")
    if script.is_file():
        return [str(script)]
    found = shutil.which(runtime.CLI_NAME)
    return [found] if found else [runtime.CLI_NAME]


def build_context(
    session: Session, profile: Profile, path: Path, routine: bool | None = None
) -> Context:
    from ..mcp.registry import all_tools

    enabled = profiles.enabled_modules(session, profile.id)
    registry = modules.registry()
    tools = tuple(
        ToolInfo(t.name, t.module, t.write)
        for t in all_tools().values()
        if t.module == "core" or t.module in enabled
    )
    shipped = skills.available()
    return Context(
        slug=profile.slug,
        version=__version__,
        base_currency=profile.base_currency or "PLN",
        privacy=profile.mcp_privacy,
        modules=tuple((m, registry[m].name) for m in enabled),
        tools=tools,
        skills=skills.wanted(enabled, shipped),
        research_available=RESEARCH_SKILL in shipped,
        cli=tuple(cli_program()),
        path=path,
        protected=protected_places(),
        routine_permissions=routine_permissions(profile.slug) if routine is None else routine,
    )


# --------------------------------------------------------------------------- #
# Files
# --------------------------------------------------------------------------- #


def _read_json(path: Path) -> tuple[dict | None, bool]:
    """(content, valid): (None, True) when the file is missing, (None, False) when unreadable."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, True
    except OSError:
        return None, False
    try:
        data = json.loads(text)
    except ValueError:
        return None, False
    return (data, True) if isinstance(data, dict) else (None, False)


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def _write_text(path: Path, text: str, *, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(tmp, flags, mode if mode is not None else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _write_json(path: Path, data: dict) -> None:
    _write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _manifest(ws: Path) -> dict:
    data, _valid = _read_json(ws / MANIFEST_FILE)
    return data or {}


def _manifest_skills(manifest: dict) -> dict[str, dict]:
    raw = manifest.get("skills")
    if not isinstance(raw, dict):
        return {}
    return {
        k: v for k, v in raw.items() if isinstance(v, dict) and isinstance(v.get("version"), str)
    }


def _previous(manifest: dict, key: str) -> list[str]:
    """Rules finanse wrote last time (``settings_deny`` / ``settings_routine``)."""
    raw = manifest.get(key)
    return [r for r in raw if isinstance(r, str)] if isinstance(raw, list) else []


def _merge_settings(ctx: Context, manifest: dict):
    deny, routine = _previous(manifest, "settings_deny"), _previous(manifest, "settings_routine")
    return lambda d: render.merge_settings(d, ctx, deny, routine)


# --------------------------------------------------------------------------- #
# Inspection
# --------------------------------------------------------------------------- #


def _skill_states(ctx: Context, manifest: dict) -> list[dict]:
    """Per skill: the wanted ones (missing / ok / outdated / modified / conflict) and managed copies
    of switched-off modules still present (extra, or modified when edited)."""
    root = ctx.path / SKILLS_DIR
    managed = _manifest_skills(manifest)
    out = []
    for name, src in ctx.skills.items():
        target = root / name
        record = managed.get(name)
        if not target.exists():
            state = "missing"
        else:
            current = skills.tree_hash(target) if target.is_dir() else ""
            if current == src.version:
                state = "ok"
            elif record is None:
                state = "conflict"  # the user's own folder with that name
            elif current != record["version"]:
                state = "modified"
            else:
                state = "outdated"
        out.append({"name": name, "module": src.module, "version": src.version, "state": state})
    for name, record in managed.items():
        target = root / name
        if name in ctx.skills or not target.is_dir():
            continue
        state = "extra" if skills.tree_hash(target) == record["version"] else "modified"
        module = record.get("module") if isinstance(record.get("module"), str) else None
        out.append({"name": name, "module": module, "version": record["version"], "state": state})
    return out


def _outdated(ctx: Context, manifest: dict) -> list[dict]:
    ws = ctx.path
    items: list[dict] = []

    def add(kind: str, name: str, reason: str) -> None:
        items.append({"kind": kind, "name": name, "reason": reason})

    for folder in FOLDERS:
        if not (ws / folder).is_dir():
            add("folder", folder, "missing")
    text = _read_text(ws / CLAUDE_MD)
    if text is None:
        add("claude_md", CLAUDE_MD, "missing")
    else:
        present = render.read_sections(text)
        for name, wanted in render.sections(ctx).items():
            if name not in present:
                add("claude_md", name, "missing")
            elif present[name] != wanted:
                add("claude_md", name, "outdated")
    for kind, rel, merge in (
        ("mcp", MCP_FILE, lambda d: render.merge_mcp(d, ctx)),
        ("settings", str(SETTINGS_FILE), _merge_settings(ctx, manifest)),
    ):
        data, valid = _read_json(ws / rel)
        if not valid:
            add(kind, rel, "invalid")
        elif data is None:
            add(kind, rel, "missing")
        elif merge(data) != data:
            add(kind, rel, "outdated")
    for skill in _skill_states(ctx, manifest):
        if skill["state"] != "ok":
            add("skill", skill["name"], skill["state"])
    return items


def _mcp_command_stale(ctx: Context) -> bool:
    """The profile's server in .mcp.json starts another finanse CLI than this install would write
    (``cli_program()``, the bundled binary in the packaged app): e.g. a workspace written by a dev
    venv or an app at its old path (F7 OB7). A missing entry is reported by ``outdated`` instead.
    "Aktualizuj workspace" (``apply``) rewrites it."""
    data, valid = _read_json(ctx.path / MCP_FILE)
    servers = (data or {}).get("mcpServers") if valid else None
    entry = servers.get(ctx.server) if isinstance(servers, dict) else None
    if not isinstance(entry, dict):
        return False
    wanted = render.mcp_entry(ctx)
    args = entry.get("args") if isinstance(entry.get("args"), list) else []
    return entry.get("command") != wanted["command"] or args[: len(ctx.cli) - 1] != list(ctx.cli[1:])


def status(session: Session, profile: Profile, *, path: Path | None = None) -> dict:
    slug = profile.slug
    configured = configured_path(slug)
    ws = path or configured or default_path(slug)
    manifest, valid = _read_json(ws / MANIFEST_FILE)
    owner = (manifest or {}).get("profile")
    conflict = "other_profile" if manifest and owner not in (None, slug) else None
    exists = bool(manifest) and valid and conflict is None
    outdated: list[dict] = []
    skill_rows: list[dict] = []
    command_stale = False
    if exists:
        ctx = build_context(session, profile, ws)
        outdated = _outdated(ctx, manifest or {})
        skill_rows = _skill_states(ctx, manifest or {})
        command_stale = _mcp_command_stale(ctx)
    return {
        "path": str(ws),
        "default_path": str(default_path(slug)),
        "configured": configured is not None,
        "custom": configured is not None and _key(configured) != _key(default_path(slug)),
        "exists": exists,
        "folder_exists": ws.is_dir(),
        "conflict": conflict,
        "managed_version": (manifest or {}).get("finanse_version") if exists else None,
        "current_version": __version__,
        "updated_at": (manifest or {}).get("updated_at") if exists else None,
        "up_to_date": exists and not outdated,
        "mcp_command_stale": command_stale,
        "outdated": outdated,
        "skills": skill_rows,
        "skills_source": skills.source_dir() is not None,
        "claude_command": render.claude_command(ws),
        "routine_command": render.claude_command(ws, "/market-research rutyna"),
        "routine_permissions": routine_permissions(slug),
    }


# --------------------------------------------------------------------------- #
# Create / update
# --------------------------------------------------------------------------- #


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S")


def _backup(ws: Path, rel: Path, stamp: str) -> Path:
    """Move ``ws/rel`` into ``.claude/finanse-backup/<stamp>/rel`` (never deleted by finanse)."""
    dest = ws / BACKUP_DIR / stamp / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(ws / rel, dest)
    return dest


def _sync_json(ws: Path, rel: str, merge, kind: str, changes: list, stamp: str) -> None:
    target = ws / rel
    data, valid = _read_json(target)
    if not valid:
        _backup(ws, Path(rel), stamp)
        changes.append({"kind": kind, "name": rel, "action": "backed_up"})
        data = None
    merged = merge(data)
    if merged != data:
        _write_json(target, merged)
        changes.append(
            {"kind": kind, "name": rel, "action": "created" if data is None else "updated"}
        )


def _sync_skills(ctx: Context, manifest: dict, force: bool, changes: list, stamp: str) -> dict:
    ws = ctx.path
    root = ws / SKILLS_DIR
    root.mkdir(parents=True, exist_ok=True)
    managed = dict(_manifest_skills(manifest))
    result: dict[str, dict] = {}
    for skill in _skill_states(ctx, manifest):
        name, state = skill["name"], skill["state"]
        rel = SKILLS_DIR / name
        src = ctx.skills.get(name)
        if src is None:  # a switched-off module's skill
            if state == "extra":
                shutil.rmtree(ws / rel)
                changes.append({"kind": "skill", "name": name, "action": "removed"})
            elif force:
                _backup(ws, rel, stamp)
                changes.append({"kind": "skill", "name": name, "action": "backed_up"})
            else:  # edited locally: it stays and becomes the user's own skill
                changes.append({"kind": "skill", "name": name, "action": "released"})
            continue
        record = {"module": src.module, "version": src.version}
        if state == "ok":
            result[name] = record
        elif state in ("missing", "outdated"):
            skills.copy_skill(src.path, ws / rel)
            changes.append(
                {
                    "kind": "skill",
                    "name": name,
                    "action": "created" if state == "missing" else "updated",
                }
            )
            result[name] = record
        elif force:  # modified or conflict
            _backup(ws, rel, stamp)
            skills.copy_skill(src.path, ws / rel)
            changes.append({"kind": "skill", "name": name, "action": "replaced"})
            result[name] = record
        else:
            changes.append({"kind": "skill", "name": name, "action": "kept"})
            if state == "modified":
                result[name] = managed[name]  # still managed: reported until replaced
    return result


def _apply(ctx: Context, force: bool) -> list[dict]:
    ws = ctx.path
    changes: list[dict] = []
    stamp = _stamp()
    if not ws.exists():
        ws.parent.mkdir(parents=True, exist_ok=True)
        ws.mkdir(mode=0o700)
        changes.append({"kind": "folder", "name": ".", "action": "created"})
    manifest = _manifest(ws)
    for folder in FOLDERS:
        if not (ws / folder).is_dir():
            (ws / folder).mkdir(parents=True)
            changes.append({"kind": "folder", "name": folder, "action": "created"})
    if not (ws / GITIGNORE).exists():
        _write_text(ws / GITIGNORE, f"# raw exports never go into git\n{INBOX}/\n")
        changes.append({"kind": "gitignore", "name": GITIGNORE, "action": "created"})
    existing = _read_text(ws / CLAUDE_MD)
    merged = render.merge_claude_md(existing, ctx)
    if merged != existing:
        _write_text(ws / CLAUDE_MD, merged)
        changes.append(
            {
                "kind": "claude_md",
                "name": CLAUDE_MD,
                "action": "created" if existing is None else "updated",
            }
        )
    _sync_json(ws, MCP_FILE, lambda d: render.merge_mcp(d, ctx), "mcp", changes, stamp)
    settings_before, _valid = _read_json(ws / SETTINGS_FILE)
    owned = render.routine_owned(settings_before, ctx, _previous(manifest, "settings_routine"))
    _sync_json(ws, str(SETTINGS_FILE), _merge_settings(ctx, manifest), "settings", changes, stamp)
    managed_skills = _sync_skills(ctx, manifest, force, changes, stamp)
    new_manifest = {
        "format": FORMAT,
        "profile": ctx.slug,
        "finanse_version": ctx.version,
        "skills": managed_skills,
        "settings_deny": render.deny_rules(ctx),
        "settings_routine": owned,
    }
    old = {k: v for k, v in manifest.items() if k != "updated_at"}
    if old != new_manifest:
        _write_json(ws / MANIFEST_FILE, {**new_manifest, "updated_at": _now()})
    return changes


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def apply(
    session: Session,
    profile: Profile,
    *,
    path: str | Path | None = None,
    force: bool = False,
    routine: bool | None = None,
) -> dict:
    """Create or update the profile's workspace (at ``path`` when given, which also becomes the
    profile's workspace location; ``routine`` switches the opt-in routine permissions, None keeps
    the stored choice). Returns the status plus ``changes``."""
    if runtime.translocated():
        raise WorkspaceError(runtime.TRANSLOCATED_HINT, "translocated")
    slug = profile.slug
    previous = configured_path(slug)
    target = check_path(path if path is not None else workspace_path(slug), slug, session)
    try:
        with locks.run_lock(f"workspace-{slug.lower()}", wait=10):
            routine = routine_permissions(slug) if routine is None else routine
            changes = _apply(build_context(session, profile, target, routine), force)
            _write_config(slug, target, routine)
    except locks.LockBusy:
        raise WorkspaceBusy("the workspace is being updated right now; try again") from None
    if any(c["kind"] == "mcp" and c["action"] == "updated" for c in changes):
        runtime.clear_app_move()  # its .mcp.json now names this install (F7 review R8)
    result = status(session, profile)
    result["changes"] = changes
    result["moved_from"] = (
        str(previous) if previous is not None and _key(previous) != _key(target) else None
    )
    return result


def refresh_if_present(slug: str) -> dict | None:
    """After a module or privacy change: update the profile's workspace when one was created
    through finanse. Never raises (the change itself already succeeded)."""
    try:
        configured = configured_path(slug)
        if configured is None or not (configured / MANIFEST_FILE).is_file():
            return None
        from ..db import get_session

        with get_session() as s:
            profile = profiles.get_by_slug(s, slug)
            if profile is None:
                return None
            return apply(s, profile)
    except Exception:  # best effort, logged
        log.warning("workspace refresh failed for profile %s", slug, exc_info=True)
        return None


def default_for_name(session: Session, name: str) -> dict:
    """The default workspace of a profile about to be created (the wizard's path field)."""
    clean = (name or "").strip()
    slug = profiles.unique_slug(session, clean) if clean else None
    return {
        "root": str(default_root()),
        "slug": slug,
        "path": str(default_path(slug)) if slug else None,
    }
