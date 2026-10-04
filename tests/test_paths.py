"""Data dir resolution, legacy repo-dir detection and `finanse migrate-data`.

Everything runs in tmp_path: the platform default data dir and the repo's
legacy data/ dir are both redirected, so no real data is ever touched."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
import stat
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner
from upstream_db import make_upstream_db

from finanse import db
from finanse.core import legacy, migrations, paths

FIXED_NOW = dt.datetime(2026, 10, 4, 12, 30, 0, tzinfo=dt.UTC)


@pytest.fixture
def layout(tmp_path, monkeypatch):
    """A fake repo checkout (with data/) and a fake platform data dir."""
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    appdata = tmp_path / "appdata" / "finanse"
    monkeypatch.setattr(paths, "PROJECT_ROOT", repo)
    monkeypatch.setattr(paths, "LEGACY_DIR", repo / "data")
    monkeypatch.setattr(paths, "default_data_dir", lambda: appdata)
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    return repo / "data", appdata


def _make_legacy_db(path: Path, *, wal: bool = False) -> None:
    """A pre-Alembic upstream database with a couple of synthetic rows."""
    make_upstream_db(path, rows=False)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO accounts (id, bank, name, iban, currency, type, active, created_at) "
        "VALUES (1, 'MBANK', 'Konto Test', '99000000000000000000000001', 'PLN', 'CHECKING', 1, "
        "'2026-09-01 10:00:00')"
    )
    conn.execute(
        "INSERT INTO transactions (account_id, booking_date, amount, currency, reference, source, "
        "dedup_hash, occurrence, is_internal_transfer, created_at) "
        "VALUES (1, '2026-09-01', '-12.34', 'PLN', 'SKLEP TEST', 'CSV', 'h1', 0, 0, '2026-09-01')"
    )
    conn.commit()
    conn.close()
    if wal:
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.close()


def _flat(text: str) -> str:
    """Undo rich's line wrapping."""
    return " ".join(text.split())


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------- #
# Data dir
# --------------------------------------------------------------------------- #

def test_data_dir_override(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(tmp_path / "custom"))
    assert paths.data_dir() == (tmp_path / "custom").resolve()
    assert paths.db_path() == (tmp_path / "custom").resolve() / "finanse.db"
    assert paths.token_path().parent == paths.data_dir()


def test_data_dir_override_expands_user(monkeypatch):
    monkeypatch.setenv(paths.DATA_DIR_ENV, "~/finanse-test-dir")
    assert paths.data_dir() == Path.home() / "finanse-test-dir"


def test_default_data_dir_uses_platformdirs_without_author(monkeypatch):
    seen = {}

    def fake_user_data_dir(appname, appauthor=None, roaming=False, **_):
        seen.update(appname=appname, appauthor=appauthor, roaming=roaming)
        return "/somewhere/finanse"

    monkeypatch.setattr(paths, "user_data_dir", fake_user_data_dir)
    assert paths.default_data_dir() == Path("/somewhere/finanse")
    # appauthor=False -> %APPDATA%\finanse (not finanse\finanse); roaming -> %APPDATA%
    assert seen == {"appname": "finanse", "appauthor": False, "roaming": True}


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS location")
def test_default_data_dir_macos():
    assert paths.default_data_dir() == Path.home() / "Library" / "Application Support" / "finanse"


def test_ensure_private_dir_is_owner_only(tmp_path):
    d = paths.ensure_private_dir(tmp_path / "a" / "b")
    assert d.is_dir()
    if sys.platform != "win32":
        assert stat.S_IMODE(d.stat().st_mode) == 0o700


def test_engine_creates_private_db_file_lazily(tmp_path):
    target = tmp_path / "lazy" / "finanse.db"
    engine = db.make_engine(f"sqlite:///{target}")
    assert not target.parent.exists()  # nothing created at engine construction
    with engine.connect():
        pass
    assert target.exists()
    if sys.platform != "win32":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
        assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
    engine.dispose()


# --------------------------------------------------------------------------- #
# Legacy detection
# --------------------------------------------------------------------------- #

def test_fresh_install_uses_data_dir(layout):
    _legacy, appdata = layout
    assert not paths.legacy_mode()
    assert paths.db_path() == appdata / "finanse.db"
    assert paths.eb_sessions_path() == appdata / "eb_sessions.json"
    assert paths.eb_key_path() == appdata / "enablebanking_private.pem"
    assert paths.legacy_notice() is None


