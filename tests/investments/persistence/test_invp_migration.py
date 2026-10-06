"""Migration 0005 on a copy of a 0004 database: backup first, every existing row kept, the inv_
tables created empty, foreign keys clean, the module usable afterwards; downgrade refuses while the
investments tables hold data."""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from upstream_db import make_upstream_db

from cashu import db
from cashu.core import legacy, migrations
from cashu.modules.investments.models import TABLES

INV_TABLES = {t.__tablename__ for t in TABLES}


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


def _to(engine, revision: str, *, down: bool = False) -> None:
    with migrations.migration_connection(engine) as conn, conn.begin():
        cfg = migrations.alembic_config(conn)
        if not down and migrations.MigrationContext.configure(conn).get_current_revision() is None:
            # a pre-Alembic upstream database: adopt it at the baseline (as upgrade_to_head does)
            migrations._ensure_columns(conn)
            command.stamp(cfg, migrations.BASELINE)
        (command.downgrade if down else command.upgrade)(cfg, revision)


def _tables(path: Path) -> set[str]:
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


def _db_at_0004(tmp_path: Path) -> Path:
    """An upstream database with rows, upgraded to 0004, then copied (the file the test migrates)."""
    original = make_upstream_db(tmp_path / "original.db")
    engine = db.make_engine(f"sqlite:///{original}")
    _to(engine, "0004_loan_payments")
    engine.dispose()
    copy = tmp_path / "work" / "cashu.db"
    copy.parent.mkdir()
    shutil.copy(original, copy)
    return copy


def test_0005_on_a_copy_of_a_0004_database(tmp_path):
    path = _db_at_0004(tmp_path)
    assert not (_tables(path) & INV_TABLES)
    before = legacy.table_counts(path)

    engine = db.make_engine(f"sqlite:///{path}")
    assert migrations.current_revision(engine) == "0004_loan_payments"
    assert migrations.upgrade_to_head(engine) == migrations.head_revision()

    backup = migrations.last_backup  # written before any revision ran
    assert backup is not None and backup.is_file() and backup != path
    assert legacy.table_counts(backup) == before and not (_tables(backup) & INV_TABLES)
    after = legacy.table_counts(path)
    for table, n in before.items():
        assert after[table] == n, table
    assert INV_TABLES <= _tables(path)
    assert all(after[t] == 0 for t in INV_TABLES)
    with engine.connect() as c:
        assert c.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
        assert c.exec_driver_sql("PRAGMA integrity_check").scalar() == "ok"
        # the migrated default profile keeps its modules (investments is opt-in)
        modules = [r[0] for r in c.exec_driver_sql("SELECT module_id FROM profile_modules")]
        assert "investments" not in modules
    engine.dispose()


def test_migrated_database_takes_investments_data(tmp_path, monkeypatch):
    from conftest import use_engine
    from invp_support import add_account, canonical_csv, import_file

    from cashu.core.db import get_session
    from cashu.core.models import Profile

    path = _db_at_0004(tmp_path)
    engine = db.make_engine(f"sqlite:///{path}")
    use_engine(monkeypatch, engine)
    db.init_db()
    with get_session() as s:
        pid = s.query(Profile).first().id
    aid = add_account(pid)
    assert import_file(pid, aid, canonical_csv()).inserted == 5

    with pytest.raises(RuntimeError, match="hold data"):
        _to(engine, "0004_loan_payments", down=True)
    assert migrations.current_revision(engine) == migrations.head_revision()
    engine.dispose()


def test_downgrade_drops_empty_investments_tables(tmp_path):
    path = _db_at_0004(tmp_path)
    engine = db.make_engine(f"sqlite:///{path}")
    migrations.upgrade_to_head(engine)
    _to(engine, "0004_loan_payments", down=True)
    assert not (_tables(path) & INV_TABLES)
    assert migrations.current_revision(engine) == "0004_loan_payments"
    _to(engine, "head")
    assert INV_TABLES <= _tables(path)
    engine.dispose()
