"""Schema migrations (Alembic).

``upgrade_to_head(engine)`` is what ``db.init_db()`` runs on every start:

- empty database -> run every revision (the baseline creates the upstream schema);
- database created by the pre-Alembic ``create_all`` (tables, no
  ``alembic_version``) -> pre-baseline shim (create a missing baseline table, add
  the columns the old ``_ensure_columns`` added), then stamp it at the baseline:
  existing tables and rows are never recreated;
- versioned database -> upgrade to head (a cheap no-op when already current).

New revisions: ``alembic revision --autogenerate -m "..."`` from the repo root
(see alembic.ini). SQLite changes to existing tables go through
``op.batch_alter_table`` (table rebuild); foreign-key enforcement is switched off
for the duration of a migration run so rebuilds of referenced tables work.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection, Engine

SCRIPT_DIR = Path(__file__).resolve().parent
BASELINE = "0001_baseline"
BASELINE_TABLES = frozenset(
    {
        "accounts",
        "balances",
        "category_rules",
        "depreciations",
        "import_batches",
        "loans",
        "transactions",
    }
)

# Columns introduced after the first schema, which the pre-Alembic
# `db._ensure_columns()` added on every start. Only used by the pre-baseline shim.
PRE_BASELINE_COLUMNS = {
    "transactions": {"category_source": "VARCHAR"},
    "loans": {"origination_date": "DATE"},
}


def alembic_config(connection: Connection | None = None) -> Config:
    """Programmatic config (no alembic.ini needed, works in an installed package)."""
    cfg = Config()
    cfg.set_main_option("script_location", str(SCRIPT_DIR))
    if connection is not None:
        cfg.attributes["connection"] = connection
    return cfg


def script_directory() -> ScriptDirectory:
    return ScriptDirectory.from_config(alembic_config())


def head_revision() -> str:
    head = script_directory().get_current_head()
    assert head is not None
    return head


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


@contextmanager
def migration_connection(engine: Engine) -> Iterator[Connection]:
    """A connection with SQLite foreign-key enforcement off for the migration run
    (batch rebuilds drop and recreate referenced tables); restored afterwards so
    the pooled connection goes back with the normal pragmas."""
    with engine.connect() as conn:
        sqlite = conn.dialect.name == "sqlite"
        if sqlite:
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
            conn.commit()
        try:
            yield conn
        finally:
            if sqlite:
                conn.rollback()
                conn.exec_driver_sql("PRAGMA foreign_keys=ON")
                conn.commit()


def _create_missing_baseline_tables(conn: Connection, script: ScriptDirectory) -> None:
    missing = BASELINE_TABLES - set(sa.inspect(conn).get_table_names())
    if missing:
        baseline = script.get_revision(BASELINE)
        assert baseline is not None
        baseline.module.create_schema(Operations(MigrationContext.configure(conn)), only=missing)


def _ensure_columns(conn: Connection) -> None:
    """Pre-baseline shim (the former ``db._ensure_columns``): additive ALTERs that
    bring a database created by an older ``create_all`` up to the baseline."""
    if conn.dialect.name != "sqlite":
        return
    for table, cols in PRE_BASELINE_COLUMNS.items():
        existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
        for col, decl in cols.items():
            if col not in existing:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def upgrade_to_head(engine: Engine) -> str:
    """Bring the database at ``engine`` to the head revision; returns the head."""
    script = script_directory()
    head = script.get_current_head()
    with engine.connect() as conn:
        tables = set(sa.inspect(conn).get_table_names())
        current = MigrationContext.configure(conn).get_current_revision()
    if current == head:
        return head
    with migration_connection(engine) as conn, conn.begin():
        cfg = alembic_config(conn)
        if current is None and tables & BASELINE_TABLES:
            # Pre-Alembic database: adopt it at the baseline instead of recreating it.
            _create_missing_baseline_tables(conn, script)
            _ensure_columns(conn)
            command.stamp(cfg, BASELINE)
        command.upgrade(cfg, "head")
    return head
