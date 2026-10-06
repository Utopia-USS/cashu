"""Migration 0008_research_planned on a copy of a 0007 database: backup first, every existing row kept
(alerts get ``deleted_at`` NULL), the research and planned-deposit tables start empty, foreign keys and
integrity clean; downgrade refuses while the new tables hold data or an alert is soft-deleted and
round-trips when they are empty. Also 0007's polarity backfill: allocation drift is neutral (F6)."""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from upstream_db import make_upstream_db

from finanse import db
from finanse.core import legacy, migrations

NEW_TABLES = {"inv_planned_deposits", "research_runs", "research_notes"}
TS = "2026-10-01 00:00:00"


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


def _profile_id(path: Path) -> int:
    return _sql(path, "SELECT id FROM profiles ORDER BY id LIMIT 1")[0][0]


def _db_at(tmp_path: Path, revision: str) -> Path:
    original = make_upstream_db(tmp_path / "original.db")
    engine = db.make_engine(f"sqlite:///{original}")
    _to(engine, revision)
    engine.dispose()
    copy = tmp_path / "work" / "finanse.db"
    copy.parent.mkdir()
    shutil.copy(original, copy)
    return copy


def _insert_alert(path: Path, profile_id: int, title: str = "t") -> None:
    _sql(
        path,
        "INSERT INTO alerts (profile_id, scope, kind, params, polarity, severity, title, source, "
        "created_by, status, created_at, updated_at) VALUES (?, 'portfolio', 'custom', '{}', "
        "'neutral', 'info', ?, 'user', 'app', 'active', ?, ?)",
        profile_id,
        title,
        TS,
        TS,
    )


def test_0007_backfills_allocation_drift_as_neutral(tmp_path):
    path = _db_at(tmp_path, "0006_agent")
    pid = _profile_id(path)
    for i, kind in enumerate(("allocation_drift", "cash_level", "gain_from_cost")):
        _sql(
            path,
            "INSERT INTO inv_signals (profile_id, rule_id, kind, dedup_key, severity, status, "
            "message, payload, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'info', 'active', "
            "'m', '{}', ?, ?)",
            pid,
            f"r{i}",
            kind,
            f"r{i}",
            TS,
            TS,
        )
    engine = db.make_engine(f"sqlite:///{path}")
    _to(engine, "0007_alerts_watchlist")
    assert _sql(path, "SELECT kind, polarity FROM inv_signals ORDER BY id") == [
        ("allocation_drift", "neutral"),
        ("cash_level", "negative"),
        ("gain_from_cost", "positive"),
    ]
    engine.dispose()


def test_0008_on_a_copy_of_a_0007_database(tmp_path):
    path = _db_at(tmp_path, "0007_alerts_watchlist")
    _insert_alert(path, _profile_id(path), "Example level")
    assert not (_tables(path) & NEW_TABLES)
    before = legacy.table_counts(path)
    engine = db.make_engine(f"sqlite:///{path}")
    assert migrations.current_revision(engine) == "0007_alerts_watchlist"
    assert (
        migrations.upgrade_to_head(engine) == migrations.head_revision() == "0012_decision_signals"
    )
    backup = migrations.last_backup
    assert backup is not None and backup.is_file() and backup != path
    assert legacy.table_counts(backup) == before and not (_tables(backup) & NEW_TABLES)
    after = legacy.table_counts(path)
    for table, n in before.items():
        assert after[table] == n, table
    assert NEW_TABLES <= _tables(path) and all(after[t] == 0 for t in NEW_TABLES)
    assert _sql(path, "SELECT title, deleted_at FROM alerts") == [("Example level", None)]
    # appended by ALTER TABLE ADD COLUMN: the last column, no rebuild
    assert [r[1] for r in _sql(path, "PRAGMA table_info('alerts')")][-1] == "deleted_at"
    assert [r[1] for r in _sql(path, "PRAGMA table_info('accounts')")][-1] == "removed_at"  # 0010
    assert [r[1] for r in _sql(path, "PRAGMA table_info('research_notes')")][
        -1
    ] == "read_at"  # 0011
    assert _sql(path, "PRAGMA foreign_key_check") == []
    assert _sql(path, "PRAGMA integrity_check") == [("ok",)]
    engine.dispose()


