"""scripts/bump_version.py (run by .github/workflows/bump-version.yml after a push to main): the bump
rules, the version lines it rewrites, and the skip cases against a throwaway git repository."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "bump_version.py"

_spec = importlib.util.spec_from_file_location("bump_version", SCRIPT)
bv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bv)


@pytest.mark.parametrize(
    ("version", "level", "new"),
    [("0.1.0", "patch", "0.1.1"), ("0.1.9", "patch", "0.1.10"), ("0.1.4", "minor", "0.2.0"),
     ("0.9.4", "major", "1.0.0")],
)
def test_bump(version, level, new):
    assert bv.bump(version, level) == new


@pytest.mark.parametrize(
    ("messages", "level"),
    [("Fix a typo", "patch"), ("Add alerts\n\n[minor]", "minor"), ("Rework [MAJOR]", "major"),
     ("one [minor]\ntwo [major]", "major"), ("Docs only [skip bump]", None)],
)
def test_level_from_messages(messages, level):
    assert bv.level_from_messages(messages) == level


def test_the_real_files_carry_matching_version_lines():
    py = bv.read_version(bv.PYPROJECT.read_text(), bv.PYPROJECT_RE)
    init = bv.read_version(bv.INIT.read_text(), bv.INIT_RE)
    assert py is not None and py == init


def test_replace_touches_only_the_project_version():
    text = '[project]\nname = "finanse"\nversion = "0.1.0"\n\n[tool.ruff]\ntarget-version = "py312"\n'
    out = bv.replace_version(text, bv.PYPROJECT_RE, "0.1.1")
    assert out == text.replace('version = "0.1.0"', 'version = "0.1.1"')


# --------------------------------------------------------------------------- #
# End to end in a temp git repository
# --------------------------------------------------------------------------- #

@pytest.fixture
def repo(tmp_path):
    if shutil.which("git") is None:
        pytest.skip("git not installed")
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / "bump_version.py")
    (tmp_path / "src" / "finanse").mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "finanse"\nversion = "0.3.4"\n')
    (tmp_path / "src" / "finanse" / "__init__.py").write_text('"""x."""\n\n__version__ = "0.3.4"\n')
    for args in (["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]):
        subprocess.run(["git", *args], cwd=tmp_path, check=True)
    commit(tmp_path, "Initial")
    return tmp_path


def commit(root: Path, message: str) -> str:
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", message], cwd=root, check=True)
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True,
                          text=True).stdout.strip()


def run(root: Path, *args: str) -> str:
    r = subprocess.run(["python3", "scripts/bump_version.py", *args], cwd=root, check=True,
                       capture_output=True, text=True)
    return r.stdout.strip()


def versions(root: Path) -> tuple[str, str]:
    return (bv.read_version((root / "pyproject.toml").read_text(), bv.PYPROJECT_RE),
            bv.read_version((root / "src/finanse/__init__.py").read_text(), bv.INIT_RE))


def test_push_bumps_patch_in_both_files(repo):
    before = commit(repo, "Base")
    commit(repo, "Fix a bug")
    assert run(repo, "--since", before) == "0.3.5"
    assert versions(repo) == ("0.3.5", "0.3.5")


def test_minor_marker_in_any_pushed_commit(repo):
    before = commit(repo, "Base")
    commit(repo, "Add a module [minor]")
    commit(repo, "Fix its tests")
    assert run(repo, "--since", before) == "0.4.0"


def test_first_push_reads_only_the_head_message(repo):
    commit(repo, "Old [major]")
    commit(repo, "Head")
    assert run(repo, "--since", "0" * 40) == "0.3.5"


def test_hand_made_version_change_is_kept(repo):
    before = commit(repo, "Base")
    (repo / "pyproject.toml").write_text('[project]\nname = "finanse"\nversion = "1.0.0"\n')
    (repo / "src/finanse/__init__.py").write_text('__version__ = "1.0.0"\n')
    commit(repo, "Release 1.0")
    assert run(repo, "--since", before) == ""
    assert versions(repo) == ("1.0.0", "1.0.0")


def test_skip_bump_marker(repo):
    before = commit(repo, "Base")
    commit(repo, "Docs [skip bump]")
    assert run(repo, "--since", before) == ""
    assert versions(repo) == ("0.3.4", "0.3.4")
