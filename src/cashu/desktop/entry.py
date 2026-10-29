"""Entry point of the packaged app (``cashU.app/Contents/MacOS/cashu``, PyInstaller).

One binary serves every use:

- no arguments (opened from Finder or the Dock; old macOS versions add a ``-psn_...`` argument):
  ``cashu app``, the desktop window;
- ``--notify-helper``: post one notification (JSON on stdin) through the app bundle, for the
  worker (``desktop/notify.py``; UserNotifications needs the bundle's identity). It skips the CLI
  imports, so it starts fast;
- ``--landlock-exec <policy> -- <argv>`` (Linux): restrict itself with Landlock and ``exec`` a connector
  (``core/connectors/landlock_exec.py``, started by ``sandbox_linux.LinuxSandbox``). Imports nothing else;
- anything else: the cashU CLI (``worker run``, ``mcp --profile <slug>``, ``invest run``, ...),
  which is what the launchd agent and Claude Code / Claude Desktop call.
"""

from __future__ import annotations

import sys


def _clean(argv: list[str]) -> list[str]:
    return [a for a in argv if not a.startswith("-psn_")]


NOTIFY_HELPER = "--notify-helper"  # = core.worker.notifier_app.HELPER_ARG
LANDLOCK_EXEC = "--landlock-exec"  # = core.connectors.sandbox_linux.LAUNCHER_ARG


def main(argv: list[str] | None = None) -> None:
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw[:1] == [LANDLOCK_EXEC]:  # before _clean: the connector's arguments pass through untouched
        from cashu.core.connectors.landlock_exec import main as landlock_main

        raise SystemExit(landlock_main(raw[1:]))
    from cashu.core import runtime

    runtime.remember_bundle()  # before anything loads: an update may replace the app later
    args = _clean(raw)
    if args[:1] == [NOTIFY_HELPER]:
        from cashu.desktop.notify import helper_main

        raise SystemExit(helper_main(args[1:]))
    from cashu.cli import app

    app(args=args or ["app"], prog_name="cashu")


if __name__ == "__main__":  # pragma: no cover
    main()
