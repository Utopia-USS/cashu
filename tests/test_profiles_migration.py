"""Upgrading an upstream database: rows preserved and assigned to one default
profile with the modules its data uses (0002), registry ids (0003), loan columns
(0004); backup first, foreign keys checked."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from alembic import command
from upstream_db import UPSTREAM_ROWS, create_upstream_schema, make_upstream_db

from cashu import db
from cashu.core import legacy, migrations

KEEP = ("transactions", "balances", "depreciations")  # no revision changes these rows


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


def _rows(path: Path, sql: str) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def _upgrade(path: Path) -> None:
    engine = db.make_engine(f"sqlite:///{path}")
    try:
        migrations.upgrade_to_head(engine)
    finally:
        engine.dispose()


def test_upstream_db_migrates_into_a_default_profile(tmp_path):
    path = make_upstream_db(tmp_path / "cashu.db")
    before_counts = legacy.table_counts(path)
    kept_before = {t: _rows(path, f"SELECT * FROM {t} ORDER BY id") for t in KEEP}

    _upgrade(path)

    # a consistent backup of the original was taken first
    (backup,) = (tmp_path / "backups").glob(f"cashu-pre-{migrations.head_revision()}-*.db")
    assert legacy.table_counts(backup) == before_counts
    assert _rows(backup, "SELECT bank, type FROM accounts WHERE id = 1") == [("MBANK", "CHECKING")]

    # every row survived
    after_counts = legacy.table_counts(path)
    for table, n in before_counts.items():
        assert after_counts[table] == n, table
    for t in KEEP:
        assert _rows(path, f"SELECT * FROM {t} ORDER BY id") == kept_before[t]

    # one default profile owns everything, with the modules its data uses
    assert _rows(path, "SELECT id, slug, name, base_currency, mcp_privacy FROM profiles") == [
        (1, "default", "Domyślny", "PLN", "strict")
    ]
    assert _rows(path, "SELECT module_id, enabled FROM profile_modules ORDER BY module_id") == [
        ("assets", 1), ("budget", 1), ("loans", 1)
    ]
    for table in ("accounts", "category_rules", "import_batches"):
        assert _rows(path, f"SELECT DISTINCT profile_id FROM {table}") == [(1,)], table

    # registry ids: the stored enum NAMES became the lowercase ids
    assert _rows(path, "SELECT bank, type FROM accounts ORDER BY id") == [
        ("mbank", "checking"), ("erste", "savings"), ("manual", "property"),
        ("manual", "mortgage"), ("manual", "vehicle"), ("manual", "cash"),
    ]
    assert _rows(path, "SELECT bank FROM import_batches") == [("mbank",)]
    assert _rows(path, "SELECT updated_at = created_at, payment_iban FROM loans") == [(1, None)]

    assert _rows(path, "PRAGMA foreign_key_check") == []
    assert _rows(path, "PRAGMA integrity_check") == [("ok",)]
    assert _rows(path, "SELECT version_num FROM alembic_version") == [(migrations.head_revision(),)]


def test_migrated_db_serves_the_api_and_takes_a_second_profile(tmp_path, monkeypatch):
    from conftest import make_client

    from cashu.api.app import app

    path = make_upstream_db(tmp_path / "cashu.db")
    engine = db.make_engine(f"sqlite:///{path}")
    monkeypatch.setattr(db, "engine", engine)
    with make_client(app) as client:  # app startup runs init_db -> migrations
        accounts = client.get("/api/accounts").json()
        assert [(a["bank"], a["type"]) for a in accounts][:2] == [("mbank", "checking"), ("erste", "savings")]
        assert client.get("/api/p/default/accounts").json() == accounts
        nw = client.get("/api/p/default/networth").json()
        assert len(nw["accounts"]) == len(UPSTREAM_ROWS["accounts"])
        assert client.get("/api/p/default/cash").json()["balance"] == 300.0
        (profile,) = client.get("/api/profiles").json()
        assert profile["slug"] == "default"
        assert [m["id"] for m in profile["modules"] if m["enabled"]] == ["budget", "assets", "loans"]
        # a second profile can hold the same account number (profile-aware uniques)
        client.post("/api/profiles", json={"name": "Marta", "modules": ["budget"]})
        from cashu.core.accounts import get_or_create_account
        from cashu.core.db import get_session
        from cashu.core.profiles import get_by_slug

        with get_session() as s:
            marta = get_by_slug(s, "marta")
            acc = get_or_create_account(s, bank="mbank", iban="99114000000000000000000001",
                                        profile_id=marta.id)
            assert acc.id != accounts[0]["id"]
        assert len(client.get("/api/p/marta/accounts").json()) == 1
        assert len(client.get("/api/accounts").json()) == len(UPSTREAM_ROWS["accounts"])
    engine.dispose()


def test_modules_enabled_follow_the_data(tmp_path):
    path = tmp_path / "bank-only.db"
    create_upstream_schema(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO accounts (id, bank, name, iban, currency, type, active, created_at) VALUES "
        "(1, 'MBANK', 'Konto Test', '99000000000000000000000001', 'PLN', 'CHECKING', 1, "
        "'2026-01-01 10:00:00')"
    )
    conn.commit()
    conn.close()
    _upgrade(path)
    assert _rows(path, "SELECT module_id FROM profile_modules") == [("budget",)]


def test_empty_upstream_db_gets_no_profile(tmp_path):
    path = tmp_path / "empty.db"
    create_upstream_schema(path)
    _upgrade(path)
    assert _rows(path, "SELECT COUNT(*) FROM profiles") == [(0,)]  # the wizard creates one
    assert not (tmp_path / "backups").exists()  # nothing to protect, no backup


def test_preexisting_orphans_do_not_block_the_upgrade(tmp_path):
    """Upstream never enforced foreign keys: an orphan row that was already there is
    kept (only violations the migration would introduce abort it)."""
    path = make_upstream_db(tmp_path / "orphan.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO balances (account_id, date, amount, currency, source, created_at) "
        "VALUES (99, '2026-01-31', '1.00', 'PLN', 'CSV', '2026-02-01 10:00:00')"
    )
    conn.commit()
    conn.close()
    _upgrade(path)
    assert _rows(path, "SELECT COUNT(*) FROM balances WHERE account_id = 99") == [(1,)]
    assert [r[0] for r in _rows(path, "PRAGMA foreign_key_check")] == ["balances"]


def test_downgrade_restores_the_upstream_shape(tmp_path):
    path = make_upstream_db(tmp_path / "down.db")
    _upgrade(path)
    engine = db.make_engine(f"sqlite:///{path}")
    with migrations.migration_connection(engine) as conn, conn.begin():
        command.downgrade(migrations.alembic_config(conn), migrations.BASELINE)
    engine.dispose()
    ref = tmp_path / "ref.db"
    create_upstream_schema(ref)
    cols = "SELECT name, type, \"notnull\" FROM pragma_table_info('{t}') ORDER BY name"
    for table in migrations.BASELINE_TABLES:
        assert _rows(path, cols.format(t=table)) == _rows(ref, cols.format(t=table)), table
    assert _rows(path, "SELECT bank, type FROM accounts WHERE id = 1") == [("MBANK", "CHECKING")]
    assert legacy.table_counts(path)["transactions"] == len(UPSTREAM_ROWS["transactions"])


def test_downgrade_refuses_to_merge_profiles(tmp_path):
    path = make_upstream_db(tmp_path / "two.db")
    _upgrade(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO profiles (slug, name, base_currency, mcp_privacy, created_at) "
        "VALUES ('marta', 'Marta', 'PLN', 'strict', '2026-10-01 10:00:00')"
    )
    conn.commit()
    conn.close()
    engine = db.make_engine(f"sqlite:///{path}")
    with (
        pytest.raises(RuntimeError, match="more than one profile"),
        migrations.migration_connection(engine) as conn,
        conn.begin(),
    ):
        command.downgrade(migrations.alembic_config(conn), migrations.BASELINE)
    engine.dispose()


def test_migrate_data_moves_a_legacy_db_into_a_profile(tmp_path, monkeypatch):
    from cashu.core import paths

    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    appdata = tmp_path / "appdata" / "cashu"
    monkeypatch.setattr(paths, "LEGACY_DIR", repo / "data")
    monkeypatch.setattr(paths, "default_data_dir", lambda: appdata)
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    make_upstream_db(repo / "data" / paths.LEGACY_DB_FILENAME)

    result = legacy.migrate_legacy_data()

    dst = result.database
    assert _rows(dst, "SELECT slug FROM profiles") == [("default",)]
    assert _rows(dst, "SELECT COUNT(*) FROM accounts WHERE profile_id = 1") == [
        (len(UPSTREAM_ROWS["accounts"]),)
    ]
    assert legacy.table_counts(result.backup)["accounts"] == len(UPSTREAM_ROWS["accounts"])
