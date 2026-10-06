"""SQLite pragmas (WAL, busy_timeout, foreign_keys) on every connection."""

from __future__ import annotations

import datetime as dt
import threading
import time
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, create_engine

from cashu import db
from cashu.models import Source, Transaction


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def engine(tmp_path):
    eng = db.make_engine(f"sqlite:///{tmp_path / 'pragmas.db'}")
    SQLModel.metadata.create_all(eng)
    yield eng
    eng.dispose()


def _pragmas(conn) -> tuple:
    return (
        conn.exec_driver_sql("PRAGMA journal_mode").scalar(),
        conn.exec_driver_sql("PRAGMA busy_timeout").scalar(),
        conn.exec_driver_sql("PRAGMA foreign_keys").scalar(),
    )


def test_every_connection_gets_the_pragmas(engine):
    # two connections open at the same time = two separate DBAPI connections
    with engine.connect() as c1, engine.connect() as c2:
        assert c1.connection.dbapi_connection is not c2.connection.dbapi_connection
        assert _pragmas(c1) == ("wal", 5000, 1)
        assert _pragmas(c2) == ("wal", 5000, 1)


def test_app_engine_has_the_pragma_listener():
    assert event.contains(db.engine, "connect", db._apply_sqlite_pragmas)


def test_wal_reader_sees_committed_state_during_a_write(engine, tmp_path):
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO profiles (slug, name, base_currency, mcp_privacy, created_at) "
            "VALUES ('a', 'Profil A', 'PLN', 'strict', '2026-01-01')"
        )
    writer = engine.connect()
    reader = engine.connect()
    try:
        writer.exec_driver_sql("BEGIN IMMEDIATE")
        writer.exec_driver_sql(
            "INSERT INTO profiles (slug, name, base_currency, mcp_privacy, created_at) "
            "VALUES ('b', 'Profil B', 'PLN', 'strict', '2026-01-01')"
        )
        assert Path(f"{tmp_path / 'pragmas.db'}-wal").exists()
        # the reader is not blocked and sees only committed rows
        assert reader.exec_driver_sql("SELECT COUNT(*) FROM profiles").scalar() == 1
        writer.exec_driver_sql("COMMIT")
        reader.rollback()  # end the reader's snapshot
        assert reader.exec_driver_sql("SELECT COUNT(*) FROM profiles").scalar() == 2
    finally:
        writer.close()
        reader.close()


def test_second_writer_waits_for_the_lock_instead_of_failing(engine):
    holder = engine.connect()
    holder.exec_driver_sql("BEGIN IMMEDIATE")

    def release() -> None:
        time.sleep(0.3)
        holder.exec_driver_sql("COMMIT")

    t = threading.Thread(target=release)
    t.start()
    try:
        started = time.monotonic()
        with engine.begin() as conn:  # would raise "database is locked" without a busy timeout
            conn.exec_driver_sql(
                "INSERT INTO profiles (slug, name, base_currency, mcp_privacy, created_at) "
                "VALUES ('c', 'Profil C', 'PLN', 'strict', '2026-01-01')"
            )
        assert time.monotonic() - started >= 0.2
    finally:
        t.join()
        holder.close()


def test_foreign_keys_are_enforced(engine, tmp_path):
    orphan = Transaction(
        account_id=999, booking_date=dt.date(2026, 9, 1), amount=Decimal("-1.00"),
        source=Source.CSV, dedup_hash="x",
    )
    with Session(engine) as s:
        s.add(orphan)
        with pytest.raises(IntegrityError, match="FOREIGN KEY"):
            s.commit()
    # contrast: a bare engine (the pre-hardening setup) silently accepts the orphan
    bare = create_engine(f"sqlite:///{tmp_path / 'bare.db'}")
    SQLModel.metadata.create_all(bare)
    with Session(bare) as s:
        s.add(Transaction(**orphan.model_dump(exclude={"id"})))
        s.commit()
    bare.dispose()


def test_service_layer_works_with_foreign_keys_on(tmp_path, monkeypatch):
    """The whole synthetic seed (imports, balances, positions, loan, vehicle,
    transfers, categorization, cash pool) runs clean with FK enforcement."""
    from conftest import seed_demo

    from cashu.modules.budget import cash as cash_pool

    engine = db.make_engine(f"sqlite:///{tmp_path / 'service.db'}")  # schema via migrations
    monkeypatch.setattr(db, "engine", engine)
    db.init_db()
    with db.get_session() as s:
        seed_demo(s)
    with db.get_session() as s:
        cash = cash_pool.add_cash_expense(
            s, amount="5.00", title="Test", category="groceries", on_date=dt.date(2026, 9, 20)
        )
        assert cash_pool.delete_cash_transaction(s, cash.id)
    with engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
        assert conn.exec_driver_sql("SELECT COUNT(*) FROM transactions").scalar() > 0
    engine.dispose()