def test_0008_downgrade_refuses_with_data_and_round_trips_when_empty(tmp_path):
    path = _db_at(tmp_path, "0007_alerts_watchlist")
    engine = db.make_engine(f"sqlite:///{path}")
    migrations.upgrade_to_head(engine)
    _to(engine, "0007_alerts_watchlist", down=True)
    assert not (_tables(path) & NEW_TABLES)
    assert "deleted_at" not in {r[1] for r in _sql(path, "PRAGMA table_info('alerts')")}
    _to(engine, "head")
    assert NEW_TABLES <= _tables(path)

    pid = _profile_id(path)
    _sql(
        path,
        "INSERT INTO inv_instruments (id, name, currency, asset_class, tags, needs_classification, "
        "valuation_mode, status, created_at, updated_at) VALUES (900, 'Example', 'EUR', 'etf', "
        "'[]', 0, 'market', 'active', ?, ?)",
        TS,
        TS,
    )
    inserts = {
        "inv_planned_deposits": (
            (
                "INSERT INTO inv_planned_deposits (profile_id, amount, currency, planned_date, "
                "status, created_at, updated_at) VALUES (?, '500', 'PLN', '2026-10-10', "
                "'planned', ?, ?)"
            ),
            (pid, TS, TS),
        ),
        "research_runs": (
            (
                "INSERT INTO research_runs (profile_id, started_at, status, scope, counts, "
                "created_by) VALUES (?, ?, 'running', '{}', '{}', 'agent')"
            ),
            (pid, TS),
        ),
        "research_notes": (
            (
                "INSERT INTO research_notes (profile_id, instrument_id, kind, polarity, strength, "
                "thesis_relation, title, summary, sources, observed_at, expires_at, created_by, "
                "created_at, updated_at) VALUES (?, 900, 'news', 'neutral', 1, 'none', 't', 's', "
                "'[{\"url\": \"https://example.com/a\"}]', ?, ?, 'agent', ?, ?)"
            ),
            (pid, TS, TS, TS, TS),
        ),
    }
    for table, (sql, args) in inserts.items():
        _sql(path, sql, *args)
        with pytest.raises(RuntimeError, match="hold data"):
            _to(engine, "0007_alerts_watchlist", down=True)
        assert migrations.current_revision(engine) == migrations.head_revision(), table
        assert NEW_TABLES <= _tables(path), table  # refused before any DDL
        _sql(path, f"DELETE FROM {table}")

    _insert_alert(path, pid)
    _sql(path, "UPDATE alerts SET deleted_at = ?", TS)
    with pytest.raises(RuntimeError, match=r"alerts\.deleted_at"):
        _to(engine, "0007_alerts_watchlist", down=True)
    _sql(path, "UPDATE alerts SET deleted_at = NULL")  # a live alert does not block the downgrade
    _to(engine, "0007_alerts_watchlist", down=True)
    assert migrations.current_revision(engine) == "0007_alerts_watchlist"
    assert len(_sql(path, "SELECT id FROM alerts")) == 1
    engine.dispose()


def test_0011_backfills_read_at_and_round_trips(tmp_path):
    """F8: existing research notes count as read after the upgrade (nothing lights up); the
    downgrade drops the column and its index."""
    path = _db_at(tmp_path, "0010_account_removed")
    pid = _profile_id(path)
    _sql(
        path,
        "INSERT INTO research_notes (profile_id, kind, polarity, strength, thesis_relation, title, "
        "summary, sources, observed_at, expires_at, created_by, created_at, updated_at) VALUES "
        "(?, 'news', 'neutral', 1, 'none', 'Example', 'Przykladowy fakt.', '[]', ?, ?, 'agent', ?, ?)",
        pid,
        TS,
        TS,
        TS,
        TS,
    )
    engine = db.make_engine(f"sqlite:///{path}")
    _to(engine, "0011_research_read")
    assert migrations.current_revision(engine) == "0011_research_read"
    assert _sql(path, "SELECT read_at = created_at FROM research_notes") == [(1,)]
    assert [r[1] for r in _sql(path, "PRAGMA table_info('research_notes')")][-1] == "read_at"
    assert ("ix_research_notes_unread",) in _sql(
        path, "SELECT name FROM sqlite_master WHERE type = 'index'"
    )
    _to(engine, "0010_account_removed", down=True)
    assert "read_at" not in [r[1] for r in _sql(path, "PRAGMA table_info('research_notes')")]
    assert _sql(path, "SELECT title FROM research_notes") == [("Example",)]
    assert _sql(path, "PRAGMA integrity_check") == [("ok",)]
    engine.dispose()


def test_0012_backfills_decision_links_and_round_trips(tmp_path):
    """F9: every decision with a signal gets its link row; a free decision none. The downgrade
    refuses while a decision covers a signal its ``signal_id`` column cannot hold."""
    path = _db_at(tmp_path, "0011_research_read")
    pid = _profile_id(path)
    for i in (1, 2):
        _sql(
            path,
            "INSERT INTO inv_signals (id, profile_id, rule_id, kind, dedup_key, severity, status, "
            "message, payload, first_seen_at, last_seen_at, polarity) VALUES (?, ?, ?, "
            "'gain_from_cost', ?, 'info', 'acknowledged', 'm', '{}', ?, ?, 'neutral')",
            i,
            pid,
            f"r{i}",
            f"r{i}",
            TS,
            TS,
        )
    for decision_id, signal_id in ((10, 1), (11, None)):
        _sql(
            path,
            "INSERT INTO inv_decisions (id, profile_id, signal_id, action, created_at) "
            "VALUES (?, ?, ?, 'held', ?)",
            decision_id,
            pid,
            signal_id,
            TS,
        )
    engine = db.make_engine(f"sqlite:///{path}")
    assert migrations.upgrade_to_head(engine) == "0012_decision_signals"
    assert _sql(path, "SELECT decision_id, signal_id FROM inv_decision_signals") == [(10, 1)]
    assert ("ix_inv_decision_signals_signal_id",) in _sql(
        path, "SELECT name FROM sqlite_master WHERE type = 'index'"
    )
    _sql(path, "INSERT INTO inv_decision_signals (decision_id, signal_id) VALUES (10, 2)")
    with pytest.raises(RuntimeError, match="several signals"):
        _to(engine, "0011_research_read", down=True)
    assert migrations.current_revision(engine) == "0012_decision_signals"
    _sql(path, "DELETE FROM inv_decision_signals WHERE signal_id = 2")
    _to(engine, "0011_research_read", down=True)
    assert "inv_decision_signals" not in _tables(path)
    assert _sql(path, "SELECT id, signal_id FROM inv_decisions ORDER BY id") == [
        (10, 1),
        (11, None),
    ]
    _to(engine, "head")
    assert _sql(path, "SELECT decision_id, signal_id FROM inv_decision_signals") == [(10, 1)]
    assert _sql(path, "PRAGMA foreign_key_check") == []
    assert _sql(path, "PRAGMA integrity_check") == [("ok",)]
    engine.dispose()
