"""Desktop notifications behind one seam (``Notifier``).

- macOS, ``auto``: through the packaged app when a ``Finanse.app`` with the notification helper is
  found (``notifier_app.AppNotifier``: UserNotifications, shown as Finanse with the app icon, a
  click opens the app on the signal), else ``terminal-notifier`` when installed (looked up on PATH
  and in the Homebrew dirs, since a launchd agent starts with a minimal PATH), else ``osascript``
  (``display notification``). The texts go to osascript as arguments of an ``on run argv``
  handler, never spliced into the script, so a quote in a signal message cannot change what runs.
- ``LogNotifier`` prints the notification (headless setups, manual runs, tests).
- Windows: ``WindowsToastNotifier`` is an interface stub for the later Windows build.

Titles and messages are Polish (UI data). A notifier reports failure in the returned
``Delivery``; it never raises for a failed delivery.

Links: a notification may carry a ``finanse://`` link (``signal_link`` and friends); the app
registers the scheme and opens the matching view (``desktop/notify.py``).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote

# Where Homebrew installs terminal-notifier (Apple silicon, Intel).
EXTRA_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
MAX_MESSAGE = 240
NOTIFIER_NAMES = ("auto", "app", "terminal-notifier", "osascript", "log", "none")

# --------------------------------------------------------------------------- #
# finanse:// links (registered by Finanse.app, handled in desktop/notify.py)
# --------------------------------------------------------------------------- #

LINK_SCHEME = "finanse"


def _seg(value: object) -> str:
    return quote(str(value), safe="")


def signal_link(slug: str, signal_id: int) -> str:
    """Opens the investments view of ``slug`` on the signal."""
    return f"{LINK_SCHEME}://signal/{_seg(slug)}/{int(signal_id)}"


def review_link(slug: str) -> str:
    """Opens the investments view of ``slug`` with the weekly review open."""
    return f"{LINK_SCHEME}://review/{_seg(slug)}"


def investments_link(slug: str) -> str:
    """Opens the investments view of ``slug``."""
    return f"{LINK_SCHEME}://investments/{_seg(slug)}"


@dataclass(frozen=True)
class Notification:
    title: str
    message: str
    subtitle: str | None = None
    group: str | None = None  # a newer notification of a group replaces the older one
    url: str | None = None  # finanse:// link opened by a click (app, terminal-notifier)


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


def run_command(
    args: Sequence[str], timeout: float = 30.0, input: str | None = None
) -> CommandResult:
    """Run a command, capture its output; a missing binary or a timeout is a failed result.
    ``input`` goes to its stdin (else stdin is closed)."""
    try:
        done = subprocess.run(  # fixed argv, no shell
            list(args),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            input=input,
            stdin=None if input is not None else subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return CommandResult(127, "", f"{type(e).__name__}: {e}")
    return CommandResult(done.returncode, done.stdout or "", done.stderr or "")


def _clip(text: str, limit: int = MAX_MESSAGE) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


LOOKUP = object()  # MacNotifier: find terminal-notifier on PATH / in the Homebrew dirs


def find_terminal_notifier() -> str | None:
    path = os.pathsep.join([os.environ.get("PATH", ""), *EXTRA_BIN_DIRS])
    return shutil.which("terminal-notifier", path=path)


_OSASCRIPT = (
    "on run argv",
    "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
    "end run",
)


class MacNotifier:
    """terminal-notifier if present (``prefer``), else osascript. ``open_links``: a click on a
    terminal-notifier notification opens its ``finanse://`` link (only useful when Finanse.app,
    which handles the scheme, is installed; osascript notifications cannot carry a link)."""

    def __init__(
        self,
        *,
        prefer: str = "auto",
        runner: CommandRunner = run_command,
        terminal_notifier: str | None | Callable[[], str | None] | object = LOOKUP,
        open_links: bool = False,
    ) -> None:
        if prefer not in ("auto", "terminal-notifier", "osascript"):
            raise ValueError(f"Unknown macOS notifier {prefer!r}")
        self._runner = runner
        self._open_links = open_links
        # LOOKUP = search now (late-bound, so a replaced ``find_terminal_notifier`` is used);
        # None = not installed.
        if terminal_notifier is LOOKUP:
            tn = find_terminal_notifier()
        elif callable(terminal_notifier):
            tn = terminal_notifier()
        else:
            tn = terminal_notifier
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
            if self._open_links and n.url and n.url.startswith(f"{LINK_SCHEME}://"):
                args += ["-open", n.url]
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
        link = f" <{notification.url}>" if notification.url else ""
        self._echo("[powiadomienie] " + " | ".join(p for p in parts if p) + link)
        self.sent.append(notification)
        return Delivery(True, self.name)


class WindowsToastNotifier:
    """Windows toast notifications (later): same seam, not implemented yet."""

    name = "windows-toast"

    def send(self, notification: Notification) -> Delivery:
        return Delivery(False, self.name, "Windows notifications are not implemented yet")


def default_notifier(name: str = "auto", *, platform: str | None = None) -> Notifier | None:
    """The notifier for ``name`` (``auto`` = the platform's own); ``none`` -> None (no delivery).

    macOS ``auto``: through Finanse.app when it is found (falling back to terminal-notifier /
    osascript when the app cannot post), else terminal-notifier, else osascript; ``app`` forces
    the app (ValueError when there is none)."""
    platform = platform or sys.platform
    if name not in NOTIFIER_NAMES:
        raise ValueError(f"Unknown notifier {name!r}; choose one of {', '.join(NOTIFIER_NAMES)}")
    if name == "none":
        return None
    if name == "log":
        return LogNotifier()
    if platform == "darwin":
        if name in ("auto", "app"):
            from . import notifier_app

            app = notifier_app.find_app_bundle()
            if app is not None:
                fallback = MacNotifier(open_links=True) if name == "auto" else None
                return notifier_app.AppNotifier(app, fallback=fallback)
            if name == "app":
                raise ValueError(notifier_app.NOT_FOUND)
        return MacNotifier(prefer=name)
    if name != "auto":
        raise ValueError(f"Notifier {name!r} needs macOS")
    if platform == "win32":
        return WindowsToastNotifier()
    return LogNotifier()
