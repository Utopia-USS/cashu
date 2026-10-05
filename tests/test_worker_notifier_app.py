"""Notifications through Finanse.app (F6 NT), worker side: finding the app, the helper protocol
(JSON on stdin, never argv or a script), denied / pending permission without fallback, technical
failures falling back to terminal-notifier / osascript, the ``auto`` choice, the finanse:// links
on the worker's notifications. Every helper call goes to a fake runner: nothing is posted."""

from __future__ import annotations

import json
import os
import plistlib
from pathlib import Path

import pytest
from test_worker_runner import (  # also re-exports the investments test helpers
    MONDAY,
    SUNDAY,
    RecordingNotifier,
    add_signals,
    make_profile,
)

from finanse.core.db import get_session
from finanse.core.models import Profile
from finanse.core.worker import notifications
from finanse.core.worker import notifier as nt
from finanse.core.worker import notifier_app as na
from finanse.core.worker import state as worker_state
from finanse.core.worker.notifier import CommandResult, Delivery, Notification

NOTE = Notification(
    title="finanse: Dom",
    subtitle="Sygnał do działania",
    message='XMPL 37.3% > 30% "cudzysłów" \\ end; rm -rf ~ $(touch /tmp/x)',
    group="finanse-signal-7",
    url="finanse://signal/dom/7",
)


