"""Read the native host's private per-job switch after taking the existing Python job lock.

Missing state preserves Python ownership on old installs. Malformed state refuses a run;
it must never silently reset a native-owned job to Python.
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path

from cashu.core import paths

_MAX_BYTES = 16 * 1024
_ID = re.compile(r"^[0-9a-f]{32}$")
_JOBS = {"investments.daily", "budget.sync", "connectors.fetch", "notifications", "digest"}


def _record_path() -> Path:
    return paths.data_dir() / "worker" / "ownership.json"


def _read(path: Path) -> dict | None:
    try:
        directory = path.parent.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(directory.st_mode) or directory.st_mode & 0o077:
        raise ValueError("worker ownership directory unavailable")
    if hasattr(os, "getuid") and directory.st_uid != os.getuid():
        raise ValueError("worker ownership directory unavailable")
    try:
        before = path.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            before.st_mode & 0o077 or before.st_size > _MAX_BYTES or
            (hasattr(os, "getuid") and before.st_uid != os.getuid())):
        raise ValueError("worker ownership record unavailable")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        opened = os.fstat(fd)
        if ((opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or
                not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or
                opened.st_mode & 0o077 or opened.st_size > _MAX_BYTES or
                (hasattr(os, "getuid") and opened.st_uid != os.getuid())):
            raise ValueError("worker ownership record changed")
        with os.fdopen(os.dup(fd), "rb") as stream:
            contents = stream.read(_MAX_BYTES + 1)
        if len(contents) != opened.st_size:
            raise ValueError("worker ownership record changed")
        after = path.lstat()
        if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("worker ownership record changed")
    finally:
        os.close(fd)
    try:
        value = json.loads(contents.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("worker ownership record invalid") from exc
    if not isinstance(value, dict) or set(value) != {"version", "generation", "jobs"}:
        raise ValueError("worker ownership record invalid")
    if (type(value["version"]) is not int or value["version"] != 1 or
            type(value["generation"]) is not int or
            not 1 <= value["generation"] <= 2**53 - 1):
        raise ValueError("worker ownership record invalid")
    jobs = value["jobs"]
    if not isinstance(jobs, dict) or set(jobs) != {"investments.daily", "connectors.fetch"}:
        raise ValueError("worker ownership record invalid")
    for job in ("investments.daily", "connectors.fetch"):
        record = jobs[job]
        if not isinstance(record, dict) or set(record) != {"owner", "vaults"} or record["owner"] != "native":
            raise ValueError("worker ownership record invalid")
        vaults = record["vaults"]
        if not isinstance(vaults, list) or not vaults or len(vaults) > 64 or len(vaults) != len(set(vaults)) or not all(
            isinstance(vault, str) and _ID.fullmatch(vault) for vault in vaults
        ):
            raise ValueError("worker ownership record invalid")
    return value


def python_owns(job: str) -> bool:
    """Call under the job's Python flock, immediately before any work or request."""
    if job not in _JOBS:
        return False
    try:
        record = _read(_record_path())
    except (OSError, ValueError, TypeError):
        return False
    if record is None:
        return True
    return job not in record["jobs"]
