"""F11: moving an install from before the rename into place (core/migrate_legacy.py), the test guard
that keeps every step away from the real home folder, and the legacy-name fallbacks (env, keychain).

Legacy name test module: "finanse" below is the old name the migration looks for. Every directory is
a temp dir; the real install is never touched (the guard tests prove it without even reading it)."""

from __future__ import annotations

import datetime as dt
import os
import plistlib
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import keyring
import pytest

from cashu.core import env as cenv
from cashu.core import locks, migrate_legacy, paths, secrets
from cashu.core.migrate_legacy import DONE, REFUSED, SKIPPED
from cashu.core.worker import scheduler

NOW = dt.datetime(2026, 10, 6, 12, 0, tzinfo=dt.UTC)
REAL_HOME = Path(__import__("pwd").getpwuid(os.getuid()).pw_dir).resolve()  # never read, only compared


def _make_db(path: Path, *, wal: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    if wal:
        conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.execute("INSERT INTO t VALUES (42)")
    conn.commit()
    conn.close()


def _rows(path: Path) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT x FROM t").fetchall()
    finally:
        conn.close()


class FakeRunner:
    def __init__(self):
        self.calls: list[list[str]] = []

    def __call__(self, argv):
        self.calls.append(list(argv))
        from cashu.core.worker.notifier import CommandResult

        return CommandResult(0, "", "")


@pytest.fixture
def defaults(tmp_path, monkeypatch):
    """Platform defaults in temp dirs: (old pre-rename dir, new dir); no data dir override."""
    old = tmp_path / "AppSupport" / "finanse"
    new = tmp_path / "AppSupport" / "cashU"
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    monkeypatch.setenv(paths.LEGACY_DATA_DIR_ENV, str(old))
    monkeypatch.setattr(paths, "default_data_dir", lambda: new)
    return old, new


def _by_step(results) -> dict[str, migrate_legacy.StepResult]:
    return {r.step: r for r in results}


# --------------------------------------------------------------------------- #
# The test guard: a no-op on the real default paths under pytest
# --------------------------------------------------------------------------- #


def _forbid_file_changes(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("the migration tried to change a file")

    for target, name in ((os, "rename"), (os, "replace"), (Path, "write_text"), (Path, "unlink")):
        monkeypatch.setattr(target, name, boom)
    import shutil

    monkeypatch.setattr(shutil, "copytree", boom)


def test_pytest_sets_the_guard_and_isolates_home():
    assert REAL_HOME in migrate_legacy._REAL_HOMES
    assert os.environ["CASHU_TESTING"] == "1"
    assert migrate_legacy.testing()
    assert Path(os.path.expanduser("~")).resolve() != REAL_HOME
    assert not any(k.startswith("FINANSE_") for k in os.environ)  # legacy name


def test_migration_is_a_noop_on_the_real_default_paths(monkeypatch):
    """Even pointed straight at the real platform defaults (no override, real home), every step that
    could act refuses before looking at the files, and no state is recorded there."""
    real_old = REAL_HOME / "Library" / "Application Support" / "finanse"
    real_new = REAL_HOME / "Library" / "Application Support" / "cashU"
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    monkeypatch.setattr(paths, "legacy_default_data_dir", lambda: real_old)
    monkeypatch.setattr(paths, "default_data_dir", lambda: real_new)
    runner = FakeRunner()
    _forbid_file_changes(monkeypatch)
    results = _by_step(
        migrate_legacy.run(
            now=NOW, force=True, agents_dir=REAL_HOME / "Library" / "LaunchAgents", runner=runner
        )
    )
    assert results["data_dir"].status == REFUSED and "test guard" in results["data_dir"].detail
    assert results["db_file"].status == REFUSED and "test guard" in results["db_file"].detail
    assert "launchd" not in results  # never reached after a refused data dir step
    assert runner.calls == []


def test_each_step_refuses_paths_under_the_real_home(tmp_path):
    runner = FakeRunner()
    home_dir = REAL_HOME / "Library" / "Application Support"
    with pytest.raises(migrate_legacy._Refused, match="test guard"):
        migrate_legacy.migrate_data_dir(old=home_dir / "finanse", new=tmp_path / "x", now=NOW)
    with pytest.raises(migrate_legacy._Refused, match="test guard"):
        migrate_legacy.migrate_data_dir(old=tmp_path / "finanse", new=home_dir / "cashU", now=NOW)
    with pytest.raises(migrate_legacy._Refused, match="test guard"):
        migrate_legacy.migrate_db_file(home_dir / "cashU")
    with pytest.raises(migrate_legacy._Refused, match="test guard"):
        migrate_legacy.migrate_launchd(
            folder=tmp_path, old_default=tmp_path, agents_dir=REAL_HOME / "Library" / "LaunchAgents",
            runner=runner,
        )
    assert runner.calls == []


def test_the_guard_is_off_outside_tests(tmp_path, monkeypatch):
    monkeypatch.delenv("CASHU_TESTING")
    assert not migrate_legacy.testing()
    migrate_legacy._guard(REAL_HOME / "anything")  # no exception: production behaviour


# --------------------------------------------------------------------------- #
# Step 1-2: data dir and DB file
# --------------------------------------------------------------------------- #


def test_old_default_dir_is_moved_and_its_db_renamed(defaults):
    old, new = defaults
    _make_db(old / "finanse.db", wal=True)
    (old / "profiles" / "jan").mkdir(parents=True)
    (old / "profiles" / "jan" / "strategy.yaml").write_text("x: 1\n")
    results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert results["data_dir"].status == DONE
    assert not old.exists() and (new / "cashu.db").exists()
    assert not (new / "finanse.db").exists()
    assert _rows(new / "cashu.db") == [(42,)]
    assert (new / "profiles" / "jan" / "strategy.yaml").read_text() == "x: 1\n"
    note = (new / migrate_legacy.MIGRATED_FROM).read_text()
    assert str(old) in note and "cashu.db" in note
    state = migrate_legacy.read_state(new)
    assert state["steps"]["data_dir"]["status"] == DONE
    # idempotent: a second start changes nothing
    again = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert again["data_dir"].status == SKIPPED and again["db_file"].status == SKIPPED


def test_nothing_happens_when_the_new_dir_exists(defaults):
    old, new = defaults
    _make_db(old / "finanse.db")
    _make_db(new / "cashu.db")
    results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert results["data_dir"].status == SKIPPED
    assert (old / "finanse.db").exists()


def test_a_held_run_lock_refuses_the_move(defaults, monkeypatch):
    old, new = defaults
    _make_db(old / "finanse.db")
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(old))  # take the lock inside the old dir
    with locks.run_lock("desktop"):
        monkeypatch.delenv(paths.DATA_DIR_ENV)
        results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert results["data_dir"].status == REFUSED and "desktop is running" in results["data_dir"].detail
    assert (old / "finanse.db").exists() and not new.exists()
    assert "launchd" not in results


def test_a_database_open_in_another_process_refuses_the_move(defaults):
    old, new = defaults
    _make_db(old / "finanse.db", wal=True)
    holder = subprocess.Popen(
        [
            sys.executable, "-c",
            (
                "import sqlite3, sys, time; c = sqlite3.connect(sys.argv[1]);"
                " c.execute('PRAGMA journal_mode=WAL'); c.execute('SELECT * FROM t').fetchall();"
                " print('ready', flush=True); time.sleep(30)"
            ),
            str(old / "finanse.db"),
        ],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "ready"
        results = _by_step(migrate_legacy.run(now=NOW, force=True))
    finally:
        holder.kill()
        holder.wait()
    assert results["data_dir"].status == REFUSED and "open in another process" in results["data_dir"].detail
    assert (old / "finanse.db").exists() and not new.exists()
    assert migrate_legacy.problems(new) == []  # nothing recorded in a dir that does not exist
    # after the other process is gone the next start moves it
    time.sleep(0.1)
    assert _by_step(migrate_legacy.run(now=NOW, force=True))["data_dir"].status == DONE


def test_another_volume_copies_verifies_and_keeps_the_old_dir(defaults, monkeypatch):
    old, new = defaults
    _make_db(old / "finanse.db")
    monkeypatch.setattr(migrate_legacy, "_same_volume", lambda a, b: False)
    results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert results["data_dir"].status == DONE and "kept" in results["data_dir"].detail
    kept = old.with_name("finanse.migrated-20261006-120000")
    assert kept.is_dir() and (kept / "finanse.db").exists() and not old.exists()
    assert _rows(new / "cashu.db") == [(42,)]


def test_an_explicit_data_dir_only_gets_the_db_file_renamed(defaults, tmp_path, monkeypatch):
    old, _new = defaults
    _make_db(old / "finanse.db")
    custom = tmp_path / "custom"
    _make_db(custom / "finanse.db", wal=True)
    monkeypatch.setenv(paths.LEGACY_DATA_DIR_ENV, str(old))
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(custom))
    results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert "data_dir" not in results
    assert results["db_file"].status == DONE
    assert (custom / "cashu.db").exists() and not (custom / "finanse.db").exists()
    assert (old / "finanse.db").exists()  # the platform default is never moved with an override


def test_the_legacy_data_dir_variable_still_selects_the_dir(tmp_path, monkeypatch):
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    monkeypatch.setenv("FINANSE_DATA_DIR", str(tmp_path / "legacy-env"))  # legacy name
    assert paths.data_dir() == (tmp_path / "legacy-env").resolve()
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(tmp_path / "new-env"))
    assert paths.data_dir() == (tmp_path / "new-env").resolve()


