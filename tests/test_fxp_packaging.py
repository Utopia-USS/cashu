"""Packaged-app paths (F7 FXP): MCP snippets on a translocated app (PK3), setup-page commands with
the bundled binary (PK10), a moved / renamed app flagged for the worker and the MCP configs (PK11),
and static checks of the signing inputs (PK4) and the build's dependency pinning (PK13).
No real app bundle, no launchctl, no network."""

from __future__ import annotations

import json
import plistlib
import re
import shlex
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from cashu.core import paths, runtime
from cashu.core.worker import scheduler as sched
from cashu.core.worker import service

ROOT = Path(__file__).resolve().parents[1]
APP_EXE = "/Applications/cashU.app/Contents/MacOS/cashu"
MOVED_EXE = "/private/var/folders/x/T/AppTranslocation/ABC/d/cashU.app/Contents/MacOS/cashu"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("CASHU_DATA_DIR", str(path))
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
    entry = runtime.claude_desktop_config("jan")["mcpServers"]["cashu-jan"]
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
    assert info["claude_mcp_add"] == f"claude mcp add cashu-{slug} -- {APP_EXE} mcp --profile {slug}"


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
    spaced = "/Users/x/My Apps/cashU.app/Contents/MacOS/cashu"
    monkeypatch.setattr(sys, "executable", spaced)
    targets = _cli_targets(api_empty.get(f"/api/p/{slug}/modules/budget/setup").json())
    assert targets and all(shlex.split(t)[0] == spaced for t in targets)


def test_setup_commands_from_source_keep_the_plain_command(api_empty):
    slug = _profile(api_empty, ("budget",))
    targets = _cli_targets(api_empty.get(f"/api/p/{slug}/modules/budget/setup").json())
    assert targets and all(t.startswith(f"cashu --profile {slug} ") for t in targets)


# --------------------------------------------------------------------------- #
# PK11: a moved / renamed app is detected, nothing is rewritten silently
# --------------------------------------------------------------------------- #


def test_app_location_records_a_move(data_dir, frozen, monkeypatch):
    assert runtime.note_app_location() is None  # first launch: nothing to compare with
    assert runtime.app_moved_from() is None
    path = runtime.app_location_path()
    assert json.loads(path.read_text())["bundle"] == "/Applications/cashU.app"
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert runtime.note_app_location() is None  # same place again
    moved = "/Applications/cashU 2.app/Contents/MacOS/cashu"  # Finder's rename on reinstall
    monkeypatch.setattr(sys, "executable", moved)
    assert runtime.note_app_location() == "/Applications/cashU.app"
    assert runtime.app_moved_from() == "/Applications/cashU.app"
    assert runtime.note_app_location() == "/Applications/cashU.app"  # kept until fixed
    runtime.clear_app_move()
    assert runtime.app_moved_from() is None
    # A translocated launch is never recorded (random path).
    monkeypatch.setattr(sys, "executable", MOVED_EXE)
    assert runtime.note_app_location() is None
    assert json.loads(path.read_text())["bundle"] == "/Applications/cashU 2.app"


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
    _install_plist(launchd, "/Users/x/Downloads/cashU.app/Contents/MacOS/cashu")
    rel = service.status()["relocation"]
    assert rel == {
        "worker": {
            "reason": "missing",
            "program": "/Users/x/Downloads/cashU.app/Contents/MacOS/cashu",
            "expected_program": [APP_EXE],
            "actions": ["worker_reinstall"],
        },
        "mcp": None,
    }


def test_worker_status_flags_another_install(db_engine, data_dir, launchd, frozen, tmp_path):
    venv = tmp_path / "venv" / "bin" / "cashu"
    venv.parent.mkdir(parents=True)
    venv.write_text("#!/bin/sh\n")
    _install_plist(launchd, str(venv))  # the dev venv took the shared label
    rel = service.status()["relocation"]
    assert rel["worker"]["reason"] == "other_program"
    assert rel["worker"]["expected_program"] == [APP_EXE] and rel["mcp"] is None


def test_worker_status_is_clean_when_the_job_matches(db_engine, data_dir, launchd, monkeypatch, tmp_path):
    exe = tmp_path / "cashU.app" / "Contents" / "MacOS" / "cashu"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    _install_plist(launchd, str(exe))
    assert service.status()["relocation"] == {"worker": None, "mcp": None}


