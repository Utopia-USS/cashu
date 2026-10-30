"""Auto-update (Sparkle): a replaced app is noticed (``runtime.bundle_replaced``) and an MCP server or a
worker run from the old copy stops; when the updater runs; the release feed (``make_appcast.py``)
and the static build inputs. A fake bundle in a temp dir, a throwaway Ed25519 key; no Sparkle, no
network."""

from __future__ import annotations

import base64
import datetime as dt
import os
import plistlib
import re
import stat
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from cashu.core import runtime, updates
from cashu.core.mcp import audit
from cashu.core.mcp import server as mcp_server
from cashu.core.worker import runner
from cashu.desktop import updater

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import make_appcast


def make_bundle(where: Path, version: str = "1.0.0", **extra) -> Path:
    app = where / "cashU.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "MacOS" / "cashu").write_text("")
    info = {"CFBundleShortVersionString": version, "CFBundleVersion": version, **extra}
    (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
    return app


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    app = make_bundle(tmp_path / "Applications")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(app / "Contents" / "MacOS" / "cashu"))
    monkeypatch.setattr(runtime, "_bundle_stamp", runtime._UNSET)
    return app


def replace_bundle(app: Path) -> None:
    """What Sparkle (or a drag from a DMG) does: a new copy takes the old one's path."""
    staged = make_bundle(app.parent / "staged", version="2.0.0")
    app.rename(app.parent / "old.app")
    staged.rename(app)


# --------------------------------------------------------------------------- #
# runtime.bundle_replaced
# --------------------------------------------------------------------------- #


def test_a_replaced_bundle_is_noticed(bundle):
    runtime.remember_bundle()
    assert not runtime.bundle_replaced()
    replace_bundle(bundle)
    assert runtime.bundle_replaced()


def test_a_removed_bundle_counts_as_replaced(bundle):
    runtime.remember_bundle()
    (bundle / "Contents" / "Info.plist").unlink()
    assert runtime.bundle_replaced()


def test_the_first_check_remembers_when_the_entry_point_did_not(bundle):
    assert not runtime.bundle_replaced()  # remembers now
    replace_bundle(bundle)
    assert runtime.bundle_replaced()


def test_never_replaced_from_source(monkeypatch):
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(runtime, "_bundle_stamp", runtime._UNSET)
    runtime.remember_bundle()
    assert not runtime.bundle_replaced()


# --------------------------------------------------------------------------- #
# MCP server from a replaced app
# --------------------------------------------------------------------------- #


def test_mcp_refuses_before_the_audit_and_the_database(monkeypatch):
    monkeypatch.setattr(runtime, "bundle_replaced", lambda: True)

    def no_audit(*_a, **_k):
        raise AssertionError("a replaced server must not write the audit log")

    monkeypatch.setattr(audit, "start", no_audit)
    monkeypatch.setattr(mcp_server, "get_session", no_audit)
    host = mcp_server.CashuMcp(profile_id=1)
    result = host.call("profile_overview", {})
    assert not result.ok and result.error_kind == "app_updated"
    assert "/mcp" in (result.error or "")
    assert host.stopping
    assert host.list_tools() == []


def test_mcp_answers_then_exits_when_replaced(monkeypatch):
    import anyio
    from mcp import Client

    exits: list[bool] = []
    monkeypatch.setattr(mcp_server, "_exit_soon", lambda: exits.append(True))
    replaced = {"now": False}
    monkeypatch.setattr(runtime, "bundle_replaced", lambda: replaced["now"])
    server = mcp_server.build_server(mcp_server.CashuMcp(profile_id=1), "cashu-test")

    async def main():
        async with Client(server) as client:
            replaced["now"] = True  # updated while the client is connected
            answer = await client.call_tool("profile_overview", {})
            assert answer.is_error and "/mcp" in answer.content[0].text

    anyio.run(main)
    assert exits == [True]


# --------------------------------------------------------------------------- #
# Worker run from a replaced app
# --------------------------------------------------------------------------- #