def test_legacy_db_keeps_being_used_until_migrated(layout):
    legacy_dir, appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    assert paths.legacy_mode()
    assert paths.db_path() == legacy_dir / "finanse.db"
    assert paths.eb_sessions_path() == legacy_dir / "eb_sessions.json"
    assert db.resolve_database_url() == f"sqlite:///{legacy_dir / 'finanse.db'}"
    notice = paths.legacy_notice()
    assert notice and "finanse migrate-data" in notice and str(appdata) in notice
    # the API token always lives in the data dir (the Vite proxy looks there)
    assert paths.token_path() == appdata / "api-token"


def test_data_dir_override_never_uses_legacy_files(layout, tmp_path, monkeypatch):
    legacy_dir, _appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(tmp_path / "explicit"))
    assert not paths.legacy_mode()
    assert paths.db_path() == (tmp_path / "explicit").resolve() / "finanse.db"
    notice = paths.legacy_notice()
    assert notice and "FINANSE_DATA_DIR" in notice


def test_both_present_without_marker_prefers_data_dir(layout):
    legacy_dir, appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    appdata.mkdir(parents=True)
    _make_legacy_db(appdata / "finanse.db")
    assert not paths.legacy_mode()
    assert paths.db_path() == appdata / "finanse.db"
    assert "--force" in (paths.legacy_notice() or "")


def test_database_url_resolution(layout, tmp_path):
    _legacy, appdata = layout
    custom = tmp_path / "elsewhere.db"
    assert db.resolve_database_url(f"sqlite:///{custom}") == f"sqlite:///{custom}"
    # relative paths keep resolving against the repo root (historical behaviour)
    assert db.resolve_database_url("sqlite:///x/y.db") == f"sqlite:///{paths.PROJECT_ROOT / 'x/y.db'}"
    # the old .env.example default counts as unset -> data dir (or legacy mode)
    assert db.resolve_database_url("sqlite:///data/finanse.db") == f"sqlite:///{appdata / 'finanse.db'}"
    assert db.resolve_database_url(None) == f"sqlite:///{appdata / 'finanse.db'}"
    assert db.resolve_database_url("sqlite://") == "sqlite://"
    assert db.resolve_database_url("postgresql://u@h/db") == "postgresql://u@h/db"


def test_eb_key_file_resolution(layout, tmp_path):
    from finanse.config import Settings

    _legacy, appdata = layout
    assert Settings(_env_file=None).eb_key_file == appdata / "enablebanking_private.pem"
    legacy_default = Settings(_env_file=None, eb_key_path="data/enablebanking_private.pem")
    assert legacy_default.eb_key_file == appdata / "enablebanking_private.pem"
    custom = tmp_path / "keys" / "eb.pem"
    assert Settings(_env_file=None, eb_key_path=str(custom)).eb_key_file == custom


def test_eb_sessions_saved_owner_only(layout):
    from finanse.modules.budget.ingestion.enable_banking import state

    _legacy, appdata = layout
    state.save_session("jan", "mbank", "session-test-1")
    path = appdata / "eb_sessions.json"
    data = json.loads(path.read_text())
    assert data["version"] == 2
    assert [(e["institution"], e["session_id"]) for e in data["profiles"]["jan"]] == [
        ("mbank", "session-test-1")
    ]
    assert [(e.institution, e.session_id) for e in state.load_sessions("jan")] == [
        ("mbank", "session-test-1")
    ]
    assert state.load_sessions("marta") == []
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_eb_sessions_upstream_file_belongs_to_the_migrated_profile(layout):
    from finanse.modules.budget.ingestion.enable_banking import state

    _legacy, appdata = layout
    appdata.mkdir(parents=True)
    (appdata / "eb_sessions.json").write_text(json.dumps({"mbank": "old-1", "erste": "old-2"}))
    assert state.load_sessions("default") == []  # without an owner nobody gets them
    legacy = state.load_sessions("default", legacy_profile="default")
    assert [(e.institution, e.session_id) for e in legacy] == [("mbank", "old-1"), ("erste", "old-2")]
    assert state.load_sessions("marta", legacy_profile="default") == []
    # a re-login replaces the profile's session of that bank and rewrites the file (v2)
    state.save_session("default", "mbank", "new-1", legacy_profile="default")
    kept = state.load_sessions("default")
    assert sorted((e.institution, e.session_id) for e in kept) == [("erste", "old-2"), ("mbank", "new-1")]
    # a second login at the same bank can be kept next to the first
    state.save_session("default", "mbank", "new-2", keep_others=True)
    assert [e.session_id for e in state.load_sessions("default") if e.institution == "mbank"] == [
        "new-1", "new-2"
    ]