def make_app(root: Path, *, helper=True, executable="finanse", mode=0o755) -> Path:
    app = root / "Finanse.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    info = {"CFBundleIdentifier": "io.github.synszakala.finanse", "CFBundleExecutable": executable}
    if helper:
        info[na.INFO_PLIST_KEY] = True
    (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
    exe = app / "Contents" / "MacOS" / "finanse"
    exe.write_text("#!/bin/sh\nexit 0\n")
    os.chmod(exe, mode)
    return app


class FakeHelper:
    """Stands in for `Finanse.app/.../finanse --notify-helper`: records argv + stdin."""

    def __init__(self, code=0, stdout=None, stderr=""):
        self.calls: list[tuple[list[str], dict]] = []
        self.code = code
        self.stdout = (
            stdout if stdout is not None else json.dumps({"status": na.STATUS_BY_EXIT[code]})
        )
        self.stderr = stderr

    def __call__(self, args, data):
        self.calls.append((list(args), json.loads(data)))
        return CommandResult(self.code, self.stdout + "\n", self.stderr)


class FakeFallback(RecordingNotifier):
    name = "terminal-notifier"


def app_notifier(tmp_path, helper, fallback=None) -> na.AppNotifier:
    bundle = na.inspect_bundle(make_app(tmp_path))
    assert bundle is not None
    return na.AppNotifier(bundle, fallback=fallback, runner=helper)


# --------------------------------------------------------------------------- #
# Links
# --------------------------------------------------------------------------- #


def test_links():
    assert nt.signal_link("dom", 7) == "finanse://signal/dom/7"
    assert nt.review_link("anna-k") == "finanse://review/anna-k"
    assert nt.investments_link("anna-k") == "finanse://investments/anna-k"
    assert nt.signal_link("a/b c", "12") == "finanse://signal/a%2Fb%20c/12"  # never a new segment
    with pytest.raises(ValueError):
        nt.signal_link("dom", "7; drop")


# --------------------------------------------------------------------------- #
# Finding the app
# --------------------------------------------------------------------------- #


def test_inspect_bundle_needs_the_helper_key_and_an_executable(tmp_path):
    found = na.inspect_bundle(make_app(tmp_path / "ok"))
    assert found is not None and found.executable.name == "finanse"
    assert na.inspect_bundle(make_app(tmp_path / "old", helper=False)) is None  # older build
    assert na.inspect_bundle(make_app(tmp_path / "noexec", mode=0o644)) is None
    assert na.inspect_bundle(make_app(tmp_path / "evil", executable="../../bin/sh")) is None
    assert na.inspect_bundle(tmp_path / "missing.app") is None
    broken = make_app(tmp_path / "broken")
    (broken / "Contents" / "Info.plist").write_text("not a plist")
    assert na.inspect_bundle(broken) is None


def test_find_app_bundle_order(tmp_path):
    own = make_app(tmp_path / "own")
    system = make_app(tmp_path / "system")
    user = make_app(tmp_path / "user")
    old = make_app(tmp_path / "old", helper=False)

    def find(env=None, mine=None, candidates=(system, user)):
        found = na.find_app_bundle(env=env or {}, own=lambda: mine, candidates=list(candidates))
        return found.path if found else None

    assert find(mine=own) == own  # the worker runs from the app: that app
    assert find() == system  # /Applications before ~/Applications
    assert find(candidates=(old, user)) == user  # an app without the helper is skipped
    assert find(mine=old, candidates=()) is None
    assert find(env={na.APP_ENV: str(user)}, mine=own) == user  # explicit path wins
    assert find(env={na.APP_ENV: str(old)}) is None  # ... but must have the helper
    assert find(env={na.APP_ENV: "none"}, mine=own) is None  # turned off
    assert find(env={na.APP_ENV: " NONE "}, mine=own) is None


def test_tests_never_find_a_real_app():
    assert os.environ.get(na.APP_ENV) == "none"  # conftest
    assert na.find_app_bundle() is None


# --------------------------------------------------------------------------- #
# The helper protocol
# --------------------------------------------------------------------------- #


def test_texts_go_to_the_helper_as_json_on_stdin(tmp_path):
    helper = FakeHelper()
    app = app_notifier(tmp_path, helper)
    assert app.name == "app"
    assert app.send(NOTE) == Delivery(True, "app")
    ((args, data),) = helper.calls
    assert args == [str(app.app.executable), "--notify-helper"]  # nothing else on the command line
    assert data == {
        "title": "Dom",  # the app's own name (Finanse) is shown above the title
        "subtitle": "Sygnał do działania",
        "message": NOTE.message,
        "group": "finanse-signal-7",
        "url": "finanse://signal/dom/7",
    }


def test_payload_is_clipped_like_the_other_notifiers(tmp_path):
    helper = FakeHelper()
    app_notifier(tmp_path, helper).send(Notification(title="finanse: ", message="a\n b " * 200))
    ((_, data),) = helper.calls
    assert data["title"] == "finanse" and data["subtitle"] == ""
    assert len(data["message"]) == nt.MAX_MESSAGE and data["message"].startswith("a b a b")
    assert data["group"] is None and data["url"] is None


@pytest.mark.parametrize(
    ("code", "hint"), [(na.EXIT_DENIED, na.DENIED_HINT), (na.EXIT_PENDING, na.PENDING_HINT)]
)
def test_denied_or_pending_permission_is_never_routed_around(tmp_path, code, hint):
    fallback = FakeFallback()
    app = app_notifier(tmp_path, FakeHelper(code), fallback)
    delivery = app.send(NOTE)
    assert delivery == Delivery(False, "app", hint)
    assert fallback.sent == []  # the user's choice for Finanse stands


@pytest.mark.parametrize(
    "helper",
    [
        FakeHelper(na.EXIT_UNAVAILABLE),
        FakeHelper(na.EXIT_FAILED, json.dumps({"status": "failed", "error": "UNErrorDomain 1"})),
        FakeHelper(na.EXIT_USAGE),
        FakeHelper(127, stdout="", stderr="FileNotFoundError: finanse"),  # app deleted meanwhile
        FakeHelper(-9, stdout="Traceback (most recent call last): ..."),  # crashed
    ],
    ids=["unavailable", "failed", "usage", "missing", "crash"],
)
def test_technical_failures_fall_back(tmp_path, helper, caplog):
    fallback = FakeFallback()
    delivery = app_notifier(tmp_path, helper, fallback).send(NOTE)
    assert delivery == Delivery(True, "terminal-notifier")
    assert fallback.sent == [NOTE]
    assert "could not post" in caplog.text


def test_technical_failure_without_fallback_is_reported(tmp_path):
    helper = FakeHelper(na.EXIT_FAILED, json.dumps({"status": "failed", "error": "boom"}))
    delivery = app_notifier(tmp_path, helper).send(NOTE)
    assert not delivery.ok and delivery.channel == "app"
    assert delivery.error == "Finanse.app could not post (failed: boom)"


def test_parse_answer():
    line = json.dumps({"status": "delivered"})
    assert na.parse_answer(CommandResult(0, f"noise\n{line}\n")) == ("delivered", None)
    denied = json.dumps({"status": "denied", "error": "x" * 400})
    status, error = na.parse_answer(CommandResult(3, denied))
    assert status == "denied" and len(error) == 300
    assert na.parse_answer(CommandResult(4, "")) == ("pending", "exit 4")
    assert na.parse_answer(CommandResult(1, "{broken", "trace")) == ("failed", "exit 1: trace")
    unknown = json.dumps({"status": "weird"})  # not a helper answer: the exit code decides
    assert na.parse_answer(CommandResult(3, unknown)) == ("denied", f"exit 3: {unknown}")
    assert na.parse_answer(CommandResult(99, "")) == ("failed", "exit 99")


def test_run_command_feeds_stdin_and_closes_it_otherwise():
    assert nt.run_command(["/bin/cat"], input="ąę {json}").stdout == "ąę {json}"
    assert nt.run_command(["/bin/cat"], timeout=5).stdout == ""  # no input: EOF, never waits


# --------------------------------------------------------------------------- #
# The auto choice and the fallback notifier
# --------------------------------------------------------------------------- #


def test_auto_prefers_the_app_and_keeps_terminal_notifier_as_fallback(tmp_path, monkeypatch):
    bundle = na.inspect_bundle(make_app(tmp_path))
    monkeypatch.setattr(na, "find_app_bundle", lambda: bundle)
    monkeypatch.setattr(nt, "find_terminal_notifier", lambda: "/opt/homebrew/bin/terminal-notifier")
    auto = nt.default_notifier("auto", platform="darwin")
    assert isinstance(auto, na.AppNotifier) and auto.app == bundle
    assert isinstance(auto._fallback, nt.MacNotifier) and auto._fallback._open_links
    forced = nt.default_notifier("app", platform="darwin")
    assert isinstance(forced, na.AppNotifier) and forced._fallback is None
    assert nt.default_notifier("osascript", platform="darwin").name == "osascript"
    assert nt.default_notifier("terminal-notifier", platform="darwin").name == "terminal-notifier"
    with pytest.raises(ValueError, match="needs macOS"):
        nt.default_notifier("app", platform="linux")


def test_without_the_app_auto_uses_terminal_notifier_then_osascript(monkeypatch):
    monkeypatch.setattr(na, "find_app_bundle", lambda: None)
    monkeypatch.setattr(nt, "find_terminal_notifier", lambda: "/usr/local/bin/terminal-notifier")
    assert nt.default_notifier("auto", platform="darwin").name == "terminal-notifier"
    monkeypatch.setattr(nt, "find_terminal_notifier", lambda: None)
    assert nt.default_notifier("auto", platform="darwin").name == "osascript"
    with pytest.raises(ValueError, match=r"Finanse\.app .*not found"):
        nt.default_notifier("app", platform="darwin")


def test_terminal_notifier_opens_the_link_only_when_asked():
    calls = []

    def runner(args):
        calls.append(list(args))
        return CommandResult(0)

    nt.MacNotifier(runner=runner, terminal_notifier="/x/tn", open_links=True).send(NOTE)
    nt.MacNotifier(runner=runner, terminal_notifier="/x/tn").send(NOTE)
    other = Notification(title="t", message="m", url="https://example.invalid/")
    nt.MacNotifier(runner=runner, terminal_notifier="/x/tn", open_links=True).send(other)
    nt.MacNotifier(runner=runner, terminal_notifier=None, open_links=True).send(NOTE)
    assert calls[0][-2:] == ["-open", "finanse://signal/dom/7"]
    assert "-open" not in calls[1]  # no app: a finanse:// link would open nothing
    assert "-open" not in calls[2]  # only the app's own links
    assert calls[3][0] == "/usr/bin/osascript" and "finanse://" not in " ".join(calls[3])


def test_log_notifier_shows_the_link():
    lines: list[str] = []
    nt.LogNotifier(lines.append).send(NOTE)
    assert lines[0].endswith(" <finanse://signal/dom/7>")


# --------------------------------------------------------------------------- #
# The worker's notifications carry links
# --------------------------------------------------------------------------- #


def test_worker_notifications_carry_links(db_engine):
    pid, slug = make_profile("Dom")
    ids = add_signals(pid, 5)
    fake = RecordingNotifier()
    with get_session() as s:
        profile = s.get(Profile, pid)
    notifications.deliver_pending(profile, fake, now=MONDAY, session_factory=get_session)
    assert [n.url for n in fake.sent] == [
        *(f"finanse://signal/{slug}/{i}" for i in ids[:3]),
        f"finanse://investments/{slug}",  # the summary of the rest
    ]

    state = worker_state.WorkerState()
    digest = RecordingNotifier()
    result = notifications.send_digest(
        profile,
        digest,
        today=SUNDAY.date(),
        state=state,
        save_state=lambda st: None,
        session_factory=get_session,
    )
    assert result.status == "sent"
    assert digest.sent[0].url == f"finanse://review/{slug}"