def _moved_app(monkeypatch, tmp_path) -> Path:
    runtime.note_app_location()  # launched from /Applications/cashU.app
    exe = tmp_path / "Apps" / "cashU.app" / "Contents" / "MacOS" / "cashu"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(sys, "executable", str(exe))
    runtime.note_app_location()  # ... and now from somewhere else
    return exe


def test_moved_app_without_any_mcp_line_raises_nothing(db_engine, data_dir, launchd, frozen, monkeypatch, tmp_path):
    """F7 review R8: no workspace and `cashu mcp` never started: no MCP client can hold the old
    path, so a move alone is no relocation notice."""
    _moved_app(monkeypatch, tmp_path)
    assert service.status()["relocation"] == {"worker": None, "mcp": None}


def test_moved_app_mcp_part_survives_a_worker_reinstall_until_acked(db_engine, data_dir, launchd, frozen, monkeypatch, tmp_path):
    """F7 review R8: the worker and MCP parts are cleared separately: re-installing the worker (the
    obvious button) no longer hides the MCP hint; only the ack (or a workspace rewrite) does."""
    old_exe = "/Applications/cashU.app/Contents/MacOS/cashu"
    runtime.note_mcp_started()  # an agent client ran the MCP server from the old path
    _install_plist(launchd, old_exe)
    exe = _moved_app(monkeypatch, tmp_path)
    rel = service.status()["relocation"]
    assert rel["worker"]["reason"] == "missing" and rel["worker"]["program"] == old_exe
    assert rel["mcp"]["reason"] == "app_moved" and rel["mcp"]["actions"] == ["mcp_readd"]
    assert rel["mcp"]["app_moved_from"] == "/Applications/cashU.app" and rel["mcp"]["moved_at"]
    out = CliRunner().invoke(_cli(), ["worker", "status"])
    assert out.exit_code == 0, out.output
    assert "moved from /Applications/cashU.app" in out.output and "Settings > Agent AI" in out.output
    service.install()  # the worker fix action
    assert plistlib.loads(launchd.plist_path.read_bytes())["ProgramArguments"][0] == str(exe)
    rel = service.status()["relocation"]
    assert rel["worker"] is None and rel["mcp"] is not None
    service.acknowledge_mcp_relocation()  # "Gotowe" in Settings
    assert service.status()["relocation"] == {"worker": None, "mcp": None}


def test_relocation_ack_route_and_workspace_rewrite_clear_the_mcp_part(api_empty, data_dir, launchd, frozen, monkeypatch, tmp_path):
    r = api_empty.post("/api/profiles", json={"name": "Ola Test", "modules": ["budget"]})
    assert r.status_code == 201, r.text
    slug = "ola-test"
    old = tmp_path / "Old" / "cashU.app" / "Contents" / "MacOS" / "cashu"
    old.parent.mkdir(parents=True)
    old.write_text("")
    monkeypatch.setattr(sys, "executable", str(old))
    runtime.note_app_location()
    assert api_empty.post(f"/api/p/{slug}/workspace", json={}).status_code == 200
    _moved_app(monkeypatch, tmp_path)
    # a workspace exists: its .mcp.json may still name the old path
    rel = api_empty.get("/api/system").json()["worker"]["relocation"]
    assert rel["mcp"]["app_moved_from"] == str(old.parents[2])
    status = api_empty.get(f"/api/p/{slug}/workspace").json()
    assert status["mcp_command_stale"] is True
    # "Aktualizuj workspace" rewrites .mcp.json with the new path: the mcp part is gone
    updated = api_empty.post(f"/api/p/{slug}/workspace", json={}).json()
    assert updated["mcp_command_stale"] is False
    assert api_empty.get("/api/system").json()["worker"]["relocation"]["mcp"] is None
    # the explicit ack route
    _moved_app_again = tmp_path / "Third" / "cashU.app" / "Contents" / "MacOS" / "cashu"
    _moved_app_again.parent.mkdir(parents=True)
    _moved_app_again.write_text("")
    monkeypatch.setattr(sys, "executable", str(_moved_app_again))
    runtime.note_app_location()
    assert api_empty.get("/api/system").json()["worker"]["relocation"]["mcp"] is not None
    r = api_empty.post("/api/system/relocation/ack")
    assert r.status_code == 200, r.text
    assert r.json()["worker"]["relocation"]["mcp"] is None


def test_worker_status_cli_prints_the_fix(db_engine, data_dir, launchd, frozen):
    _install_plist(launchd, "/Users/x/Downloads/cashU.app/Contents/MacOS/cashu")
    out = CliRunner().invoke(_cli(), ["worker", "status"])
    assert out.exit_code == 0, out.output
    assert "no longer exists" in out.output and "cashu worker install" in out.output
    assert APP_EXE in out.output


