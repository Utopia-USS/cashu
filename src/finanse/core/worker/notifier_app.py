"""Notifications through the packaged app (macOS): shown as Finanse, with the app icon.

``UNUserNotificationCenter`` (the UserNotifications framework) only works in a process that runs
from an app bundle, and the bundle's identity is what macOS shows (name, icon, the user's
notification settings). The worker therefore hands each notification to a small helper mode of
the bundled binary::

    Finanse.app/Contents/MacOS/finanse --notify-helper      (the notification as JSON on stdin)

The helper (``finanse.desktop.notify.helper_main``) asks for permission on first use, posts the
notification with its ``finanse://`` link and answers with one JSON line and an exit code. The
texts travel as JSON on stdin, never as a script or a command line that could be re-interpreted.

Which app: ``FINANSE_APP_BUNDLE`` (a path to ``Finanse.app``; ``none`` turns the app path off) >
the bundle this process runs from (the worker started by launchd from the app) >
``/Applications/Finanse.app`` > ``~/Applications/Finanse.app``. Only a bundle whose Info.plist
declares the helper (``FinanseNotificationHelper``) is used, so an older build without it is
never asked.

When the user denied notifications for Finanse, or has not answered the permission prompt yet,
nothing is routed around that choice: the delivery fails (the worker retries on its next run).
Other failures (the helper missing or crashing) fall back to ``fallback`` (terminal-notifier /
osascript) so the signal still reaches the user.
"""

from __future__ import annotations

import json
import logging
import os
import plistlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .notifier import CommandResult, Delivery, Notification, Notifier, _clip, run_command

APP_NAME = "Finanse.app"
APP_ENV = "FINANSE_APP_BUNDLE"
HELPER_ARG = "--notify-helper"
INFO_PLIST_KEY = "FinanseNotificationHelper"
HELPER_TIMEOUT = 75.0  # seconds; the helper itself waits at most ~40 s (permission prompt + post)
TITLE_PREFIX = "finanse: "  # notifications.title(); the app's own name is shown above anyway

# Helper exit codes (and the ``status`` of its JSON answer).
EXIT_DELIVERED = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_DENIED = 3
EXIT_PENDING = 4
EXIT_UNAVAILABLE = 5
STATUS_BY_EXIT = {
    EXIT_DELIVERED: "delivered",
    EXIT_FAILED: "failed",
    EXIT_USAGE: "usage",
    EXIT_DENIED: "denied",
    EXIT_PENDING: "pending",
    EXIT_UNAVAILABLE: "unavailable",
}
EXIT_BY_STATUS = {status: code for code, status in STATUS_BY_EXIT.items()}

DENIED_HINT = "notifications for Finanse are turned off (System Settings > Notifications > Finanse)"
PENDING_HINT = (
    "waiting for permission: allow notifications for Finanse in the prompt or in "
    "System Settings > Notifications"
)
NOT_FOUND = (
    "Finanse.app with native notifications not found (install it in /Applications or set "
    f"{APP_ENV} to its path)"
)

_log = logging.getLogger("finanse.worker")


@dataclass(frozen=True)
class AppBundle:
    path: Path
    executable: Path


def inspect_bundle(path: Path) -> AppBundle | None:
    """``path`` as a Finanse.app that has the notification helper, else None."""
    try:
        with (path / "Contents" / "Info.plist").open("rb") as f:
            info = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    if not isinstance(info, dict) or not info.get(INFO_PLIST_KEY):
        return None
    name = info.get("CFBundleExecutable") or "finanse"
    if not isinstance(name, str) or "/" in name:
        return None
    exe = path / "Contents" / "MacOS" / name
    if not exe.is_file() or not os.access(exe, os.X_OK):
        return None
    return AppBundle(path, exe)


def default_candidates() -> list[Path]:
    return [Path("/Applications") / APP_NAME, Path.home() / "Applications" / APP_NAME]


def find_app_bundle(
    *,
    env: Mapping[str, str] | None = None,
    own: Callable[[], Path | None] | None = None,
    candidates: Sequence[Path] | None = None,
) -> AppBundle | None:
    """The Finanse.app the worker posts notifications through (see the module doc), or None."""
    env = os.environ if env is None else env
    raw = env.get(APP_ENV, "").strip()
    if raw.lower() == "none":
        return None
    if raw:
        return inspect_bundle(Path(raw).expanduser())
    if own is None:
        from .. import runtime

        own = runtime.app_bundle
    mine = own()
    if mine is not None:
        found = inspect_bundle(mine)
        if found is not None:
            return found
    for candidate in default_candidates() if candidates is None else candidates:
        found = inspect_bundle(candidate)
        if found is not None:
            return found
    return None


# --------------------------------------------------------------------------- #
# The notifier
# --------------------------------------------------------------------------- #

HelperRunner = Callable[[Sequence[str], str], CommandResult]


def run_helper(args: Sequence[str], data: str) -> CommandResult:
    return run_command(args, timeout=HELPER_TIMEOUT, input=data)


def payload(n: Notification) -> dict:
    """What the helper gets on stdin (clipped like the other notifiers)."""
    title = n.title.removeprefix(TITLE_PREFIX)
    return {
        "title": _clip(title or "finanse", 80),
        "subtitle": _clip(n.subtitle or "", 80),
        "message": _clip(n.message),
        "group": n.group,
        "url": n.url,
    }


def parse_answer(result: CommandResult) -> tuple[str, str | None]:
    """(status, error) from the helper's JSON line; the exit code when there is none."""
    for line in reversed((result.stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("status") in EXIT_BY_STATUS:
            error = data.get("error")
            return data["status"], str(error)[:300] if error else None
    status = STATUS_BY_EXIT.get(result.returncode, "failed")
    detail = (result.stderr or result.stdout or "").strip()[:300]
    return status, f"exit {result.returncode}: {detail}" if detail else f"exit {result.returncode}"


class AppNotifier:
    """Posts through Finanse.app's notification helper; ``fallback`` takes over when the app
    cannot post (never when the user denied notifications or the prompt is still open)."""

    name = "app"

    def __init__(
        self,
        app: AppBundle,
        *,
        fallback: Notifier | None = None,
        runner: HelperRunner = run_helper,
    ) -> None:
        self.app = app
        self._fallback = fallback
        self._runner = runner

    def command(self) -> list[str]:
        return [str(self.app.executable), HELPER_ARG]

    def send(self, notification: Notification) -> Delivery:
        data = json.dumps(payload(notification), ensure_ascii=False)
        status, error = parse_answer(self._runner(self.command(), data))
        if status == "delivered":
            return Delivery(True, self.name)
        if status == "denied":
            return Delivery(False, self.name, DENIED_HINT)
        if status == "pending":
            return Delivery(False, self.name, PENDING_HINT)
        detail = f"{status}: {error}" if error else status
        if self._fallback is None:
            return Delivery(False, self.name, f"Finanse.app could not post ({detail})")
        _log.warning(
            "Finanse.app could not post a notification (%s); using %s",
            detail,
            self._fallback.name,
        )
        return self._fallback.send(notification)
