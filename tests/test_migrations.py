"""Alembic baseline: equal to the upstream `create_all` schema; pre-Alembic
databases are stamped, never recreated."""

from __future__ import annotations

import datetime as dt
import os
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlmodel import Session, SQLModel

from finanse import db
from finanse.core import migrations
from finanse.models import Account, AccountType, Bank, Source, Transaction

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FINANSE_DATA_DIR", str(tmp_path / "data"))


def _engine(path: Path, **kwargs):
    return db.make_engine(f"sqlite:///{path}", **kwargs)


def schema(engine) -> dict:
    """Tables, columns, indexes, unique constraints, foreign keys and normalized
    DDL of a SQLite database (Alembic's own version table excluded)."""
    out: dict = {}
    with engine.connect() as c:
        rows = c.exec_driver_sql(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE tbl_name != 'alembic_version' ORDER BY name"
        ).fetchall()
        for typ, name, _tbl, sql in rows:
            out[f"ddl:{typ}:{name}"] = re.sub(r"\s+", " ", sql or "").strip()
        for t in [r[1] for r in rows if r[0] == "table"]:
            out[f"columns:{t}"] = [tuple(r) for r in c.exec_driver_sql(f"PRAGMA table_xinfo('{t}')")]
            out[f"fks:{t}"] = sorted(tuple(r) for r in c.exec_driver_sql(f"PRAGMA foreign_key_list('{t}')"))
            indexes = {}
            for _seq, iname, unique, origin, partial in c.exec_driver_sql(f"PRAGMA index_list('{t}')"):
                cols = [r[2] for r in c.exec_driver_sql(f"PRAGMA index_info('{iname}')")]
                indexes[iname] = (unique, origin, partial, cols)
            out[f"indexes:{t}"] = indexes
    return out


def columns(engine) -> dict[str, set]:
    """Per table: {(name, declared type, notnull, pk)} (order-insensitive)."""
    with engine.connect() as c:
        tables = [r[0] for r in c.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "AND name != 'alembic_version'")]
        return {
            t: {(r[1], r[2], r[3], r[5]) for r in c.exec_driver_sql(f"PRAGMA table_info('{t}')")}
            for t in tables
        }


def _seed(engine) -> None:
    with Session(engine) as s:
        acc = Account(bank=Bank.ERSTE, name="Konto Test", iban="99000000000000000000000002",
                      type=AccountType.SAVINGS)
        s.add(acc)
        s.commit()
        s.add(Transaction(account_id=acc.id, booking_date=dt.date(2026, 8, 3),
                          amount=Decimal("100.00"), source=Source.CSV, dedup_hash="m1"))
        s.commit()


def test_baseline_equals_create_all(tmp_path):
    reference = _engine(tmp_path / "create_all.db")
    SQLModel.metadata.create_all(reference)
    migrated = _engine(tmp_path / "alembic.db")
    assert migrations.upgrade_to_head(migrated) == migrations.head_revision()

    expected, actual = schema(reference), schema(migrated)
    assert actual == expected
    tables = {k.split(":", 2)[2] for k in expected if k.startswith("ddl:table:")}
    assert tables == migrations.BASELINE_TABLES
    assert sum(k.startswith("ddl:index:ix_") for k in expected) == 14
    reference.dispose()
    migrated.dispose()


def test_models_have_no_unmigrated_changes(tmp_path):
    """Drift guard: a model change without an Alembic revision fails here."""
    engine = _engine(tmp_path / "head.db")
    migrations.upgrade_to_head(engine)
    with engine.connect() as conn:
        diff = compare_metadata(
            MigrationContext.configure(conn, opts={"compare_type": True}), SQLModel.metadata
        )
    assert diff == []
    engine.dispose()


def test_existing_create_all_db_is_stamped_not_recreated(tmp_path):
    engine = _engine(tmp_path / "upstream.db")
    SQLModel.metadata.create_all(engine)  # how the upstream created every DB
    _seed(engine)
    with engine.connect() as c:
        rootpages = dict(c.exec_driver_sql("SELECT name, rootpage FROM sqlite_master").all())
        before_rows = c.exec_driver_sql("SELECT * FROM transactions").fetchall()
    assert migrations.current_revision(engine) is None

    migrations.upgrade_to_head(engine)

    assert migrations.current_revision(engine) == migrations.BASELINE
    with engine.connect() as c:
        after = dict(c.exec_driver_sql("SELECT name, rootpage FROM sqlite_master").all())
        assert c.exec_driver_sql("SELECT * FROM transactions").fetchall() == before_rows
    # same b-tree root pages = the tables and indexes were not dropped and recreated
    assert {k: v for k, v in after.items() if k in rootpages} == rootpages
    fresh = _engine(tmp_path / "fresh.db")
    migrations.upgrade_to_head(fresh)
    assert schema(engine) == schema(fresh)
    engine.dispose()
    fresh.dispose()


