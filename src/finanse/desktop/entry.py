"""Entry point of the packaged app (``Finanse.app/Contents/MacOS/finanse``, PyInstaller).

One binary serves every use:

- no arguments (opened from Finder or the Dock; old macOS versions add a ``-psn_...`` argument):
  ``finanse app``, the desktop window;
- ``--notify-helper``: post one notification (JSON on stdin) through the app bundle, for the
  worker (``desktop/notify.py``; UserNotifications needs the bundle's identity). It skips the CLI
  imports, so it starts fast;
- anything else: the finanse CLI (``worker run``, ``mcp --profile <slug>``, ``invest run``, ...),
  which is what the launchd agent and Claude Code / Claude Desktop call.
"""

from __future__ import annotations

import sys


def _clean(argv: list[str]) -> list[str]:
    return [a for a in argv if not a.startswith("-psn_")]


NOTIFY_HELPER = "--notify-helper"  # = core.worker.notifier_app.HELPER_ARG


def main(argv: list[str] | None = None) -> None:
    args = _clean(list(sys.argv[1:] if argv is None else argv))
    if args[:1] == [NOTIFY_HELPER]:
        from finanse.desktop.notify import helper_main

        raise SystemExit(helper_main(args[1:]))
    from finanse.cli import app

    app(args=args or ["app"], prog_name="finanse")


if __name__ == "__main__":  # pragma: no cover
    main()