def _cli():
    from cashu.cli import app

    return app


# --------------------------------------------------------------------------- #
# PK4: entitlements; PK13: hash-pinned build dependencies, pinned pip
# --------------------------------------------------------------------------- #


def test_entitlements_are_the_documented_minimum():
    ent = plistlib.loads((ROOT / "packaging" / "entitlements.plist").read_bytes())
    assert ent == {}  # no hardened-runtime exception is shown to be needed (packaging/README.md)
    forbidden = (
        "com.apple.security.cs.disable-library-validation",
        "com.apple.security.cs.allow-dyld-environment-variables",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.get-task-allow",
    )
    text = (ROOT / "packaging" / "entitlements.plist").read_text()
    for key in forbidden:
        assert f"<key>{key}</key>" not in text


def test_build_script_hygiene():
    script = (ROOT / "scripts" / "build_macos.sh").read_text()
    assert "set -euo pipefail" in script and not re.search(r"^\s*set -x", script, re.MULTILINE)
    assert "--upgrade pip\n" not in script and not re.search(r"install[^\n]*--upgrade pip(\s|$)", script)
    pinned = re.search(r'^PIP_VERSION="(\d+\.\d+(?:\.\d+)?)"$', script, re.MULTILINE)  # pinned pip
    assert pinned
    lock = (ROOT / "packaging" / "requirements-build.lock").read_text()
    assert f"\npip=={pinned.group(1)} \\\n" in lock  # ... and hashed in the lock
    assert "--require-hashes" in script and "--no-build-isolation" in script
    assert "constraints.txt" not in script  # the lock replaces the unhashed constraints
    assert "--keychain-profile" in script
    for line in script.splitlines():
        if re.match(r"\s*sign\(\)", line):
            assert "--options runtime" in line and "--timestamp" in line


def test_build_lock_is_hash_pinned():
    lock = (ROOT / "packaging" / "requirements-build.lock").read_text()
    reqs = [ln for ln in re.split(r"(?<!\\)\n", lock) if ln.strip() and not ln.lstrip().startswith("#")]
    assert len(reqs) > 20
    for req in reqs:
        assert "==" in req and "--hash=sha256:" in req, req.splitlines()[0]
    names = {re.split(r"[=\s\[]", r.strip(), maxsplit=1)[0].lower() for r in reqs}
    for needed in ("pyinstaller", "pywebview", "fastapi", "uvicorn", "sqlmodel", "typer"):
        assert needed in names, needed
    assert "cashu" not in names  # the app itself is installed from the checkout, no deps


def test_paths_module_is_untouched_by_runtime_state(data_dir):
    """The app-location file lives in the data dir, owner-only, like desktop.json."""
    assert runtime.app_location_path().parent == paths.data_dir()


def test_bundle_names_after_the_rename():
    """F11: the spec builds cashU.app with the executable `cashu`, bundle id io.utopiasoft.cashu, the
    cashu:// scheme (legacy name finanse:// kept second for links posted before) and the new helper key;
    the build script uses that spec and checks that executable."""
    spec = (ROOT / "packaging" / "cashu.spec").read_text()
    assert not (ROOT / "packaging" / "finanse.spec").exists()  # legacy name
    assert 'BUNDLE_ID = "io.utopiasoft.cashu"' in spec
    assert 'name="cashu",' in spec and 'name="cashU.app"' in spec
    assert '"CFBundleURLSchemes": ["cashu", "finanse"]' in spec  # legacy name second
    assert '"CashuNotificationHelper": True' in spec
    assert 'collect_submodules("cashu"' in spec and 'os.path.join("cashu", "api", "webdist")' in spec
    script = (ROOT / "scripts" / "build_macos.sh").read_text()
    assert '"$ROOT/packaging/cashu.spec"' in script
    assert '[[ -x "$APP/Contents/MacOS/cashu" ]]' in script and 'APP="$BUILD/dist/cashU.app"' in script
    assert "packaging/icon/cashu-1024.png" in script and (ROOT / "packaging" / "icon" / "cashu-1024.png").is_file()
    from cashu.core.worker import notifier_app, scheduler

    assert notifier_app.INFO_PLIST_KEY == "CashuNotificationHelper"
    assert scheduler.DEFAULT_LABEL == "io.utopiasoft.cashu.worker"
