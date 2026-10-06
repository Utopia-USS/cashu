#!/usr/bin/env python3
"""Bump the app version after a push to main (run by .github/workflows/bump-version.yml).

The version lives in two places that must agree: ``project.version`` in ``pyproject.toml`` (what the
app's update check reads on GitHub, see ``src/finanse/core/updates.py``) and ``__version__`` in
``src/finanse/__init__.py`` (what the running app reports). This script raises both:

- the patch number by default (0.1.0 -> 0.1.1);
- the minor or major number when a pushed commit message contains ``[minor]`` or ``[major]``;
- nothing when the push already changed the version by hand (``--since`` names the commit before the
  push) or a commit message contains ``[skip bump]``.

    python scripts/bump_version.py --since <sha before the push>   # prints the new version or nothing
    python scripts/bump_version.py --dry-run                         # show what would happen

Standard library only, so the workflow needs no install step.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"
INIT = ROOT / "src" / "finanse" / "__init__.py"

PYPROJECT_RE = re.compile(r'^(version\s*=\s*")(\d+\.\d+\.\d+)(")', re.MULTILINE)
INIT_RE = re.compile(r'^(__version__\s*=\s*")(\d+\.\d+\.\d+)(")', re.MULTILINE)
NULL_SHA = re.compile(r"^0+$")


def read_version(text: str, pattern: re.Pattern[str]) -> str | None:
    m = pattern.search(text)
    return m.group(2) if m else None


def bump(version: str, level: str) -> str:
    major, minor, patch = (int(p) for p in version.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def level_from_messages(messages: str) -> str | None:
    """``major`` / ``minor`` / ``patch`` from the pushed commit messages; None for ``[skip bump]``."""
    lowered = messages.lower()
    if "[skip bump]" in lowered:
        return None
    if "[major]" in lowered:
        return "major"
    if "[minor]" in lowered:
        return "minor"
    return "patch"


def replace_version(text: str, pattern: re.Pattern[str], new: str) -> str:
    out, n = pattern.subn(lambda m: f"{m.group(1)}{new}{m.group(3)}", text, count=1)
    if n != 1:
        raise SystemExit(f"error: no version line matching {pattern.pattern!r}")
    return out


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def pushed_range(since: str | None) -> str | None:
    """``<since>..HEAD`` when ``since`` is a commit this clone knows; None for a new branch / first push."""
    if not since or NULL_SHA.match(since):
        return None
    try:
        git("cat-file", "-e", f"{since}^{{commit}}")
    except subprocess.CalledProcessError:
        return None
    return f"{since}..HEAD"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", help="the commit before the push (github.event.before)")
    ap.add_argument("--dry-run", action="store_true", help="print the decision, change nothing")
    args = ap.parse_args(argv)

    py_text, init_text = PYPROJECT.read_text(), INIT.read_text()
    current = read_version(py_text, PYPROJECT_RE)
    if current is None or read_version(init_text, INIT_RE) is None:
        print("error: no X.Y.Z version in pyproject.toml or src/finanse/__init__.py", file=sys.stderr)
        return 1
    if read_version(init_text, INIT_RE) != current:
        print(f"error: pyproject.toml ({current}) and __init__.py disagree", file=sys.stderr)
        return 1

    rng = pushed_range(args.since)
    if rng is not None:
        before = read_version(git("show", f"{args.since}:pyproject.toml"), PYPROJECT_RE)
        if before != current:
            print(f"skip: the push changed the version by hand ({before} -> {current})", file=sys.stderr)
            return 0
        messages = git("log", "--format=%B", rng)
    else:
        messages = git("log", "-1", "--format=%B")

    level = level_from_messages(messages)
    if level is None:
        print("skip: [skip bump] in a pushed commit message", file=sys.stderr)
        return 0
    new = bump(current, level)
    if args.dry_run:
        print(f"{current} -> {new} ({level})", file=sys.stderr)
        return 0
    PYPROJECT.write_text(replace_version(py_text, PYPROJECT_RE, new))
    INIT.write_text(replace_version(init_text, INIT_RE, new))
    print(new)
    return 0


if __name__ == "__main__":
    sys.exit(main())
