"""Migration 0006_agent on a copy of a 0005 database: backup first, every existing row kept, the agent
tables (proposals, mcp_calls, reviews) created empty, foreign keys clean; downgrade refuses while they
hold data and round-trips when they are empty."""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from upstream_db import make_upstream_db

from cashu import db
from cashu.core import legacy, migrations
from cashu.core.agent_models import TABLES

AGENT_TABLES = {t.__tablename__ for t in TABLES}


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


def _to(engine, revision: str, *, down: bool = False) -> None:
    with migrations.migration_connection(engine) as conn, conn.begin():
        cfg = migrations.alembic_config(conn)
        if not down and migrations.MigrationContext.configure(conn).get_current_revision() is None:
            migrations._ensure_columns(conn)
            command.stamp(cfg, migrations.BASELINE)
        (command.downgrade if down else command.upgrade)(cfg, revision)


def _tables(path: Path) -> set[str]:
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


def _db_at_0005(tmp_path: Path) -> Path:
    original = make_upstream_db(tmp_path / "original.db")
    engine = db.make_engine(f"sqlite:///{original}")
    _to(engine, "0005_investments")
    engine.dispose()
    copy = tmp_path / "work" / "cashu.db"
    copy.parent.mkdir()
    shutil.copy(original, copy)
    return copy


def test_0006_on_a_copy_of_a_0005_database(tmp_path):
    path = _db_at_0005(tmp_path)
    assert not (_tables(path) & AGENT_TABLES)
    before = legacy.table_counts(path)
    engine = db.make_engine(f"sqlite:///{path}")
    assert migrations.current_revision(engine) == "0005_investments"
    assert migrations.upgrade_to_head(engine) == migrations.head_revision()
    backup = migrations.last_backup
    assert backup is not None and backup.is_file() and backup != path
    assert legacy.table_counts(backup) == before and not (_tables(backup) & AGENT_TABLES)
    after = legacy.table_counts(path)
    for table, n in before.items():
        assert after[table] == n, table
    assert AGENT_TABLES <= _tables(path) and all(after[t] == 0 for t in AGENT_TABLES)
    with engine.connect() as c:
        assert c.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
        assert c.exec_driver_sql("PRAGMA integrity_check").scalar() == "ok"
        fks = {
            r[2] for t in AGENT_TABLES for r in c.exec_driver_sql(f"PRAGMA foreign_key_list({t})")
        }
        assert fks == {"profiles"}
    engine.dispose()


def test_downgrade_refuses_with_data_and_round_trips_when_empty(tmp_path, monkeypatch):
    from conftest import use_engine

    from cashu.core import reviews
    from cashu.core.db import get_session
    from cashu.core.models import Profile

    path = _db_at_0005(tmp_path)
    engine = db.make_engine(f"sqlite:///{path}")
    migrations.upgrade_to_head(engine)
    _to(engine, "0005_investments", down=True)
    assert not (_tables(path) & AGENT_TABLES)
    _to(engine, "head")
    assert AGENT_TABLES <= _tables(path)

    use_engine(monkeypatch, engine)
    with get_session() as s:
        from sqlmodel import select

        pid = s.exec(select(Profile)).first().id
        reviews.mark_done(s, pid, "budget", "x")
    with pytest.raises(RuntimeError, match="hold data"):
        _to(engine, "0005_investments", down=True)
    # the refused downgrade is rolled back as a whole (later revisions included)
    assert migrations.current_revision(engine) == migrations.head_revision()
    engine.dispose()
