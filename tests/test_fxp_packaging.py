"""Packaged-app paths (F7 FXP): MCP snippets on a translocated app (PK3), setup-page commands with
the bundled binary (PK10), a moved / renamed app flagged for the worker and the MCP configs (PK11).
No real app bundle, no launchctl, no network."""

from __future__ import annotations

import json
import plistlib
import shlex
import sys

import pytest
from typer.testing import CliRunner

from finanse.core import paths, runtime
from finanse.core.worker import scheduler as sched
from finanse.core.worker import service

APP_EXE = "/Applications/Finanse.app/Contents/MacOS/finanse"
MOVED_EXE = "/private/var/folders/x/T/AppTranslocation/ABC/d/Finanse.app/Contents/MacOS/finanse"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("FINANSE_DATA_DIR", str(path))
    return path


@pytest.fixture
def frozen(monkeypatch, tmp_path):
    meipass = tmp_path / "bundle"
    meipass.mkdir()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", APP_EXE)
    monkeypatch.setattr(sys, "_MEIPASS", str(meipass), raising=False)
    return meipass


def _profile(api, modules=("investments", "budget")) -> str:
    created = api.post(
        "/api/profiles",
        json={"name": "Test", "base_currency": "PLN", "modules": list(modules), "mcp_privacy": "strict"},
    )
    assert created.status_code in (200, 201), created.text
    return created.json()["slug"]


# --------------------------------------------------------------------------- #
# PK3: no App Translocation path in any MCP snippet
# --------------------------------------------------------------------------- #


def test_translocated_app_hands_out_no_mcp_path(frozen, monkeypatch):
    monkeypatch.setattr(sys, "executable", MOVED_EXE)
    assert runtime.translocated()
    for line in (runtime.mcp_command("jan"), runtime.claude_mcp_add("jan")):
        assert line == runtime.TRANSLOCATED_SNIPPET and line.startswith("# ")
        assert "AppTranslocation" not in line
        assert shlex.split(line, comments=True) == []  # a pasted line runs nothing
    entry = runtime.claude_desktop_config("jan")["mcpServers"]["finanse-jan"]
    assert entry["command"] == "" and "AppTranslocation" not in json.dumps(entry)
    assert entry["error"] and entry["args"] == ["mcp", "--profile", "jan"]
    assert chr(0x2014) not in runtime.TRANSLOCATED_SNIPPET  # no em dash


def test_translocated_mcp_endpoint_and_module_setup(api_empty, frozen, monkeypatch):
    slug = _profile(api_empty)
    monkeypatch.setattr(sys, "executable", MOVED_EXE)
    info = api_empty.get(f"/api/p/{slug}/mcp").json()
    assert "AppTranslocation" not in json.dumps(info)
    assert info["claude_mcp_add"] == runtime.TRANSLOCATED_SNIPPET
    setup = api_empty.get(f"/api/p/{slug}/modules/investments/setup").json()
    assert setup["skill"]["mcp_add"] == runtime.TRANSLOCATED_SNIPPET
    # Back in /Applications: the real lines again.
    monkeypatch.setattr(sys, "executable", APP_EXE)
    info = api_empty.get(f"/api/p/{slug}/mcp").json()
    assert info["claude_mcp_add"] == f"claude mcp add finanse-{slug} -- {APP_EXE} mcp --profile {slug}"


# --------------------------------------------------------------------------- #
# PK10: setup-page commands run the bundled binary
# --------------------------------------------------------------------------- #


def _cli_targets(setup: dict) -> list[str]:
    return [a["target"] for step in setup["steps"] for a in step.get("actions", []) if a["kind"] == "cli"]


def test_setup_commands_use_the_bundled_binary_when_packaged(api_empty, frozen, monkeypatch):
    slug = _profile(api_empty, ("budget", "investments", "loans", "assets"))
    seen = []
    for module in ("budget", "investments", "loans", "assets"):
        r = api_empty.get(f"/api/p/{slug}/modules/{module}/setup")
        if r.status_code != 200:
            continue
        targets = _cli_targets(r.json())
        seen += targets
        for cmd in targets:
            assert cmd.startswith(f"{APP_EXE} --profile {slug} "), cmd
    assert seen, "no module offered a copyable command"
    # A path with spaces stays one shell word.
    spaced = "/Users/x/My Apps/Finanse.app/Contents/MacOS/finanse"
    monkeypatch.setattr(sys, "executable", spaced)
    targets = _cli_targets(api_empty.get(f"/api/p/{slug}/modules/budget/setup").json())
    assert targets and all(shlex.split(t)[0] == spaced for t in targets)


def test_setup_commands_from_source_keep_the_plain_command(api_empty):
    slug = _profile(api_empty, ("budget",))
    targets = _cli_targets(api_empty.get(f"/api/p/{slug}/modules/budget/setup").json())
    assert targets and all(t.startswith(f"finanse --profile {slug} ") for t in targets)