def test_a_failing_step_is_recorded_and_never_raised(defaults, monkeypatch):
    _old, new = defaults
    _make_db(new / "cashu.db")

    def broken(_folder):
        raise OSError("disk on fire")

    monkeypatch.setattr(migrate_legacy, "migrate_db_file", broken)
    results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert results["db_file"].status == "failed" and "disk on fire" in results["db_file"].detail
    assert migrate_legacy.problems(new)[0]["step"] == "db_file"


def test_system_reports_the_problems(defaults, monkeypatch):
    from fastapi.testclient import TestClient

    from cashu.api.app import app
    from cashu.core import security

    _old, new = defaults
    new.mkdir(parents=True)
    (new / migrate_legacy.STATE_FILE).write_text(
        '{"steps": {"data_dir": {"step": "data_dir", "status": "refused", "detail": "x"}}}'
    )
    cfg = security.configure()
    client = TestClient(app, base_url="http://127.0.0.1:8500")
    body = client.get("/api/system", headers={"X-Cashu-Token": cfg.token}).json()
    assert body["rename_migration"] == [{"step": "data_dir", "status": "refused", "detail": "x"}]


# --------------------------------------------------------------------------- #
# Step 3: keychain
# --------------------------------------------------------------------------- #


def test_keychain_entries_move_to_the_new_service(defaults):
    ring = keyring.get_keyring()
    ring.set_password(secrets.LEGACY_SERVICE, secrets.ANTHROPIC, "sk-legacy-0000000000000000")
    _old, new = defaults
    new.mkdir(parents=True)
    results = _by_step(migrate_legacy.run(now=NOW, force=True))
    assert results["keychain"].status == DONE
    assert ring.get_password(secrets.SERVICE, secrets.ANTHROPIC) == "sk-legacy-0000000000000000"
    assert ring.get_password(secrets.LEGACY_SERVICE, secrets.ANTHROPIC) is None
    # checked once per install: the next start does not read the keychain again
    assert "keychain" not in _by_step(migrate_legacy.run(now=NOW, force=True))