def test_worker_stops_before_the_next_job_and_writes_no_state(db_engine, tmp_path, monkeypatch):
    sys.path.insert(0, str(ROOT / "tests" / "investments" / "persistence"))
    from invp_support import make_profile

    make_profile("Inwestor", modules=("investments", "budget"))
    monkeypatch.setattr(runtime, "bundle_replaced", lambda: True)
    state_path = tmp_path / "worker-state.json"
    report = runner.run_worker(notifier=None, offline=True, state_path=state_path)
    assert [j.job for j in report.jobs] == [runner.APP_UPDATED]
    assert report.jobs[0].code == "app_updated" and report.jobs[0].status == "skipped"
    assert not state_path.exists()


# --------------------------------------------------------------------------- #
# When the updater runs
# --------------------------------------------------------------------------- #

FEED = {"SUFeedURL": "https://example.invalid/appcast.xml", "SUPublicEDKey": "AAAA"}


@pytest.fixture
def mac(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.delenv(updater.ANYWHERE_ENV, raising=False)
    monkeypatch.delenv(updater.CHECK_ENV, raising=False)
    app = Path("/Applications/cashU.app")
    monkeypatch.setattr(updater, "framework_path", lambda b: tmp_path / "Sparkle.framework")
    (tmp_path / "Sparkle.framework").mkdir()
    return app


def test_updater_runs_from_applications_with_a_feed(mac):
    assert updater.unavailable_reason(mac, FEED) is None


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("source", "not the packaged macOS app"),
        ("translocated", "App Translocation"),
        ("elsewhere", "/Applications"),
        ("checks_off", "CASHU_UPDATE_CHECK=0"),
        ("no_feed", "no update feed"),
        ("no_framework", "Sparkle.framework"),
    ],
)
def test_updater_stays_off(mac, monkeypatch, tmp_path, case, expected):
    bundle, info, translocated = mac, dict(FEED), False
    if case == "source":
        bundle = None
    elif case == "translocated":
        translocated = True
    elif case == "elsewhere":
        bundle = Path("/Users/someone/Downloads/cashU.app")
    elif case == "checks_off":
        monkeypatch.setenv(updater.CHECK_ENV, "0")
    elif case == "no_feed":
        info.pop("SUPublicEDKey")
    elif case == "no_framework":
        (tmp_path / "Sparkle.framework").rmdir()
    reason = updater.unavailable_reason(bundle, info, translocated=translocated)
    assert reason is not None and expected in reason


def test_updater_may_run_elsewhere_for_testing(mac, monkeypatch):
    monkeypatch.setenv(updater.ANYWHERE_ENV, "1")
    assert updater.unavailable_reason(Path("/tmp/x/cashU.app"), FEED) is None


class FakeMain:
    """Stands in for AppHelper.callAfter: runs the call at once and records it."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def __call__(self, fn, *args) -> None:
        self.calls.append(getattr(fn, "__name__", "block"))
        fn(*args)


@pytest.fixture
def bridge(monkeypatch):
    main = FakeMain()
    checks: list[bool] = []
    b = updater.Bridge(True, main, lambda: checks.append(True))
    b.checks = checks
    monkeypatch.setattr(updater, "_apply_auto", lambda enabled: None)
    updates.register_app_updater(b)
    yield b
    updates.register_app_updater(None)


def offer(b, version="0.4.0") -> list[int]:
    """Sparkle found ``version``; returns the owner's answers as Sparkle receives them."""
    answers: list[int] = []
    b.found(version, answers.append)
    return answers


def test_nothing_is_downloaded_until_the_owner_says_so(bridge):
    answers = offer(bridge)
    assert bridge.state()["stage"] == "available" and answers == []
    assert bridge.install() is True and answers == [updater.INSTALL]
    assert bridge.state()["stage"] == "downloading"
    assert bridge.install() is False  # answered once only


def test_download_progress_then_install(bridge):
    offer(bridge)
    bridge.install()
    bridge.download_started()
    bridge.download_expected(1000)
    bridge.download_received(250)
    assert bridge.state()["progress"] == 0.25
    bridge.installing()
    assert bridge.state()["stage"] == "installing" and bridge.state()["progress"] is None


def test_skip_and_dismiss_answer_sparkle(bridge):
    answers = offer(bridge)
    assert bridge.skip() is True and answers == [updater.SKIP]
    assert bridge.state()["stage"] == "idle"
    answers = offer(bridge)
    assert bridge.dismiss() is True and answers == [updater.DISMISS]
    assert bridge.skip() is False and bridge.dismiss() is False  # nothing shown anymore