# --------------------------------------------------------------------------- #
# PK11: a moved / renamed app is detected, nothing is rewritten silently
# --------------------------------------------------------------------------- #


def test_app_location_records_a_move(data_dir, frozen, monkeypatch):
    assert runtime.note_app_location() is None  # first launch: nothing to compare with
    assert runtime.app_moved_from() is None
    path = runtime.app_location_path()
    assert json.loads(path.read_text())["bundle"] == "/Applications/Finanse.app"
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert runtime.note_app_location() is None  # same place again
    moved = "/Applications/Finanse 2.app/Contents/MacOS/finanse"  # Finder's rename on reinstall
    monkeypatch.setattr(sys, "executable", moved)
    assert runtime.note_app_location() == "/Applications/Finanse.app"
    assert runtime.app_moved_from() == "/Applications/Finanse.app"
    assert runtime.note_app_location() == "/Applications/Finanse.app"  # kept until fixed
    runtime.clear_app_move()
    assert runtime.app_moved_from() is None
    # A translocated launch is never recorded (random path).
    monkeypatch.setattr(sys, "executable", MOVED_EXE)
    assert runtime.note_app_location() is None
    assert json.loads(path.read_text())["bundle"] == "/Applications/Finanse 2.app"


def test_app_location_is_not_recorded_from_source(data_dir):
    assert runtime.note_app_location() is None
    assert not runtime.app_location_path().exists()


@pytest.fixture
def launchd(tmp_path, monkeypatch):
    from test_worker_scheduler import FakeLaunchctl

    scheduler = sched.LaunchdScheduler(agents_dir=tmp_path / "agents", runner=FakeLaunchctl(), uid=501)
    monkeypatch.setattr(service, "get_scheduler", lambda: scheduler)
    return scheduler


def _install_plist(scheduler, program: str) -> None:
    scheduler.agents_dir.mkdir(parents=True, exist_ok=True)
    scheduler.plist_path.write_bytes(scheduler.render(sched.Schedule(7, 30), [program]))


def test_worker_status_flags_a_missing_program(db_engine, data_dir, launchd, frozen):
    _install_plist(launchd, "/Users/x/Downloads/Finanse.app/Contents/MacOS/finanse")
    rel = service.status()["relocation"]
    assert rel == {
        "worker": "missing",
        "expected_program": [APP_EXE],
        "app_moved_from": None,
        "actions": ["worker_reinstall"],
    }


def test_worker_status_flags_another_install(db_engine, data_dir, launchd, frozen, tmp_path):
    venv = tmp_path / "venv" / "bin" / "finanse"
    venv.parent.mkdir(parents=True)
    venv.write_text("#!/bin/sh\n")
    _install_plist(launchd, str(venv))  # the dev venv took the shared label
    rel = service.status()["relocation"]
    assert rel["worker"] == "other_program" and rel["expected_program"] == [APP_EXE]


def test_worker_status_is_clean_when_the_job_matches(db_engine, data_dir, launchd, monkeypatch, tmp_path):
    exe = tmp_path / "Finanse.app" / "Contents" / "MacOS" / "finanse"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    _install_plist(launchd, str(exe))
    assert service.status()["relocation"] is None


def test_moved_app_flags_mcp_and_reinstall_clears_it(db_engine, data_dir, launchd, frozen, monkeypatch, tmp_path):
    runtime.note_app_location()  # launched from /Applications/Finanse.app
    exe = tmp_path / "Apps" / "Finanse.app" / "Contents" / "MacOS" / "finanse"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(sys, "executable", str(exe))
    runtime.note_app_location()  # ... and now from somewhere else
    rel = service.status()["relocation"]
    assert rel["app_moved_from"] == "/Applications/Finanse.app" and rel["worker"] is None
    assert rel["actions"] == ["mcp_readd"]
    out = CliRunner().invoke(_cli(), ["worker", "status"])
    assert out.exit_code == 0, out.output
    assert "moved from /Applications/Finanse.app" in out.output and "Settings > Agent AI" in out.output
    service.install()  # the fix action
    assert service.status()["relocation"] is None
    assert plistlib.loads(launchd.plist_path.read_bytes())["ProgramArguments"][0] == str(exe)


def test_worker_status_cli_prints_the_fix(db_engine, data_dir, launchd, frozen):
    _install_plist(launchd, "/Users/x/Downloads/Finanse.app/Contents/MacOS/finanse")
    out = CliRunner().invoke(_cli(), ["worker", "status"])
    assert out.exit_code == 0, out.output
    assert "no longer exists" in out.output and "finanse worker install" in out.output
    assert APP_EXE in out.output


def _cli():
    from finanse.cli import app

    return app


def test_paths_module_is_untouched_by_runtime_state(data_dir):
    """The app-location file lives in the data dir, owner-only, like desktop.json."""
    assert runtime.app_location_path().parent == paths.data_dir()
