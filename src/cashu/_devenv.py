"""Development defaults of a source checkout: ``<checkout>/.env.dev`` (git-ignored).

A developer who also uses cashU for real keeps the checkout away from the real data dir by putting
``CASHU_DATA_DIR`` (and ``CASHU_WORKSPACES_DIR``, ``CASHU_AUTO_DAILY``, ...) into ``.env.dev`` at
the checkout root. It is read when the package is imported, before anything resolves a path, and
fills only ``CASHU_*`` variables the environment does not set already (the shell always wins).

A linked git worktree (``git worktree add``, an agent's worktree) has no copy of the untracked file,
so it also reads the main checkout's ``.env.dev``: a fresh venv in a worktree cannot silently fall
back to the real data dir. Nothing is read in the packaged app (no checkout) or under the test
suite (``CASHU_TESTING``; ``tests/conftest.py`` isolates everything itself).

Lines are ``KEY=VALUE``; blank lines and ``#`` comments are skipped; ``~`` at the start of a value is
expanded; quotes around a value are stripped.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

FILENAME = ".env.dev"
PREFIX = "CASHU_"


def _checkout_root() -> Path | None:
    root = Path(__file__).resolve().parents[2]  # src/cashu/_devenv.py -> the checkout
    return root if (root / "pyproject.toml").is_file() and (root / ".git").exists() else None


def _main_checkout(root: Path) -> Path | None:
    """The main checkout of a linked worktree (its ``.git`` is a file pointing into
    ``<main>/.git/worktrees/<name>``); None for a main checkout or anything unexpected."""
    git = root / ".git"
    if not git.is_file():
        return None
    try:
        first = git.read_text(encoding="utf-8").splitlines()[0]
    except (OSError, IndexError):
        return None
    if not first.startswith("gitdir:"):
        return None
    gitdir = Path(first.removeprefix("gitdir:").strip())
    if not gitdir.is_absolute():
        gitdir = (root / gitdir).resolve()
    if gitdir.parent.name != "worktrees" or gitdir.parent.parent.name != ".git":
        return None
    return gitdir.parent.parent.parent


def _parse(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if not key.startswith(PREFIX):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value.startswith("~"):
            value = os.path.expanduser(value)
        values[key] = value
    return values


def files() -> list[Path]:
    """The ``.env.dev`` files that apply, nearest first (the worktree's, then the main checkout's)."""
    root = _checkout_root()
    if root is None:
        return []
    found = [root / FILENAME]
    main = _main_checkout(root)
    if main is not None:
        found.append(main / FILENAME)
    return [p for p in found if p.is_file()]


def load(environ: dict[str, str] | None = None) -> list[Path]:
    """Fill unset ``CASHU_*`` variables from the applicable ``.env.dev`` files; returns the files
    read. A no-op in the packaged app and under the test suite."""
    env = os.environ if environ is None else environ
    if getattr(sys, "frozen", False) or env.get("CASHU_TESTING"):
        return []
    read = files()
    for path in read:
        for key, value in _parse(path).items():
            env.setdefault(key, value)
    return read