# --------------------------------------------------------------------------- #
# migrate-data
# --------------------------------------------------------------------------- #

def test_migrate_copies_db_with_backup_and_switches(layout):
    legacy_dir, appdata = layout
    src = legacy_dir / "finanse.db"
    _make_legacy_db(src)
    (legacy_dir / "eb_sessions.json").write_text('{"mbank": "session-test"}')
    (legacy_dir / "enablebanking_private.pem").write_text("not a real key")
    before = _sha(src)

    result = legacy.migrate_legacy_data(now=FIXED_NOW)

    dst = appdata / "finanse.db"
    assert result.database == dst and dst.exists()
    assert result.backup == appdata / "backups" / "finanse-legacy-20261004-123000.db"
    assert legacy.table_counts(result.backup)["transactions"] == 1
    assert result.tables["accounts"] == 1 and result.tables["transactions"] == 1
    assert _sha(src) == before  # the original is untouched
    # the copy was adopted by Alembic (stamped at the baseline, data kept)
    engine = db.make_engine(f"sqlite:///{dst}")
    assert migrations.current_revision(engine) == migrations.head_revision()
    with engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT reference FROM transactions").scalar() == "SKLEP TEST"
    engine.dispose()
    # aux files copied owner-only, marker written, app switched to the data dir
    assert {p.name for p in result.copied} == {"eb_sessions.json", "enablebanking_private.pem"}
    if sys.platform != "win32":
        for p in [dst, result.backup, *result.copied]:
            assert stat.S_IMODE(p.stat().st_mode) == 0o600
    marker = json.loads((appdata / "legacy-migration.json").read_text())
    assert marker["source"] == str(src)
    assert not paths.legacy_mode()
    assert paths.db_path() == dst
    assert paths.legacy_notice() is None


def test_migrate_includes_uncheckpointed_wal_content(layout):
    legacy_dir, appdata = layout
    src = legacy_dir / "finanse.db"
    _make_legacy_db(src, wal=True)
    live = sqlite3.connect(src)  # a running server: last write still only in -wal
    live.execute("PRAGMA wal_autocheckpoint=0")
    live.execute("UPDATE transactions SET reference='ZMIANA TEST'")
    live.commit()
    assert Path(f"{src}-wal").stat().st_size > 0
    try:
        legacy.migrate_legacy_data(now=FIXED_NOW)
    finally:
        live.close()
    conn = sqlite3.connect(appdata / "finanse.db")
    assert conn.execute("SELECT reference FROM transactions").fetchone()[0] == "ZMIANA TEST"
    conn.close()


def test_migrate_refuses_to_overwrite_without_force(layout):
    legacy_dir, appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    legacy.migrate_legacy_data(now=FIXED_NOW)
    with pytest.raises(legacy.MigrationError, match="--force"):
        legacy.migrate_legacy_data(now=FIXED_NOW)
    later = FIXED_NOW + dt.timedelta(minutes=1)
    result = legacy.migrate_legacy_data(force=True, now=later)
    assert result.replaced_backup == appdata / "backups" / "finanse-replaced-20261004-123100.db"
    assert result.replaced_backup.exists()


def test_migrate_without_legacy_data_fails_cleanly(layout):
    _legacy, appdata = layout
    with pytest.raises(legacy.MigrationError, match="nothing to migrate"):
        legacy.migrate_legacy_data()
    assert not appdata.exists()


def test_cli_migrate_data_and_legacy_notice(layout, monkeypatch, tmp_path):
    from finanse.cli import app

    legacy_dir, appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    engine = db.make_engine(f"sqlite:///{tmp_path / 'cli.db'}")
    monkeypatch.setattr(db, "engine", engine)
    runner = CliRunner()

    before = runner.invoke(app, ["init-db"])
    assert before.exit_code == 0, before.output
    assert "Run `finanse migrate-data`" in _flat(before.stderr)

    migrated = runner.invoke(app, ["migrate-data"])
    assert migrated.exit_code == 0, migrated.output
    assert "Migrated" in migrated.stdout and "Notice" not in migrated.stderr
    assert (appdata / "finanse.db").exists()

    after = runner.invoke(app, ["init-db"])
    assert after.exit_code == 0 and "Notice" not in after.stderr
    again = runner.invoke(app, ["migrate-data"])
    assert again.exit_code == 1 and "--force" in _flat(again.stdout)
    engine.dispose()


