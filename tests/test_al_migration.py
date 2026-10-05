"""Migration 0007_alerts_watchlist on a copy of a 0006 database: backup first, every existing row kept,
existing signals get the default polarity of their kind (and no snooze), the new tables start empty,
foreign keys and integrity clean; downgrade refuses while the new tables hold data and round-trips when
they are empty."""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from upstream_db import make_upstream_db

from finanse import db
from finanse.core import legacy, migrations

NEW_TABLES = {"alerts", "watchlist_items", "inv_profile_instruments"}


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FINANSE_DATA_DIR", str(tmp_path / "data"))


def _to(engine, revision: str, *, down: bool = False) -> None:
    with migrations.migration_connection(engine) as conn, conn.begin():
        cfg = migrations.alembic_config(conn)
        if not down and migrations.MigrationContext.configure(conn).get_current_revision() is None:
            migrations._ensure_columns(conn)
            command.stamp(cfg, migrations.BASELINE)
        (command.downgrade if down else command.upgrade)(cfg, revision)


def _sql(path: Path, query: str, *args) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        rows = conn.execute(query, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def _tables(path: Path) -> set[str]:
    return {r[0] for r in _sql(path, "SELECT name FROM sqlite_master WHERE type='table'")}


def _db_at_0006_with_signals(tmp_path: Path) -> Path:
    original = make_upstream_db(tmp_path / "original.db")
    engine = db.make_engine(f"sqlite:///{original}")
    _to(engine, "0006_agent")
    engine.dispose()
    (profile_id,) = _sql(original, "SELECT id FROM profiles ORDER BY id LIMIT 1")[0]
    for i, kind in enumerate(("position_concentration", "drawdown_from_high", "custom", "odd")):
        _sql(
            original,
            "INSERT INTO inv_signals (profile_id, rule_id, kind, dedup_key, severity, status, "
            "message, payload, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'info', 'active', "
            "'m', '{}', '2026-09-01 00:00:00', '2026-09-01 00:00:00')",
            profile_id,
            f"r{i}",
            kind,
            f"r{i}",
        )
    copy = tmp_path / "work" / "finanse.db"
    copy.parent.mkdir()
    shutil.copy(original, copy)
    return copy


def test_0007_on_a_copy_of_a_0006_database(tmp_path):
    path = _db_at_0006_with_signals(tmp_path)
    assert not (_tables(path) & NEW_TABLES)
    before = legacy.table_counts(path)
    engine = db.make_engine(f"sqlite:///{path}")
    assert migrations.current_revision(engine) == "0006_agent"
    assert migrations.upgrade_to_head(engine) == migrations.head_revision()
    backup = migrations.last_backup
    assert backup is not None and backup.is_file() and backup != path
    assert legacy.table_counts(backup) == before and not (_tables(backup) & NEW_TABLES)
    after = legacy.table_counts(path)
    for table, n in before.items():
        assert after[table] == n, table
    assert NEW_TABLES <= _tables(path) and all(after[t] == 0 for t in NEW_TABLES)
    assert _sql(path, "SELECT kind, polarity, snoozed_until FROM inv_signals ORDER BY id") == [
        ("position_concentration", "negative", None),
        ("drawdown_from_high", "positive", None),
        ("custom", "neutral", None),
        ("odd", "neutral", None),
    ]
    assert _sql(path, "PRAGMA foreign_key_check") == []
    assert _sql(path, "PRAGMA integrity_check") == [("ok",)]
    # the partial unique index of open signals survived the ALTER (no rebuild)
    (index_sql,) = _sql(
        path, "SELECT sql FROM sqlite_master WHERE name = 'uq_inv_signals_open_key'"
    )[0]
    assert "WHERE status IN ('active', 'acknowledged')" in index_sql
    engine.dispose()


def test_downgrade_refuses_with_data_and_round_trips_when_empty(tmp_path):
    path = _db_at_0006_with_signals(tmp_path)
    engine = db.make_engine(f"sqlite:///{path}")
    migrations.upgrade_to_head(engine)
    _to(engine, "0006_agent", down=True)
    assert not (_tables(path) & NEW_TABLES)
    columns = {r[1] for r in _sql(path, "PRAGMA table_info('inv_signals')")}
    assert "polarity" not in columns and "snoozed_until" not in columns
    assert len(_sql(path, "SELECT id FROM inv_signals")) == 4  # rows kept
    _to(engine, "head")
    assert NEW_TABLES <= _tables(path)

    (profile_id,) = _sql(path, "SELECT id FROM profiles ORDER BY id LIMIT 1")[0]
    _sql(
        path,
        "INSERT INTO inv_instruments (id, name, currency, asset_class, tags, needs_classification, "
        "valuation_mode, status, created_at, updated_at) VALUES (900, 'Example', 'EUR', 'etf', "
        "'[]', 0, 'market', 'active', '2026-10-01', '2026-10-01')",
    )
    inserts = {
        "alerts": (
            "INSERT INTO alerts (profile_id, scope, kind, params, polarity, severity, title, "
            "source, created_by, status, created_at, updated_at) VALUES (?, 'portfolio', "
            "'custom', '{}', 'neutral', 'info', 't', 'user', 'app', 'active', '2026-10-01', "
            "'2026-10-01')"
        ),
        "watchlist_items": (
            "INSERT INTO watchlist_items (profile_id, instrument_id, tags, source, added_at) "
            "VALUES (?, 900, '[]', 'user', '2026-10-01')"
        ),
        "inv_profile_instruments": (
            "INSERT INTO inv_profile_instruments (profile_id, instrument_id, status, created_at, "
            "updated_at) VALUES (?, 900, 'frozen', '2026-10-01', '2026-10-01')"
        ),
    }
    # refuse from 0007 itself: on SQLite the DDL of a later revision's downgrade (0008) is not rolled
    # back when an earlier one refuses (the backup covers that, see core.migrations)
    _to(engine, "0007_alerts_watchlist", down=True)
    for table, sql in inserts.items():
        _sql(path, sql, profile_id)
        with pytest.raises(RuntimeError, match="hold data"):
            _to(engine, "0006_agent", down=True)
        assert migrations.current_revision(engine) == "0007_alerts_watchlist", table
        _sql(path, f"DELETE FROM {table}")
    _to(engine, "0006_agent", down=True)
    assert migrations.current_revision(engine) == "0006_agent"
    engine.dispose()
