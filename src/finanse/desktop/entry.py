"""Entry point of the packaged app (``Finanse.app/Contents/MacOS/finanse``, PyInstaller).

One binary serves every use:

- no arguments (opened from Finder or the Dock; old macOS versions add a ``-psn_...`` argument):
  ``finanse app``, the desktop window;
- ``-I <script.py> [args...]``: run a converter script with the embedded Python, the way
  ``core/mcp/tools/converters.py`` starts it (``sys.executable -I script input output``); a frozen
  app has no separate interpreter. Isolation stays as in a checkout: PyInstaller ignores
  ``PYTHON*`` variables and user site-packages, and the caller passes an empty environment, a
  temporary working directory and a timeout. Scripts can use the standard library modules bundled
  with the app;
- anything else: the finanse CLI (``worker run``, ``mcp --profile <slug>``, ``invest run``, ...),
  which is what the launchd agent and Claude Code / Claude Desktop call.
"""

from __future__ import annotations

import sys


def _clean(argv: list[str]) -> list[str]:
    return [a for a in argv if not a.startswith("-psn_")]


def is_script_call(argv: list[str]) -> bool:
    return len(argv) >= 2 and argv[0] == "-I" and argv[1].endswith(".py")


def run_script(path: str, args: list[str]) -> None:
    """``python -I path args...`` with this interpreter (SystemExit propagates as the exit code)."""
    import runpy

    sys.argv = [path, *args]
    runpy.run_path(path, run_name="__main__")


def main(argv: list[str] | None = None) -> None:
    args = _clean(list(sys.argv[1:] if argv is None else argv))
    if is_script_call(args):
        run_script(args[1], args[2:])
        return
    from finanse.cli import app

    app(args=args or ["app"], prog_name="finanse")


if __name__ == "__main__":  # pragma: no cover
    main()