def test_get_secret_adopts_legacy_entries_lazily_and_delete_removes_both():
    ring = keyring.get_keyring()
    name = secrets.connector_secret_name("bank-x", "jan", 1, "api_key")
    ring.set_password(secrets.LEGACY_SERVICE, name, "legacy-connector-secret")
    assert secrets.get_connector_secret(name) == "legacy-connector-secret"
    assert ring.get_password(secrets.SERVICE, name) == "legacy-connector-secret"
    assert ring.get_password(secrets.LEGACY_SERVICE, name) is None
    ring.set_password(secrets.LEGACY_SERVICE, secrets.ANTHROPIC, "sk-old-0000000000000000000")
    assert secrets.delete_secret(secrets.ANTHROPIC) is True
    assert secrets.get_secret(secrets.ANTHROPIC) is None  # not resurrected from the old service


# --------------------------------------------------------------------------- #
# Step 4: launchd
# --------------------------------------------------------------------------- #


def _old_plist(agents: Path, workdir: Path, env: dict | None = None) -> Path:
    agents.mkdir(parents=True, exist_ok=True)
    path = agents / f"{scheduler.LEGACY_LABEL}.plist"
    path.write_bytes(plistlib.dumps({
        "Label": scheduler.LEGACY_LABEL,
        "ProgramArguments": ["/Applications/cashU.app/Contents/MacOS/finanse", "worker", "run"],
        "StartCalendarInterval": {"Hour": 6, "Minute": 15},
        "WorkingDirectory": str(workdir),
        "EnvironmentVariables": env or {"PATH": "/usr/bin"},
    }))
    return path


