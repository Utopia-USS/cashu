"""``<data dir>/logs/worker.log``: size-based rotation and the worker's logging setup.

launchd appends the scheduled run's stdout and stderr to ``worker.log`` (the agent's
``StandardOutPath`` / ``StandardErrorPath``) and holds that file open for the whole run. Renaming
the file would leave the running worker writing into the renamed copy, so the rotation copies and
truncates instead ("copytruncate"): at the start of ``finanse worker run``, before anything is
written, a log over ``MAX_BYTES`` is copied to ``worker.log.1`` (older copies shift up to
``worker.log.<BACKUPS>``, the oldest is dropped) and emptied in place. The writer appends, so it
simply continues at the new end of the same file. Copies are 0600 like every file in the data dir.

``setup()`` also sends the worker's log records (``finanse.worker``: INFO and up, with a
timestamp) to stderr, i.e. into ``worker.log`` under launchd, unless logging is configured
already (tests, an embedding app).
"""

from __future__ import annotations

import logging
import os
import shutil
import stat
import sys
from pathlib import Path

from . import scheduler

MAX_BYTES = 1_000_000
BACKUPS = 3
FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def backup_path(path: Path, n: int) -> Path:
    return path.with_name(f"{path.name}.{n}")


def rotate(path: Path | None = None, *, max_bytes: int = MAX_BYTES, backups: int = BACKUPS) -> bool:
    """Rotate ``path`` (default: the worker log) when it is larger than ``max_bytes``.
    Returns True when it rotated. Never raises for a filesystem problem (the run goes on)."""
    path = path or scheduler.log_path()
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if not stat.S_ISREG(info.st_mode) or info.st_size <= max_bytes or backups < 1:
        return False  # missing, a symlink or something else, or small enough
    try:
        backup_path(path, backups).unlink(missing_ok=True)
        for n in range(backups - 1, 0, -1):
            older = backup_path(path, n)
            if older.exists():
                os.replace(older, backup_path(path, n + 1))
        first = backup_path(path, 1)
        tmp = first.with_name(f".{first.name}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as dst, path.open("rb") as src:
            shutil.copyfileobj(src, dst)
        os.replace(tmp, first)
        os.truncate(path, 0)
        os.chmod(path, 0o600)
    except OSError as e:
        print(f"worker.log rotation failed: {e}", file=sys.stderr)
        return False
    return True


def configure_logging(stream=None) -> logging.Handler | None:
    """Worker log records to ``stream`` (default stderr) with timestamps; nothing when logging is
    configured already. Returns the handler it added (None when it added none)."""
    root = logging.getLogger()
    if root.handlers:
        return None
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(logging.Formatter(FORMAT))
    root.addHandler(handler)
    root.setLevel(logging.WARNING)
    logging.getLogger("finanse.worker").setLevel(logging.INFO)
    return handler


def setup(path: Path | None = None) -> bool:
    """What ``finanse worker run`` does first: rotate the log, then configure logging."""
    rotated = rotate(path)
    configure_logging()
    return rotated
