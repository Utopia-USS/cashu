"""Database engine, session factory, and schema initialization."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlmodel import Session, create_engine

from .config import settings
from .core import paths

SQLITE_PREFIX = "sqlite:///"

# Applied to every new SQLite connection (SQLite pragmas are per connection).
SQLITE_PRAGMAS = (
    "PRAGMA journal_mode=WAL",  # readers never block the writer (server + CLI at once)
    "PRAGMA busy_timeout=5000",  # wait up to 5 s for a lock instead of failing at once
    "PRAGMA foreign_keys=ON",  # enforce the declared foreign keys
)


def sqlite_file(url: str) -> Path | None:
    """Absolute path of a file-based SQLite URL, None for in-memory / other DBs.

    Relative paths resolve against the repo root (the historical behaviour of
    ``FINANSE_DATABASE_URL=sqlite:///data/...``)."""
    if not url.startswith(SQLITE_PREFIX):
        return None
    raw = url[len(SQLITE_PREFIX):].split("?", 1)[0]
    if not raw or raw == ":memory:" or raw.startswith("file:"):
        return None
    path = Path(raw)
    return path if path.is_absolute() else paths.PROJECT_ROOT / path


def resolve_database_url(explicit: str | None = None) -> str:
    """The URL to use: ``FINANSE_DATABASE_URL`` if set, else the data-dir DB (or the
    legacy ``<repo>/data/finanse.db`` while in legacy mode, see core.paths).

    The old default ``sqlite:///data/finanse.db`` (copied from .env.example into
    many .env files) counts as unset, so ``finanse migrate-data`` can switch it."""
    if explicit:
        file = sqlite_file(explicit)
        if file is None:
            return explicit
        if file.resolve() != paths.legacy_db_path().resolve():
            return f"{SQLITE_PREFIX}{file}"
    return f"{SQLITE_PREFIX}{paths.db_path()}"


def _apply_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    try:
        for pragma in SQLITE_PRAGMAS:
            cursor.execute(pragma)
    finally:
        cursor.close()


def _prepare_sqlite_file(file: Path) -> None:
    """Private parent dir (0700) and, for a new DB, an owner-only (0600) file;
    SQLite gives its -wal/-shm files the same permissions as the DB."""
    paths.ensure_private_dir(file.parent)
    if not file.exists():
        os.close(os.open(file, os.O_WRONLY | os.O_CREAT, 0o600))


def make_engine(url: str, **kwargs) -> Engine:
    """Create an engine; SQLite engines get the pragmas on every connection and
    create their file on first connect (not at import)."""
    eng = create_engine(url, **kwargs)
    if eng.dialect.name == "sqlite":
        event.listen(eng, "connect", _apply_sqlite_pragmas)
        file = sqlite_file(url)
        if file is not None:

            @event.listens_for(eng, "do_connect")
            def _prepare(_dialect, _conn_rec, _cargs, _cparams) -> None:
                _prepare_sqlite_file(file)

    return eng


engine = make_engine(resolve_database_url(settings.database_url), echo=False)


def init_db() -> None:
    """Create or upgrade the schema to the latest Alembic revision (an existing
    pre-Alembic database is stamped at the baseline, not recreated)."""
    from . import models  # noqa: F401  (registers tables on SQLModel.metadata)
    from .core import migrations

    migrations.upgrade_to_head(engine)


@contextmanager
def get_session() -> Iterator[Session]:
    # expire_on_commit=False so loaded objects stay readable after the session
    # closes (CLI builds output tables after the `with` block commits).
    session = Session(engine, expire_on_commit=False)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