def test_pre_baseline_shim_adds_missing_columns_and_tables(tmp_path):
    engine = _engine(tmp_path / "old.db")
    SQLModel.metadata.create_all(engine)
    with engine.begin() as c:  # an older upstream DB: before the two _ensure_columns columns
        c.exec_driver_sql("ALTER TABLE transactions DROP COLUMN category_source")
        c.exec_driver_sql("ALTER TABLE loans DROP COLUMN origination_date")
        c.exec_driver_sql("DROP TABLE depreciations")
        # rows written by that older version (raw SQL: today's models have more columns)
        c.exec_driver_sql(
            "INSERT INTO accounts (id, bank, name, currency, type, active, created_at) "
            "VALUES (1, 'MANUAL', 'Kredyt Test', 'PLN', 'LOAN', 1, '2026-01-01 00:00:00')"
        )
        c.exec_driver_sql(
            "INSERT INTO transactions (account_id, booking_date, amount, currency, source, "
            "dedup_hash, occurrence, is_internal_transfer, created_at) "
            "VALUES (1, '2026-01-05', '-100.00', 'PLN', 'CSV', 'old1', 0, 0, '2026-01-05')"
        )
        c.exec_driver_sql(
            "INSERT INTO loans (account_id, principal, annual_rate, term_months, start_date, "
            "created_at) VALUES (1, '1000', '5', 12, '2026-01-01', '2026-01-01')"
        )

    migrations.upgrade_to_head(engine)

    assert migrations.current_revision(engine) == migrations.BASELINE
    reference = _engine(tmp_path / "ref.db")
    SQLModel.metadata.create_all(reference)
    assert columns(engine) == columns(reference)
    with engine.connect() as c:
        assert c.exec_driver_sql("SELECT COUNT(*) FROM transactions").scalar() == 1
        assert c.exec_driver_sql("SELECT origination_date FROM loans").scalar() is None
    engine.dispose()
    reference.dispose()


def test_upgrade_is_idempotent_with_a_fast_path(tmp_path, monkeypatch):
    engine = _engine(tmp_path / "twice.db")
    head = migrations.upgrade_to_head(engine)

    def boom(*_a, **_k):
        raise AssertionError("alembic command run although the DB is current")

    monkeypatch.setattr(migrations.command, "upgrade", boom)
    monkeypatch.setattr(migrations.command, "stamp", boom)
    assert migrations.upgrade_to_head(engine) == head
    engine.dispose()


def test_foreign_keys_restored_after_migration(tmp_path):
    engine = _engine(tmp_path / "fk.db", pool_size=1, max_overflow=0)  # one reused connection
    migrations.upgrade_to_head(engine)
    with engine.connect() as c:
        assert c.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
    engine.dispose()


def test_downgrade_to_base_and_upgrade_again(tmp_path):
    engine = _engine(tmp_path / "down.db")
    migrations.upgrade_to_head(engine)
    with migrations.migration_connection(engine) as conn, conn.begin():
        command.downgrade(migrations.alembic_config(conn), "base")
    assert columns(engine) == {}
    migrations.upgrade_to_head(engine)
    reference = _engine(tmp_path / "ref.db")
    SQLModel.metadata.create_all(reference)
    assert schema(engine) == schema(reference)
    engine.dispose()
    reference.dispose()


def test_init_db_upgrades_the_app_engine(tmp_path, monkeypatch):
    engine = _engine(tmp_path / "app.db")
    monkeypatch.setattr(db, "engine", engine)
    db.init_db()
    assert migrations.current_revision(engine) == migrations.head_revision()
    assert set(columns(engine)) == migrations.BASELINE_TABLES
    engine.dispose()


def test_single_head_and_baseline_is_root():
    script = migrations.script_directory()
    assert script.get_heads() == [migrations.head_revision()]
    assert script.get_revision(migrations.BASELINE).down_revision is None


def test_alembic_cli_uses_the_finanse_database(tmp_path):
    """Developer path: `alembic upgrade head` / `alembic check` from the repo root."""
    env = {k: v for k, v in os.environ.items() if k != "FINANSE_DATABASE_URL"}
    env["FINANSE_DATA_DIR"] = str(tmp_path / "cli-data")
    run = [sys.executable, "-m", "alembic", "-c", str(REPO / "alembic.ini")]
    up = subprocess.run([*run, "upgrade", "head"], cwd=REPO, env=env, capture_output=True,
                        text=True, timeout=60, check=False)
    assert up.returncode == 0, up.stderr
    created = tmp_path / "cli-data" / "finanse.db"
    assert created.exists()
    check = subprocess.run([*run, "check"], cwd=REPO, env=env, capture_output=True, text=True,
                           timeout=60, check=False)
    assert check.returncode == 0, check.stderr
    engine = _engine(created)
    assert migrations.current_revision(engine) == migrations.head_revision()
    engine.dispose()
