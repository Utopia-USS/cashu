"""A source checkout's .env.dev keeps development off the real data dir, also in git worktrees."""

from pathlib import Path

from cashu import _devenv


def _checkout(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (path / ".git").mkdir()
    return path


def _worktree(main: Path, path: Path, name: str = "agent-x") -> Path:
    path.mkdir(parents=True)
    (path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    gitdir = main / ".git" / "worktrees" / name
    gitdir.mkdir(parents=True)
    (path / ".git").write_text(f"gitdir: {gitdir}\n", encoding="utf-8")
    return path


def test_parse_takes_only_cashu_keys(tmp_path):
    f = tmp_path / ".env.dev"
    f.write_text(
        "# dev defaults\n\nCASHU_DATA_DIR=~/demo-data\nexport CASHU_AUTO_DAILY = 0\n"
        "CASHU_WORKSPACES_DIR=\"/tmp/ws dir\"\nHOME=/elsewhere\nnot a line\n",
        encoding="utf-8",
    )
    values = _devenv._parse(f)
    assert values["CASHU_DATA_DIR"].endswith("/demo-data") and not values["CASHU_DATA_DIR"].startswith("~")
    assert values["CASHU_AUTO_DAILY"] == "0"
    assert values["CASHU_WORKSPACES_DIR"] == "/tmp/ws dir"
    assert "HOME" not in values


def test_a_worktree_reads_the_main_checkouts_file(tmp_path, monkeypatch):
    main = _checkout(tmp_path / "main")
    (main / ".env.dev").write_text("CASHU_DATA_DIR=/demo/data\nCASHU_AUTO_DAILY=0\n", encoding="utf-8")
    wt = _worktree(main, main / ".claude" / "worktrees" / "agent-x")
    monkeypatch.setattr(_devenv, "_checkout_root", lambda: wt)
    assert _devenv.files() == [main / ".env.dev"]
    env: dict[str, str] = {}
    assert _devenv.load(env) == [main / ".env.dev"]
    assert env == {"CASHU_DATA_DIR": "/demo/data", "CASHU_AUTO_DAILY": "0"}


def test_the_worktrees_own_file_wins_and_the_shell_wins_over_both(tmp_path, monkeypatch):
    main = _checkout(tmp_path / "main")
    (main / ".env.dev").write_text("CASHU_DATA_DIR=/main\nCASHU_AUTO_DAILY=0\n", encoding="utf-8")
    wt = _worktree(main, tmp_path / "wt")
    (wt / ".env.dev").write_text("CASHU_DATA_DIR=/wt\n", encoding="utf-8")
    monkeypatch.setattr(_devenv, "_checkout_root", lambda: wt)
    env = {"CASHU_AUTO_DAILY": "1"}
    _devenv.load(env)
    assert env == {"CASHU_DATA_DIR": "/wt", "CASHU_AUTO_DAILY": "1"}


def test_nothing_is_read_under_tests_in_the_packaged_app_or_outside_a_checkout(tmp_path, monkeypatch):
    main = _checkout(tmp_path / "main")
    (main / ".env.dev").write_text("CASHU_DATA_DIR=/demo\n", encoding="utf-8")
    monkeypatch.setattr(_devenv, "_checkout_root", lambda: main)
    env = {"CASHU_TESTING": "1"}
    assert _devenv.load(env) == [] and "CASHU_DATA_DIR" not in env
    monkeypatch.setattr(_devenv.sys, "frozen", True, raising=False)
    env = {}
    assert _devenv.load(env) == [] and env == {}
    monkeypatch.setattr(_devenv.sys, "frozen", False, raising=False)
    monkeypatch.setattr(_devenv, "_checkout_root", lambda: None)
    assert _devenv.files() == []


def test_an_unexpected_git_file_is_not_followed(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text("gitdir: /somewhere/else/modules/sub\n", encoding="utf-8")
    assert _devenv._main_checkout(wt) is None
    (wt / ".git").write_text("", encoding="utf-8")
    assert _devenv._main_checkout(wt) is None


def test_the_package_is_importable_from_this_checkout():
    # under the suite CASHU_TESTING is set, so importing cashu never pointed anything at .env.dev
    import os

    assert os.environ["CASHU_DATA_DIR"].startswith(str(Path(os.environ["HOME"]).parent))