def test_an_old_worker_agent_is_reinstalled_under_the_new_label(defaults, tmp_path, monkeypatch):
    old, new = defaults
    _make_db(old / "finanse.db")
    agents = tmp_path / "LaunchAgents"
    old_plist = _old_plist(agents, old)
    monkeypatch.setattr(scheduler, "entry_point", lambda program=None: ["/venv/bin/cashu"])
    runner = FakeRunner()
    results = _by_step(migrate_legacy.run(now=NOW, force=True, agents_dir=agents, runner=runner))
    assert results["launchd"].status == DONE
    assert not old_plist.exists()
    new_plist = agents / f"{scheduler.DEFAULT_LABEL}.plist"
    data = plistlib.loads(new_plist.read_bytes())
    assert data["ProgramArguments"] == ["/venv/bin/cashu", "worker", "run"]
    assert data["StartCalendarInterval"] == {"Hour": 6, "Minute": 15}
    assert data["WorkingDirectory"] == str(new)
    flat = [" ".join(c) for c in runner.calls]
    assert any("bootout" in c and scheduler.LEGACY_LABEL in c for c in flat)
    assert any("bootstrap" in c and scheduler.DEFAULT_LABEL in c for c in flat)


def test_an_agent_of_another_data_dir_is_left_alone(defaults, tmp_path):
    _old, new = defaults
    new.mkdir(parents=True)
    agents = tmp_path / "LaunchAgents"
    old_plist = _old_plist(agents, tmp_path / "elsewhere")
    runner = FakeRunner()
    results = _by_step(migrate_legacy.run(now=NOW, force=True, agents_dir=agents, runner=runner))
    assert results["launchd"].status == SKIPPED and old_plist.exists() and runner.calls == []


def test_the_worker_itself_never_unloads_its_job(defaults, tmp_path):
    old, _new = defaults
    agents = tmp_path / "LaunchAgents"
    old_plist = _old_plist(agents, old)
    runner = FakeRunner()
    results = _by_step(
        migrate_legacy.run(now=NOW, force=True, agents_dir=agents, runner=runner, launchd=False)
    )
    assert "launchd" not in results and old_plist.exists() and runner.calls == []


# --------------------------------------------------------------------------- #
# Environment fallback and the legacy console script
# --------------------------------------------------------------------------- #


def test_env_reads_the_new_name_then_the_legacy_one(monkeypatch):
    monkeypatch.delenv("CASHU_X_TEST", raising=False)
    monkeypatch.setenv("FINANSE_X_TEST", "old")  # legacy name
    assert cenv.env("X_TEST") == "old"
    assert cenv.env("CASHU_X_TEST") == "old"
    monkeypatch.setenv("CASHU_X_TEST", "")
    assert cenv.env("X_TEST") == ""  # an empty new variable wins
    assert cenv.names("PORT") == ["CASHU_PORT", "FINANSE_PORT"]
    assert cenv.env("X_TEST", environ={"FINANSE_X_TEST": "m"}) == "m"


def test_settings_fall_back_to_legacy_variables(monkeypatch):
    from cashu.config import Settings

    monkeypatch.delenv("CASHU_PORT", raising=False)
    monkeypatch.setenv("FINANSE_PORT", "9123")  # legacy name
    assert Settings(_env_file=None).port == 9123
    monkeypatch.setenv("CASHU_PORT", "9200")
    assert Settings(_env_file=None).port == 9200


def test_the_legacy_console_script_warns_and_runs_the_cli(capsys, monkeypatch):
    from cashu import cli

    monkeypatch.setattr(sys, "argv", ["finanse", "--help"])  # legacy name
    with pytest.raises(SystemExit) as exit_info:
        cli.legacy_main()
    assert exit_info.value.code == 0
    out = capsys.readouterr()
    assert "deprecated" in out.err and "cashu" in out.err
    assert "Usage" in out.out
