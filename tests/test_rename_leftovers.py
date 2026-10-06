"""F11: the app is cashU. No "finanse" (the pre-rename name) is left in the repository outside an
allowlist: whole files with a reason, lines carrying the ``legacy name`` marker (on the line or one
of the two lines above: compatibility code, deprecated ids in docs), and the Polish word FINANSE in
upper case (bank and merchant texts the categorizer matches), and the README credit line."""

from __future__ import annotations

import fnmatch
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WORD = re.compile(r"finanse", re.IGNORECASE)
POLISH_WORD = re.compile(r"\bFINANSE\b")
MARKER = "legacy name"
CREDIT = "github.com/SynSzakala/finanse"  # the README credit line to the original project
FILES = {
    "LICENSE": "the original project's copyright line (attribution)",
    "src/cashu/core/migrations/versions/*": "Alembic history is immutable",
    "src/cashu/core/migrate_legacy.py": "moves pre-rename installs: every occurrence is the old name",
    "src/cashu/core/env.py": "the CASHU_* readers with their FINANSE_* fallback",
    "tests/test_migrate_legacy.py": "tests of that migration",
    "tests/test_rename_leftovers.py": "this test",
    "frontend/tests/storage.test.mjs": "tests of the finanse.* -> cashu.* browser storage fallback",
}


def _files() -> list[str]:
    if shutil.which("git") is None or not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [f for f in out.splitlines() if f and (ROOT / f).is_file()]


def _allowed_file(rel: str) -> bool:
    return any(fnmatch.fnmatch(rel, pattern) for pattern in FILES)


def test_no_finanse_left_outside_the_allowlist():
    found: list[str] = []
    for rel in _files():
        if _allowed_file(rel):
            continue
        if WORD.search(rel):
            found.append(f"{rel}: file name")
        try:
            lines = (ROOT / rel).read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(lines):
            if not WORD.search(line):
                continue
            if all(POLISH_WORD.match(line, m.start()) for m in WORD.finditer(line)):
                continue
            if CREDIT in line or any(MARKER in lines[j] for j in range(max(0, i - 2), i + 1)):
                continue
            found.append(f"{rel}:{i + 1}: {line.strip()[:120]}")
    assert not found, "pre-rename name left (rename it, or mark compat code with 'legacy name'):\n" + "\n".join(found)