def test_results_stay_until_closed_and_the_cycle_end_clears_the_rest(bridge):
    bridge.checking()
    bridge.cycle_ended()
    assert bridge.state()["stage"] == "idle"
    bridge.not_found()
    bridge.cycle_ended()  # Sparkle ends its cycle right after "not found"
    assert bridge.state()["stage"] == "up_to_date"
    assert bridge.dismiss() is True and bridge.state()["stage"] == "idle"
    bridge.failed("The update is improperly signed.")
    assert bridge.state()["error"] == "The update is improperly signed."
    assert bridge.dismiss() is True and bridge.state() == {
        "auto": True, "stage": "idle", "version": None, "progress": None, "error": None,
    }


def test_check_on_demand_only_when_nothing_runs(bridge):
    assert bridge.check() is True and bridge.checks == [True]
    bridge.checking()
    assert bridge.check() is False and bridge.checks == [True]


def test_every_change_is_pushed(bridge):
    pushes: list[bool] = []
    bridge.on_change = lambda: pushes.append(True)
    offer(bridge)
    bridge.skip()
    assert len(pushes) == 2


def test_status_and_routes_with_the_app_updater(api_empty, bridge, monkeypatch):
    def no_branch_check(*_a, **_k):
        raise AssertionError("cashU.app with Sparkle never asks the GitHub branch")

    monkeypatch.setattr(updates, "fetch_remote_version", no_branch_check)
    body = api_empty.get("/api/system/update").json()
    assert body["available"] is False and body["app"]["stage"] == "idle"
    assert api_empty.post("/api/system/update/install").status_code == 409  # nothing offered
    answers = offer(bridge)
    assert api_empty.get("/api/system/update").json()["app"]["version"] == "0.4.0"
    done = api_empty.post("/api/system/update/install")
    assert done.status_code == 200 and done.json()["stage"] == "downloading"
    assert answers == [updater.INSTALL]
    assert api_empty.post("/api/system/update/check").status_code == 409  # an update is under way
    assert api_empty.post("/api/system/update/nope").status_code == 404
    off = api_empty.put("/api/system/update/auto", json={"enabled": False})
    assert off.status_code == 200 and off.json()["auto"] is False


def test_app_update_routes_refuse_without_the_app_updater(api_empty):
    updates.register_app_updater(None)
    assert api_empty.post("/api/system/update/install").status_code == 409
    assert api_empty.post("/api/system/update/check").status_code == 409
    assert api_empty.put("/api/system/update/auto", json={"enabled": True}).status_code == 409


def test_display_version_names_a_rebuild_of_the_same_release(monkeypatch):
    monkeypatch.setattr(updater, "__version__", "0.3.2")
    assert updater.display_version("0.4.0", "0.4.0") == "0.4.0"
    assert updater.display_version("0.3.2", "0.3.2.1") == "0.3.2 (0.3.2.1)"


def test_updater_start_is_a_no_op_from_source(monkeypatch):
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(updater, "_updater", None)
    assert updater.start() is False
    assert updater.add_menu_item() is False
    updater.add_menu_item_later()  # nothing scheduled, nothing raised


# --------------------------------------------------------------------------- #
# Release feed (scripts/make_appcast.py)
# --------------------------------------------------------------------------- #


def keypair(tmp_path: Path) -> tuple[Path, str]:
    key = Ed25519PrivateKey.generate()
    seed = key.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    path = tmp_path / "ed-key"
    path.write_bytes(base64.b64encode(seed))
    return path, base64.b64encode(public).decode()


def fake_sign_update(tmp_path: Path) -> Path:
    """Stands in for Sparkle's sign_update: the same output line, signed with --ed-key-file."""
    tool = tmp_path / "sign_update"
    tool.write_text(
        f"#!{sys.executable}\n"
        "import base64, sys\n"
        "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey\n"
        "args = sys.argv[1:]\n"
        "key = open(args[args.index('--ed-key-file') + 1], 'rb').read()\n"
        "data = open(args[-1], 'rb').read()\n"
        "sig = Ed25519PrivateKey.from_private_bytes(base64.b64decode(key)).sign(data)\n"
        "print(f'sparkle:edSignature=\"{base64.b64encode(sig).decode()}\" length=\"{len(data)}\"')\n"
    )
    tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    return tool


