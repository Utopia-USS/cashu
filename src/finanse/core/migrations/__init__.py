"""Schema migrations (Alembic).

``upgrade_to_head(engine)`` is what ``db.init_db()`` runs on every start:

- empty database -> run every revision (the baseline creates the upstream schema);
- database created by the pre-Alembic ``create_all`` (tables, no
  ``alembic_version``) -> pre-baseline shim (create a missing baseline table, add
  the columns the old ``_ensure_columns`` added), then stamp it at the baseline:
  existing tables and rows are never recreated;
- versioned database -> upgrade to head (a cheap no-op when already current).

Before applying revisions to a database file that holds data, a consistent copy
is written to ``<db dir>/backups/finanse-pre-<head>-<UTC time>.db`` (SQLite DDL is
not transactional, so a failed multi-step upgrade could leave a half-migrated
file); ``last_backup`` holds its path.

New revisions: ``alembic revision --autogenerate -m "..."`` from the repo root
(see alembic.ini). ``alembic upgrade``/``downgrade`` from the CLI take the same
backup first (``backup_for_cli``; ``-x no-backup=1`` opts out explicitly).
SQLite changes to existing tables go through
``op.batch_alter_table`` (table rebuild); foreign-key enforcement is switched off
for the duration of a migration run so rebuilds of referenced tables work.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
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


# Path of the backup written by the last upgrade that needed one (None: no backup).
last_backup: Path | None = None


def _has_data(conn: Connection, tables: set[str]) -> bool:
    return any(
        conn.exec_driver_sql(f'SELECT 1 FROM "{t}" LIMIT 1').first() is not None
        for t in tables & BASELINE_TABLES
    )


def _sqlite_db_file(engine: Engine) -> Path | None:
    if engine.dialect.name != "sqlite" or not engine.url.database:
        return None
    if engine.url.database == ":memory:":
        return None
    file = Path(engine.url.database)
    return file if file.exists() else None


def backup_before_upgrade(engine: Engine, head: str, *, now: dt.datetime | None = None) -> Path | None:
    """Consistent copy of a file-based SQLite database next to it (``backups/``).

    The legacy ``<repo>/data/finanse.db`` (legacy mode, before ``migrate-data``) is
    copied into the data dir's ``backups/`` instead: the user is told to delete the
    repo's ``data/`` after migrating, and this copy is the only pre-upgrade one."""
    from .. import legacy, paths

    file = _sqlite_db_file(engine)
    if file is None:
        return None
    stamp = (now or dt.datetime.now(dt.UTC)).strftime("%Y%m%d-%H%M%S")
    if paths.is_legacy_db(file):
        name = f"{paths.LEGACY_PRE_UPGRADE_PREFIX}{head}-{stamp}.db"
        return legacy.backup_sqlite(file, paths.backups_dir() / name)
    return legacy.backup_sqlite(file, file.parent / "backups" / f"finanse-pre-{head}-{stamp}.db")


def needs_backup(engine: Engine, has_data: bool) -> bool:
    """Back up before upgrading a file that holds data, and always the legacy DB."""
    from .. import paths

    file = _sqlite_db_file(engine)
    return file is not None and (has_data or paths.is_legacy_db(file))


class BackupError(RuntimeError):
    """The pre-migration copy could not be written (nothing was migrated)."""


# Alembic CLI commands that change the schema (the others only read it or write scripts).
SCHEMA_COMMANDS = frozenset({"upgrade", "downgrade"})


def backup_for_cli(engine: Engine, command_name: str | None, *, skip: bool = False) -> Path | None:
    """What the developer ``alembic`` CLI runs before touching the app's database
    (env.py): the same copy the startup path takes, for ``upgrade``/``downgrade`` on
    a file with data (always for the legacy repo DB). ``skip`` is the explicit
    ``-x no-backup=1`` opt-out; a failed copy raises ``BackupError``."""
    global last_backup
    if skip or command_name not in SCHEMA_COMMANDS:
        return None
    with engine.connect() as conn:
        tables = set(sa.inspect(conn).get_table_names())
        current = MigrationContext.configure(conn).get_current_revision()
        has_data = _has_data(conn, tables)
    head = head_revision()
    if (command_name == "upgrade" and current == head) or not needs_backup(engine, has_data):
        return None
    label = head if command_name == "upgrade" else f"downgrade-from-{current or 'base'}"
    try:
        last_backup = backup_before_upgrade(engine, label)
    except (OSError, sqlite3.Error) as e:
        raise BackupError(
            f"Could not back up the database before `alembic {command_name}` ({e}); nothing "
            "was migrated. Free the space or fix the permissions, or re-run with "
            "`alembic -x no-backup=1 ...` to migrate without a copy."
        ) from e
    return last_backup


def upgrade_to_head(engine: Engine) -> str:
    """Bring the database at ``engine`` to the head revision; returns the head."""
    global last_backup
    script = script_directory()
    head = script.get_current_head()
    with engine.connect() as conn:
        tables = set(sa.inspect(conn).get_table_names())
        current = MigrationContext.configure(conn).get_current_revision()
        has_data = _has_data(conn, tables)
    if current == head:
        return head
    if needs_backup(engine, has_data):
        last_backup = backup_before_upgrade(engine, head)
    with migration_connection(engine) as conn, conn.begin():
        cfg = alembic_config(conn)
        if current is None and tables & BASELINE_TABLES:
            # Pre-Alembic database: adopt it at the baseline instead of recreating it.
            _create_missing_baseline_tables(conn, script)
            _ensure_columns(conn)
            command.stamp(cfg, BASELINE)
        command.upgrade(cfg, "head")
    return head
