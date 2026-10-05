"""Notifier seam: terminal-notifier / osascript command lines (never run here), failures reported
in the Delivery, the log notifier and the platform choice."""

from __future__ import annotations

import pytest

from finanse.core.worker import notifier as nt
from finanse.core.worker.notifier import CommandResult, Notification


class FakeRunner:
    def __init__(self, code: int = 0, stderr: str = "") -> None:
        self.calls: list[list[str]] = []
        self.code, self.stderr = code, stderr

    def __call__(self, args) -> CommandResult:
        self.calls.append(list(args))
        return CommandResult(self.code, "", self.stderr)


NOTE = Notification(
    title="finanse: Dom",
    subtitle="Sygnał do działania",
    message='XMPL 37.3% > 30% "cudzysłów" \\ end',
    group="finanse-signal-7",
)


def test_terminal_notifier_command():
    runner = FakeRunner()
    mac = nt.MacNotifier(runner=runner, terminal_notifier="/opt/homebrew/bin/terminal-notifier")
    assert mac.name == "terminal-notifier"
    delivery = mac.send(NOTE)
    assert delivery == nt.Delivery(True, "terminal-notifier")
    assert runner.calls == [
        [
            "/opt/homebrew/bin/terminal-notifier",
            "-title",
            "finanse: Dom",
            "-message",
            'XMPL 37.3% > 30% "cudzysłów" \\ end',
            "-subtitle",
            "Sygnał do działania",
            "-group",
            "finanse-signal-7",
        ]
    ]


def test_osascript_gets_the_texts_as_arguments_not_as_script():
    runner = FakeRunner()
    mac = nt.MacNotifier(runner=runner, terminal_notifier=None)
    assert mac.name == "osascript"
    assert mac.send(NOTE).ok
    (args,) = runner.calls
    assert args[0] == "/usr/bin/osascript"
    script = [args[i + 1] for i, a in enumerate(args) if a == "-e"]
    assert script == [
        "on run argv",
        (
            "display notification (item 1 of argv) with title (item 2 of argv) "
            "subtitle (item 3 of argv)"
        ),
        "end run",
    ]
    # the message (with quotes and a backslash) is never part of the script text
    assert args[-3:] == [NOTE.message, NOTE.title, NOTE.subtitle]
    assert all(NOTE.message not in line for line in script)


def test_prefer_osascript_and_missing_terminal_notifier():
    mac = nt.MacNotifier(prefer="osascript", runner=FakeRunner(), terminal_notifier="/x/tn")
    assert mac.name == "osascript"
    with pytest.raises(ValueError, match="terminal-notifier not found"):
        nt.MacNotifier(prefer="terminal-notifier", runner=FakeRunner(), terminal_notifier=None)


def test_long_texts_are_clipped_and_whitespace_collapsed():
    runner = FakeRunner()
    mac = nt.MacNotifier(runner=runner, terminal_notifier="/x/tn")
    mac.send(Notification(title="t", message="a\n  b " + "x" * 500))
    message = runner.calls[0][runner.calls[0].index("-message") + 1]
    assert message.startswith("a b x") and message.endswith("...")
    assert len(message) == nt.MAX_MESSAGE
    assert "-subtitle" not in runner.calls[0] and "-group" not in runner.calls[0]


def test_a_failed_delivery_is_reported_not_raised():
    mac = nt.MacNotifier(runner=FakeRunner(1, "execution error"), terminal_notifier=None)
    delivery = mac.send(NOTE)
    assert not delivery.ok and delivery.channel == "osascript"
    assert delivery.error == "exit 1: execution error"


def test_run_command_reports_a_missing_binary():
    result = nt.run_command(["/nonexistent/finanse-notifier-test"])
    assert result.returncode == 127 and "FileNotFoundError" in result.stderr


def test_log_notifier():
    lines: list[str] = []
    log = nt.LogNotifier(lines.append)
    assert log.send(NOTE) == nt.Delivery(True, "log")
    assert lines == [
        '[powiadomienie] finanse: Dom | Sygnał do działania | XMPL 37.3% > 30% "cudzysłów" \\ end'
    ]
    assert log.sent == [NOTE]


def test_default_notifier_by_name_and_platform(monkeypatch):
    monkeypatch.setattr(nt, "find_terminal_notifier", lambda: None)
    assert nt.default_notifier("none") is None
    assert isinstance(nt.default_notifier("log", platform="darwin"), nt.LogNotifier)
    mac = nt.default_notifier("auto", platform="darwin")
    assert isinstance(mac, nt.MacNotifier) and mac.name == "osascript"
    assert nt.default_notifier("osascript", platform="darwin").name == "osascript"
    win = nt.default_notifier("auto", platform="win32")
    assert win.name == "windows-toast" and not win.send(NOTE).ok
    assert isinstance(nt.default_notifier("auto", platform="linux"), nt.LogNotifier)
    with pytest.raises(ValueError, match="needs macOS"):
        nt.default_notifier("osascript", platform="linux")
    with pytest.raises(ValueError, match="Unknown notifier"):
        nt.default_notifier("pigeon")