def release_build(tmp_path: Path, public_key: str, version: str = "0.4.0") -> Path:
    build = tmp_path / "build"
    make_bundle(
        build / "dist",
        version=version,
        LSMinimumSystemVersion="11.0",
        SUFeedURL="https://example.invalid/appcast.xml",
        SUPublicEDKey=public_key,
    )
    archive = build / f"cashU-{version}-macos-arm64.zip"
    archive.write_bytes(os.urandom(4096))
    return archive


def test_make_appcast_signs_verifies_and_writes_the_feed(tmp_path):
    key_file, public = keypair(tmp_path)
    archive = release_build(tmp_path, public)
    code = make_appcast.main(
        [str(archive), "--sign-update", str(fake_sign_update(tmp_path)),
         "--ed-key-file", str(key_file), "--repo", "owner/repo"]
    )
    assert code == 0
    feed = archive.parent / "appcast-macos-arm64.xml"
    ns = {"sparkle": make_appcast.SPARKLE_NS}
    item = ET.parse(feed).getroot().find("channel/item")
    assert item.find("sparkle:version", ns).text == "0.4.0"
    assert item.find("sparkle:minimumSystemVersion", ns).text == "12.0"  # Sparkle's floor
    enclosure = item.find("enclosure")
    assert enclosure.get("url") == (
        "https://github.com/owner/repo/releases/download/v0.4.0/cashU-0.4.0-macos-arm64.zip"
    )
    assert enclosure.get("length") == "4096"
    signature = enclosure.get(f"{{{make_appcast.SPARKLE_NS}}}edSignature")
    assert make_appcast.verify(archive.read_bytes(), signature, public)


def test_make_appcast_refuses_a_key_the_app_does_not_trust(tmp_path, capsys):
    key_file, _ = keypair(tmp_path)
    (tmp_path / "other").mkdir()
    _, other_public = keypair(tmp_path / "other")
    archive = release_build(tmp_path, other_public)
    code = make_appcast.main(
        [str(archive), "--sign-update", str(fake_sign_update(tmp_path)),
         "--ed-key-file", str(key_file)]
    )
    assert code == 1 and "wrong key" in capsys.readouterr().err
    assert not (archive.parent / "appcast-macos-arm64.xml").exists()


def test_make_appcast_refuses_a_build_without_a_feed(tmp_path, capsys):
    build = tmp_path / "build"
    make_bundle(build / "dist", version="0.4.0")
    archive = build / "cashU-0.4.0-macos-arm64.zip"
    archive.write_bytes(b"x")
    assert make_appcast.main([str(archive)]) == 1
    assert "no update feed" in capsys.readouterr().err


def test_appcast_helpers():
    assert make_appcast.parse_archive_name("cashU-0.3.2-macos-x86_64.zip") == ("0.3.2", "x86_64")
    with pytest.raises(make_appcast.AppcastError):
        make_appcast.parse_archive_name("cashU.zip")
    assert make_appcast.min_macos(None) == "12.0"
    assert make_appcast.min_macos("14.0") == "14.0"
    assert make_appcast.min_macos("10.13") == "12.0"
    release = make_appcast.Release(
        "1.0", "1.0", "12.0", "https://x/a&b.zip", 1, "c2ln", "https://x/notes",
        dt.datetime(2026, 10, 29, tzinfo=dt.UTC),
    )
    ET.fromstring(make_appcast.appcast_xml(release))  # well-formed, the & escaped


# --------------------------------------------------------------------------- #
# Static build inputs
# --------------------------------------------------------------------------- #


