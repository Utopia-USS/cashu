"""Desktop notifications behind one seam (``Notifier``).

- macOS: ``terminal-notifier`` when installed (looked up on PATH and in the Homebrew dirs, since a
  launchd agent starts with a minimal PATH), else ``osascript`` (``display notification``). The
  texts go to osascript as arguments of an ``on run argv`` handler, never spliced into the script,
  so a quote in a signal message cannot change what runs.
- ``LogNotifier`` prints the notification (headless setups, manual runs, tests).
- Windows: ``WindowsToastNotifier`` is an interface stub for the later Windows build.

Titles and messages are Polish (UI data). A notifier reports failure in the returned
``Delivery``; it never raises for a failed delivery.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

# Where Homebrew installs terminal-notifier (Apple silicon, Intel).
EXTRA_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
MAX_MESSAGE = 240
NOTIFIER_NAMES = ("auto", "terminal-notifier", "osascript", "log", "none")


@dataclass(frozen=True)
class Notification:
    title: str
    message: str
    subtitle: str | None = None
    group: str | None = (
        None  # terminal-notifier: a newer notification of a group replaces the older
    )


@dataclass(frozen=True)
class Delivery:
    ok: bool
    channel: str
    error: str | None = None


class Notifier(Protocol):
    name: str

    def send(self, notification: Notification) -> Delivery: ...


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


CommandRunner = Callable[[Sequence[str]], CommandResult]


def run_command(args: Sequence[str], timeout: float = 30.0) -> CommandResult:
    """Run a command, capture its output; a missing binary or a timeout is a failed result."""
    try:
        done = subprocess.run(  # fixed argv, no shell
            list(args), capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as e:
        return CommandResult(127, "", f"{type(e).__name__}: {e}")
    return CommandResult(done.returncode, done.stdout or "", done.stderr or "")


def _clip(text: str, limit: int = MAX_MESSAGE) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def find_terminal_notifier() -> str | None:
    path = os.pathsep.join([os.environ.get("PATH", ""), *EXTRA_BIN_DIRS])
    return shutil.which("terminal-notifier", path=path)


_OSASCRIPT = (
    "on run argv",
    "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
    "end run",
)


class MacNotifier:
    """terminal-notifier if present (``prefer``), else osascript."""

    def __init__(
        self,
        *,
        prefer: str = "auto",
        runner: CommandRunner = run_command,
        terminal_notifier: str | None | Callable[[], str | None] = find_terminal_notifier,
    ) -> None:
        if prefer not in ("auto", "terminal-notifier", "osascript"):
            raise ValueError(f"Unknown macOS notifier {prefer!r}")
        self._runner = runner
        tn = terminal_notifier() if callable(terminal_notifier) else terminal_notifier
        self._tn = None if prefer == "osascript" else tn
        if prefer == "terminal-notifier" and self._tn is None:
            raise ValueError("terminal-notifier not found (brew install terminal-notifier)")
        self.name = "terminal-notifier" if self._tn else "osascript"

    def command(self, n: Notification) -> list[str]:
        title, message = _clip(n.title, 80), _clip(n.message)
        subtitle = _clip(n.subtitle or "", 80)
        if self._tn:
            args = [self._tn, "-title", title, "-message", message]
            if subtitle:
                args += ["-subtitle", subtitle]
            if n.group:
                args += ["-group", n.group]
            return args
        script: list[str] = []
        for line in _OSASCRIPT:
            script += ["-e", line]
        return ["/usr/bin/osascript", *script, message, title, subtitle]

    def send(self, notification: Notification) -> Delivery:
        result = self._runner(self.command(notification))
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[:300]
            return Delivery(False, self.name, f"exit {result.returncode}: {detail}")
        return Delivery(True, self.name)


class LogNotifier:
    """Prints each notification (stdout goes to the worker log under launchd)."""

    name = "log"

    def __init__(self, echo: Callable[[str], None] = print) -> None:
        self._echo = echo
        self.sent: list[Notification] = []

    def send(self, notification: Notification) -> Delivery:
        parts = [notification.title, notification.subtitle or "", notification.message]
        self._echo("[powiadomienie] " + " | ".join(p for p in parts if p))
        self.sent.append(notification)
        return Delivery(True, self.name)


class WindowsToastNotifier:
    """Windows toast notifications (later): same seam, not implemented yet."""

    name = "windows-toast"

    def send(self, notification: Notification) -> Delivery:
        return Delivery(False, self.name, "Windows notifications are not implemented yet")


def default_notifier(name: str = "auto", *, platform: str | None = None) -> Notifier | None:
    """The notifier for ``name`` (``auto`` = the platform's own); ``none`` -> None (no delivery)."""
    platform = platform or sys.platform
    if name not in NOTIFIER_NAMES:
        raise ValueError(f"Unknown notifier {name!r}; choose one of {', '.join(NOTIFIER_NAMES)}")
    if name == "none":
        return None
    if name == "log":
        return LogNotifier()
    if platform == "darwin":
        return MacNotifier(prefer=name)
    if name != "auto":
        raise ValueError(f"Notifier {name!r} needs macOS")
    if platform == "win32":
        return WindowsToastNotifier()
    return LogNotifier()
