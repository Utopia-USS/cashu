"""Named run locks shared by every process of one data dir (CLI, server, background worker).

``run_lock("investments-daily")`` holds an OS file lock on ``<data dir>/locks/<name>.lock`` for the
duration of a job, so the worker and an in-app "run now" never run the same job twice at once. The
OS releases the lock when the process dies, so a crashed run never leaves a stale lock behind.
"""

from __future__ import annotations

import os
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from . import paths

_NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


class LockBusy(RuntimeError):
    """Another process (or thread) holds the lock."""


def lock_path(name: str) -> Path:
    if not _NAME.match(name):
        raise ValueError(f"Bad lock name {name!r}")
    return paths.data_dir() / "locks" / f"{name}.lock"


def _try_lock(fd: int) -> bool:
    if os.name == "nt":  # pragma: no cover - Windows build later
        import msvcrt

        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    import fcntl

    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(fd: int) -> None:
    if os.name == "nt":  # pragma: no cover
        import msvcrt

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        return
    import fcntl

    fcntl.flock(fd, fcntl.LOCK_UN)


@contextmanager
def run_lock(name: str, *, wait: float = 0.0, poll: float = 0.1) -> Iterator[Path]:
    """Hold the named lock; wait up to ``wait`` seconds, then raise :class:`LockBusy`."""
    path = lock_path(name)
    paths.ensure_private_dir(path.parent)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + wait
        while not _try_lock(fd):
            if time.monotonic() >= deadline:
                raise LockBusy(f"'{name}' is already running")
            time.sleep(poll)
        try:
            os.ftruncate(fd, 0)
            os.write(fd, str(os.getpid()).encode("ascii"))
            yield path
        finally:
            _unlock(fd)
    finally:
        os.close(fd)
