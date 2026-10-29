"""Change token of the database (P10 "MCP changes"): the open app re-reads its views when another process (an
agent's ``cashu mcp``, the worker, the CLI) or the app itself committed to the SQLite file.

``PRAGMA data_version`` on one dedicated, long-lived connection that never writes changes whenever any other
connection commits (another process or this server's own pool). The watcher keeps the last value it saw and
counts the changes; the token is ``<boot id>-<count>``, so a server restart is a new token too. Reading the
token costs one pragma (no table read, no transaction). A DB that is not a file (in memory) has a fixed token.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import uuid
from pathlib import Path

_log = logging.getLogger("cashu.changes")


class ChangeWatcher:
    """The change token of one SQLite file (thread safe)."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._boot = uuid.uuid4().hex[:8]
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._seen: int | None = None
        self._count = 0

    def token(self) -> str:
        with self._lock:
            if self.path is not None:
                self._check()
            return f"{self._boot}-{self._count}"

    def _check(self) -> None:
        try:
            if self._conn is None:
                # autocommit (no open read transaction): every pragma sees the latest commit
                self._conn = sqlite3.connect(
                    str(self.path), check_same_thread=False, isolation_level=None, timeout=5
                )
            (version,) = self._conn.execute("PRAGMA data_version").fetchone()
        except sqlite3.Error as e:  # a vanished or locked file: the token stays, next call retries
            _log.debug("data_version failed: %s", e)
            self.close_locked()
            return
        if self._seen is not None and version != self._seen:
            self._count += 1
        self._seen = version

    def close_locked(self) -> None:
        if self._conn is None:
            return
        try:
            self._conn.close()
        except sqlite3.Error:  # pragma: no cover
            pass
        self._conn = None
        if self._seen is not None:
            self._count += 1  # what happened until the reconnect is unknown: one re-read
        self._seen = None

    def close(self) -> None:
        with self._lock:
            self.close_locked()


_watchers: dict[str, ChangeWatcher] = {}
_guard = threading.Lock()


def watcher() -> ChangeWatcher:
    """The watcher of the app database (the engine is read at call time, as ``get_session`` does)."""
    from . import db

    path = db.sqlite_file(str(db.engine.url))
    key = str(path)
    with _guard:
        found = _watchers.get(key)
        if found is None:
            found = _watchers[key] = ChangeWatcher(path)
        return found


def token() -> str:
    return watcher().token()