def test_sparkle_is_pinned_and_signed_inside_out():
    fetch = (ROOT / "scripts" / "fetch_sparkle.sh").read_text()
    assert re.search(r'^SPARKLE_VERSION="\d+\.\d+\.\d+"$', fetch, re.MULTILINE)
    assert re.search(r'^SPARKLE_SHA256="[0-9a-f]{64}"$', fetch, re.MULTILINE)
    assert "shasum -a 256 -c" in fetch and "set -euo pipefail" in fetch
    script = (ROOT / "scripts" / "build_macos.sh").read_text()
    assert '"$ROOT/scripts/fetch_sparkle.sh"' in script
    assert "XPCServices" in script  # left out: the app is not sandboxed
    body = script[script.index("sign_sparkle() {"):]
    body = body[: body.index("}")]
    assert body.index("Autoupdate") < body.index("Updater.app") < body.index('"$SPARKLE_FW"')
    assert "--deep" not in body
    assert "-not -path '*/Sparkle.framework/*'" in script  # not re-signed as loose files


def test_spec_writes_the_feed_keys_only_with_a_key():
    spec = (ROOT / "packaging" / "cashu.spec").read_text()
    assert 'if SPARKLE_FEED_URL and SPARKLE_PUBLIC_KEY:' in spec
    assert 'info_plist["SUVerifyUpdateBeforeExtraction"] = True' in spec
    assert 'info_plist["SUEnableSystemProfiling"] = False' in spec
    # a daily check without a prompt; downloads only after the owner's "Aktualizuj"
    assert 'info_plist["SUEnableAutomaticChecks"] = True' in spec
    assert 'info_plist["SUAllowsAutomaticUpdates"] = False' in spec  # never a silent download
    assert "SUAutomaticallyUpdate" not in spec


def test_driver_signatures_use_the_arm64_bool_type():
    """PyObjC checks the driver against Sparkle's SPUUserDriver protocol when the class is defined: a
    BOOL there is encoded ``B`` (C bool on arm64), and a ``Z`` makes the updater fail to start."""
    source = (ROOT / "src" / "cashu" / "desktop" / "updater.py").read_text()
    selectors = re.findall(r'typedSelector\(b"([^"]+)"\)', source)
    assert selectors and not [s for s in selectors if "Z" in s]


# --------------------------------------------------------------------------- #
# Local release (scripts/release_macos.sh, packaging/RELEASING.md)
# --------------------------------------------------------------------------- #


def test_release_config_is_git_ignored_and_holds_no_secret():
    import subprocess

    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "packaging/release.local.env"], cwd=ROOT, check=False
    )
    assert ignored.returncode == 0
    template = (ROOT / "packaging" / "release.env.example").read_text()
    keys = re.findall(r"^([A-Z_]+)=", template, re.MULTILINE)
    assert keys == ["SPARKLE_PUBLIC_ED_KEY", "DEVELOPER_ID_APPLICATION", "NOTARY_KEYCHAIN_PROFILE"]
    assert re.findall(r'^[A-Z_]+="(.*)"$', template, re.MULTILINE) == ["", "", ""]  # filled in locally


def test_release_script_keeps_secrets_in_the_keychain_and_publishes_carefully():
    script = (ROOT / "scripts" / "release_macos.sh").read_text()
    assert "set -euo pipefail" in script and not re.search(r"^\s*set -x", script, re.MULTILINE)
    assert 'check-ignore -q "$CONFIG"' in script  # refuses a config git would commit
    assert "--ed-key-file" not in script and "generate_keys\" -x" not in script
    assert '"$BUILD/sparkle/bin/generate_keys" -p' in script  # the keychain key must match the config
    assert "worktree add --quiet --detach" in script and "origin/main" in script
    assert "--draft" in script and "--draft=false" in script  # checked as a draft, then published
    assert ".permissions.admin" in script
    # make_appcast needs cryptography: the build venv has it, the system python3 may not
    assert '"$BUILD/macos/venv/bin/python" "$SRC/scripts/make_appcast.py"' in script


def test_release_script_ad_hoc_until_the_developer_id_exists():
    """Without a Developer ID the release is ad-hoc and not notarized; the Sparkle key is required in both."""
    script = (ROOT / "scripts" / "release_macos.sh").read_text()
    assert ': "${SPARKLE_PUBLIC_ED_KEY:?' in script
    assert 'DEVELOPER_ID_APPLICATION="${DEVELOPER_ID_APPLICATION:-}"' in script
    assert "notarization needs a Developer ID" in script  # never half of the pair
    assert "a Developer ID release is notarized" in script
