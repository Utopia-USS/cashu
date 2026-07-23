"""Database engine, session factory, and schema initialization."""

from __future__ import annotations

from contextlib import contextmanager
from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from .config import PROJECT_ROOT, settings


def _resolve_url(url: str) -> str:
    """Make relative sqlite paths absolute w.r.t. the project root."""
    prefix = "sqlite:///"
    if url.startswith(prefix):
        raw = url[len(prefix):]
        path = PROJECT_ROOT / raw if not raw.startswith("/") else raw
        # ensure parent dir exists
        from pathlib import Path

        Path(path).parent.mkdir(parents=True, exist_ok=True)
        return f"{prefix}{path}"
    return url


engine = create_engine(_resolve_url(settings.database_url), echo=False)


def init_db() -> None:
    """Create tables if they don't exist. Imports models to register metadata."""
    from . import models  # noqa: F401  (registers tables on SQLModel.metadata)

    SQLModel.metadata.create_all(engine)
    _ensure_columns()


def _ensure_columns() -> None:
    """Lightweight additive migration (no migration framework): add columns that
    were introduced after a DB was first created. SQLite only."""
    if engine.dialect.name != "sqlite":
        return
    additions = {
        "transactions": {"category_source": "VARCHAR"},
        "loans": {"origination_date": "DATE"},
    }
    with engine.begin() as conn:
        for table, cols in additions.items():
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for col, decl in cols.items():
                if col not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


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
