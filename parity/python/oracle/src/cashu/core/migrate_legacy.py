"""Moving an install from before the rename (finanse -> cashU) into place. Legacy name module: every
"finanse" here is the old name this code looks for.

Run by the CLI root callback (so the desktop app, the background worker, ``serve`` and ``mcp`` too)
before anything opens the database. Steps, each idempotent, logged, and never raising through:

1. ``data_dir``: the platform default data dir. When the new default (``.../cashU``) does not exist
   and the old one (``.../finanse``) does, and no process uses the old database (the app's run
   locks, and SQLite's own lock that every open WAL connection holds), the old folder is renamed to
   the new path (same volume; otherwise copied, verified and the old one kept as
   ``finanse.migrated-<date>``), and ``MIGRATED_FROM.txt`` is written into it. An explicit
   ``CASHU_DATA_DIR`` / ``FINANSE_DATA_DIR`` folder is never moved.
2. ``db_file``: in the active data dir, ``finanse.db`` (+ ``-wal`` / ``-shm``) becomes ``cashu.db``.
3. ``keychain``: the known secrets stored under the old service are moved to the new one
   (``core.secrets`` also does this lazily on every read, connector secrets included).
4. ``launchd``: a worker agent installed under the old label for this data dir is unloaded, removed
   and installed again under the new label, with the same schedule and the new program.

Workspaces are not moved: ``workspace update`` rewrites their managed parts (core/workspace).

The outcome of steps that did something, failed or were refused is kept in
``<data dir>/rename-migration.json`` and shown in Ustawienia > Aplikacja (``GET /api/system``).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import shutil
import sqlite3
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from . import paths

log = logging.getLogger(__name__)

# Test guard: under pytest (``CASHU_TESTING=1``, set by tests/conftest.py and the e2e setup) no step
# acts on anything under the real home folder. The real home is resolved when this module is
# imported, from the account database and from ``~`` (before a test patches HOME), so a test can
# never move, rename or reinstall a real install whatever its environment says.
TESTING_ENV = "CASHU_TESTING"


def _home_candidates() -> tuple[Path, ...]:
    found: set[Path] = set()
    try:
        import pwd

        found.add(Path(pwd.getpwuid(os.getuid()).pw_dir).resolve())
    except (ImportError, KeyError, OSError):  # pragma: no cover - Windows / no passwd entry
        pass
    found.add(Path(os.path.expanduser("~")).resolve())
    return tuple(sorted(found))


_REAL_HOMES = _home_candidates()

STATE_FILE = "rename-migration.json"
MIGRATED_FROM = "MIGRATED_FROM.txt"
DB_SUFFIXES = ("", "-wal", "-shm")
# SQLite's unix VFS: every connection to a WAL database holds a shared lock on this byte of the
# -shm file (the "dead man switch"); an exclusive lock on it succeeds only when nobody has it open.
_SHM_DMS_BYTE = 128

DONE, SKIPPED, FAILED, REFUSED = "done", "skipped", "failed", "refused"


@dataclass
class StepResult:
    step: str
    status: str  # done | skipped | failed | refused
    detail: str = ""


class _Refused(RuntimeError):
    """The step cannot run now (message is safe to show)."""


def testing() -> bool:
    return os.environ.get(TESTING_ENV) == "1"


def _guard(*targets: Path | None) -> None:
    """Under pytest: refuse when any target lies under the real home folder."""
    if not testing():
        return
    for target in targets:
        if target is None:
            continue
        resolved = Path(target).expanduser().resolve()
        for home in _REAL_HOMES:
            if resolved == home or home in resolved.parents:
                raise _Refused(f"test guard: {resolved} is under the real home folder")


# --------------------------------------------------------------------------- #
# Is the old database in use?
# --------------------------------------------------------------------------- #


def _lock_busy(file: Path) -> bool:
    if os.name != "posix":  # pragma: no cover - Windows build later
        return False
    import fcntl

    try:
        fd = os.open(file, os.O_RDWR)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def _sqlite_open_elsewhere(db: Path) -> bool:
    shm = Path(f"{db}-shm")
    if os.name != "posix" or not shm.exists():  # no -shm: no WAL connection is open
        return False
    import fcntl

    try:
        fd = os.open(shm, os.O_RDWR)
    except OSError:
        return False
    try:
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, _SHM_DMS_BYTE)
        except OSError:
            return True
        fcntl.lockf(fd, fcntl.LOCK_UN, 1, _SHM_DMS_BYTE)
        return False
    finally:
        os.close(fd)


def in_use(folder: Path) -> str | None:
    """Why the data dir ``folder`` is in use (a held run lock or an open database), else None."""
    for lock in sorted((folder / "locks").glob("*.lock")):
        if _lock_busy(lock):
            return f"{lock.stem} is running"
    for name in (paths.LEGACY_DB_FILENAME, paths.DB_FILENAME):
        if _sqlite_open_elsewhere(folder / name):
            return f"{name} is open in another process"
    return None


# --------------------------------------------------------------------------- #
# Steps
# --------------------------------------------------------------------------- #


def _rename_db_files(folder: Path) -> list[str]:
    """``finanse.db*`` -> ``cashu.db*`` in ``folder``; nothing when the new DB exists already."""
    old, new = folder / paths.LEGACY_DB_FILENAME, folder / paths.DB_FILENAME
    if not old.exists() or new.exists():
        return []
    reason = in_use(folder)
    if reason:
        raise _Refused(f"{reason}: close cashU (or finanse) and start it again")
    moved = []
    for suffix in DB_SUFFIXES:
        src, dst = Path(f"{old}{suffix}"), Path(f"{new}{suffix}")
        if src.exists() and not dst.exists():
            os.replace(src, dst)
            moved.append(dst.name)
    return moved


def _same_volume(a: Path, b: Path) -> bool:
    try:
        return a.stat().st_dev == b.stat().st_dev
    except OSError:
        return False


def _copy_verified(old: Path, new: Path, stamp: str) -> Path:
    tmp = new.with_name(new.name + ".migrating")
    if tmp.exists():
        shutil.rmtree(tmp)
    shutil.copytree(old, tmp, symlinks=True)
    db = tmp / paths.LEGACY_DB_FILENAME
    if db.exists():
        conn = sqlite3.connect(db)
        try:
            if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("the copied database failed the integrity check")
        finally:
            conn.close()
    os.replace(tmp, new)
    kept = old.with_name(f"{paths.LEGACY_APP_NAME}.migrated-{stamp}")
    os.replace(old, kept)
    return kept


def migrate_data_dir(*, old: Path, new: Path, now: dt.datetime) -> StepResult:
    _guard(old, new)
    if new.exists() or not old.is_dir():
        return StepResult("data_dir", SKIPPED)
    reason = in_use(old)
    if reason:
        raise _Refused(f"{reason}: close cashU (or finanse) and start it again")
    new.parent.mkdir(parents=True, exist_ok=True)
    stamp = now.strftime("%Y%m%d-%H%M%S")
    if _same_volume(old, new.parent):
        os.rename(old, new)
        detail, kept = f"moved {old} to {new}", None
    else:
        kept = _copy_verified(old, new, stamp)
        detail = f"copied {old} to {new} (the old folder is kept as {kept.name})"
    renamed = _rename_db_files(new)
    (new / MIGRATED_FROM).write_text(
        f"Moved here from {old} on {now.isoformat()} (finanse was renamed to cashU).\n"
        + (f"The old folder is kept as {kept}.\n" if kept else "")
        + (f"Renamed: {', '.join(renamed)}.\n" if renamed else ""),
        encoding="utf-8",
    )
    return StepResult("data_dir", DONE, detail)


def migrate_db_file(folder: Path) -> StepResult:
    _guard(folder)
    moved = _rename_db_files(folder)
    if not moved:
        return StepResult("db_file", SKIPPED)
    return StepResult("db_file", DONE, f"renamed to {', '.join(moved)} in {folder}")


def migrate_keychain() -> StepResult:
    from . import secrets

    if testing():
        import keyring

        backend = type(keyring.get_keyring()).__module__
        if backend.startswith("keyring.backends.macOS"):
            raise _Refused("test guard: the real keychain backend is active")

    moved = []
    for name in sorted(secrets.KNOWN):
        try:
            import keyring
            from keyring.errors import KeyringError

            if keyring.get_password(secrets.SERVICE, name):
                continue
        except (ImportError, KeyringError):  # no keychain here: nothing to move, env fallback
            return StepResult("keychain", SKIPPED, "keychain unavailable")
        if secrets.get_secret(name):  # adopts the old entry
            moved.append(name)
    if not moved:
        return StepResult("keychain", SKIPPED)
    return StepResult("keychain", DONE, f"moved {', '.join(moved)} to service {secrets.SERVICE}")


def _plist_dir_matches(data: dict, folder: Path, old_default: Path) -> bool:
    """The old agent belongs to this install: it ran in this data dir (or in the old default dir
    that became it) and pins no other data dir."""
    env = data.get("EnvironmentVariables") if isinstance(data.get("EnvironmentVariables"), dict) else {}
    pinned = env.get("CASHU_DATA_DIR") or env.get("FINANSE_DATA_DIR")  # legacy name
    override = paths.data_dir_override()
    if pinned or override:
        return bool(pinned and override and Path(pinned).expanduser().resolve() == override)
    workdir = data.get("WorkingDirectory")
    if not isinstance(workdir, str):
        return False
    wd = Path(workdir).expanduser()
    return wd == old_default or wd.resolve() == folder.resolve()


def migrate_launchd(
    *,
    folder: Path,
    old_default: Path,
    agents_dir: Path | None = None,
    runner: Callable | None = None,
) -> StepResult:
    import plistlib

    from .worker import scheduler

    old = scheduler.LaunchdScheduler(
        label=scheduler.LEGACY_LABEL, agents_dir=agents_dir, **({"runner": runner} if runner else {})
    )
    _guard(old.agents_dir, folder)
    if not old.plist_path.exists():
        return StepResult("launchd", SKIPPED)
    try:
        with old.plist_path.open("rb") as f:
            data = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return StepResult("launchd", SKIPPED, "unreadable old agent")
    if not isinstance(data, dict) or not _plist_dir_matches(data, folder, old_default):
        return StepResult("launchd", SKIPPED, "the old agent belongs to another data dir")
    status = old.status()
    new = scheduler.LaunchdScheduler(agents_dir=agents_dir, **({"runner": runner} if runner else {}))
    old.uninstall()
    kwargs = {"schedule": status.schedule} if status.schedule else {}
    new.install(**kwargs)
    return StepResult("launchd", DONE, f"reinstalled as {new.label}")


# --------------------------------------------------------------------------- #
# Run all
# --------------------------------------------------------------------------- #

_ran = False


def state_path(folder: Path | None = None) -> Path:
    return (folder or paths.data_dir()) / STATE_FILE


def read_state(folder: Path | None = None) -> dict | None:
    try:
        _guard(state_path(folder))
    except _Refused:
        return None
    try:
        data = json.loads(state_path(folder).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _record(results: list[StepResult], now: dt.datetime) -> None:
    folder = paths.data_dir()
    try:
        _guard(folder)
    except _Refused:
        return
    if not folder.is_dir():
        return
    previous = read_state(folder) or {}
    steps = previous.get("steps") if isinstance(previous.get("steps"), dict) else {}
    for r in results:
        if r.status != SKIPPED or r.step in steps or r.step == "keychain":
            steps[r.step] = {**asdict(r), "at": now.isoformat()}
    if steps == previous.get("steps"):
        return
    target = state_path(folder)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps({"steps": steps}, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, target)


def problems(folder: Path | None = None) -> list[dict]:
    """Failed or refused steps of the last run (Ustawienia > Aplikacja)."""
    steps = (read_state(folder) or {}).get("steps") or {}
    return [s for s in steps.values() if isinstance(s, dict) and s.get("status") in (FAILED, REFUSED)]


def run(
    *,
    now: dt.datetime | None = None,
    agents_dir: Path | None = None,
    runner: Callable | None = None,
    force: bool = False,
    launchd: bool = True,
) -> list[StepResult]:
    """Every step once per process (``force`` runs again); never raises. ``launchd=False``: the
    caller is the scheduled worker itself, which must not unload its own job mid-run."""
    global _ran
    if _ran and not force:
        return []
    _ran = True
    now = now or dt.datetime.now(dt.UTC).replace(microsecond=0)
    results: list[StepResult] = []
    old_default = paths.legacy_default_data_dir()

    def step(name: str, fn: Callable[[], StepResult]) -> None:
        try:
            result = fn()
        except _Refused as e:
            result = StepResult(name, REFUSED, str(e))
        except Exception as e:  # logged and reported, never raised through
            log.warning("rename migration step %s failed", name, exc_info=True)
            result = StepResult(name, FAILED, f"{type(e).__name__}: {e}")
        if result.status != SKIPPED:
            log.info("rename migration %s: %s %s", result.step, result.status, result.detail)
        results.append(result)

    if paths.data_dir_override() is None:
        step(
            "data_dir",
            lambda: migrate_data_dir(old=old_default, new=paths.default_data_dir(), now=now),
        )
    folder = paths.data_dir()
    step("db_file", lambda: migrate_db_file(folder))
    moved = any(r.step in ("data_dir", "db_file") and r.status == DONE for r in results)
    checked = ((read_state(folder) or {}).get("steps") or {}).get("keychain")
    if moved or not isinstance(checked, dict) or checked.get("status") == FAILED:
        step("keychain", migrate_keychain)  # once per install, not on every start
    refused = any(r.step in ("data_dir", "db_file") and r.status == REFUSED for r in results)
    if launchd and not refused:
        step(
            "launchd",
            lambda: migrate_launchd(
                folder=folder, old_default=old_default, agents_dir=agents_dir, runner=runner
            ),
        )
    try:
        _record(results, now)
    except OSError:
        log.warning("could not record the rename migration state", exc_info=True)
    return results