# --------------------------------------------------------------------------- #
# R-10: legacy mode upgrades the repo DB in place - backup first, honest notice
# --------------------------------------------------------------------------- #

def _tables(path: Path) -> set[str]:
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


def test_legacy_notice_before_any_upgrade_says_it_will_be_upgraded(layout):
    legacy_dir, appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    notice = _flat(paths.legacy_notice() or "")
    assert "untouched" not in notice
    assert "upgrades it in place" in notice and str(appdata / "backups") in notice


def test_legacy_mode_upgrade_backs_up_into_the_data_dir_first(layout):
    legacy_dir, appdata = layout
    src = legacy_dir / "finanse.db"
    _make_legacy_db(src)
    upstream_tables = _tables(src)
    engine = db.make_engine(db.resolve_database_url(None))
    try:
        migrations.upgrade_to_head(engine)
    finally:
        engine.dispose()
    assert "profiles" in _tables(src)  # upgraded in place (what this version needs)
    (copy,) = (appdata / "backups").glob("finanse-legacy-pre-*.db")
    assert migrations.last_backup == copy
    assert _tables(copy) == upstream_tables  # the pristine upstream shape
    assert legacy.table_counts(copy)["transactions"] == 1
    assert not (legacy_dir / "backups").exists()  # never only inside the repo's data/
    assert paths.legacy_mode()  # a backups/ dir does not end legacy mode
    notice = _flat(paths.legacy_notice() or "")
    assert "untouched" not in notice and "upgraded" in notice and str(copy) in notice
    assert "finanse migrate-data" in notice


def test_migrate_data_after_an_in_place_upgrade_points_at_the_clean_copy(layout):
    legacy_dir, appdata = layout
    src = legacy_dir / "finanse.db"
    _make_legacy_db(src)
    engine = db.make_engine(db.resolve_database_url(None))
    migrations.upgrade_to_head(engine)
    engine.dispose()
    (copy,) = (appdata / "backups").glob("finanse-legacy-pre-*.db")

    result = legacy.migrate_legacy_data(now=FIXED_NOW)
    assert result.upgraded_in_place and result.pre_upgrade_backup == copy

    fresh = legacy_dir.parent / "data2"
    fresh.mkdir()
    _make_legacy_db(fresh / "finanse.db")
    untouched = legacy.migrate_legacy_data(
        legacy_dir=fresh, target_dir=appdata.parent / "other", now=FIXED_NOW
    )
    assert not untouched.upgraded_in_place and untouched.pre_upgrade_backup is None


def test_migrate_data_rescues_a_clean_copy_kept_inside_the_repo(layout):
    """Older builds wrote the pre-upgrade backup to <repo>/data/backups/, which the
    user deletes after migrate-data: it is copied into the data dir first."""
    legacy_dir, appdata = layout
    src = legacy_dir / "finanse.db"
    _make_legacy_db(src)
    old = legacy.backup_sqlite(
        src, legacy_dir / "backups" / "finanse-pre-0004_x-20261001-080000.db"
    )
    old_tables = _tables(old)
    engine = db.make_engine(f"sqlite:///{src}")
    with engine.begin() as conn:  # upgraded in place by an older build (no data-dir copy)
        conn.exec_driver_sql("CREATE TABLE alembic_version (version_num VARCHAR(32))")
    engine.dispose()

    result = legacy.migrate_legacy_data(now=FIXED_NOW)
    assert result.upgraded_in_place
    assert result.pre_upgrade_backup is not None
    assert result.pre_upgrade_backup.parent == appdata / "backups"
    assert _tables(result.pre_upgrade_backup) == old_tables


def test_cli_migrate_data_never_says_untouched_after_an_in_place_upgrade(
    layout, monkeypatch, tmp_path
):
    from rich.console import Console

    from finanse.cli import app
    from finanse.core import cliutil

    legacy_dir, appdata = layout
    _make_legacy_db(legacy_dir / "finanse.db")
    engine = db.make_engine(db.resolve_database_url(None))
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(cliutil, "console", Console(width=1000, color_system=None))
    runner = CliRunner()
    assert runner.invoke(app, ["init-db"]).exit_code == 0  # e.g. `finanse serve` first
    (copy,) = (appdata / "backups").glob("finanse-legacy-pre-*.db")
    out = runner.invoke(app, ["migrate-data"])
    engine.dispose()
    text = _flat(out.stdout)
    assert out.exit_code == 0, out.output
    assert "were not changed" not in text and "upgraded in place" in text
    assert str(copy) in text
