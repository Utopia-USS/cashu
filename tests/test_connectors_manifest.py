"""Connector manifest validation, directory rules, content hash and interpreter resolution (F10)."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
import yaml
from connector_support import needs_python3, write_connector

from cashu.core.connectors import manifest as mf

BASE = {
    "api_version": 1,
    "id": "xtb-csv",
    "name": "XTB eksport CSV",
    "version": "0.1.0",
    "module": "investments",
    "kind": "file",
    "run": ["python3", "connector.py"],
    "file": {"extensions": ["csv", "xlsx"]},
}
FETCH = {
    **{k: v for k, v in BASE.items() if k != "file"},
    "id": "api-fetch",
    "kind": "fetch",
    "fetch": {
        "hosts": ["api.example.com"],
        "secrets": [{"id": "api_key", "label": "Klucz API (tylko odczyt)"}],
        "params": [{"id": "start", "label": "Od daty", "type": "date", "required": False}],
        "history_days": 365,
    },
}


def _with(base: dict, **changes) -> dict:
    data = {**base}
    for key, value in changes.items():
        if value is ...:
            data.pop(key, None)
        else:
            data[key] = value
    return data


def _issues(data) -> list[str]:
    with pytest.raises(mf.ManifestError) as e:
        mf.manifest_from_data(data)
    return list(e.value.issues)


def test_valid_file_and_fetch_manifests():
    m = mf.manifest_from_data(BASE)
    assert (m.id, m.kind, m.timeout_s, m.extensions) == ("xtb-csv", "file", 60, ("csv", "xlsx"))
    f = mf.manifest_from_data(FETCH)
    assert f.hosts == ("api.example.com",) and f.secret_ids == ("api_key",)
    assert f.fetch.history_days == 365
    assert mf.parse_manifest(yaml.safe_dump(BASE)) == m


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({"api_version": 2}, "api_version"),
        ({"id": "X"}, "id"),
        ({"id": "a"}, "id"),  # too short
        ({"id": "a" * 41}, "id"),
        ({"id": "9abc"}, "id"),
        ({"name": "n" * 61}, "name"),
        ({"name": ""}, "name"),
        ({"version": "v" * 21}, "version"),
        ({"author": "a" * 81}, "author"),
        ({"description": "d" * 281}, "description"),
        ({"module": "loans"}, "module"),
        ({"kind": "stream"}, "kind"),
        ({"run": []}, "run"),
        ({"run": ["python3"] + ["x"] * 8}, "run"),
        ({"run": ["bash", "x.sh"]}, "not an allowed interpreter"),
        ({"run": ["python", "x.py"]}, 'did you mean "python3"'),
        ({"run": ["/usr/bin/python3", "x.py"]}, "absolute paths"),
        ({"run": ["python3", "../x.py"]}, "`..`"),
        ({"run": ["python3", "a/../../x.py"]}, "`..`"),
        ({"run": ["python3", "~/x.py"]}, "absolute paths"),
        ({"run": ["python3", "a\nb"]}, "control characters"),
        ({"run": ["python3", "x" * 201]}, "longer than"),
        ({"run": ["./"]}, "./ must name a file"),
        ({"timeout_s": 0}, "timeout_s"),
        ({"timeout_s": 601}, "timeout_s"),
        ({"file": ...}, "kind file needs a `file` section"),
        ({"file": {"extensions": []}}, "extensions"),
        ({"file": {"extensions": [".csv"]}}, "extensions"),
        ({"file": {"extensions": ["CSV"]}}, "extensions"),
        ({"fetch": FETCH["fetch"]}, "no `fetch` section"),
    ],
)
def test_manifest_limits(changes, expected):
    issues = _issues(_with(BASE, **changes))
    assert any(expected in issue for issue in issues), issues


@pytest.mark.parametrize(
    ("fetch", "expected"),
    [
        ({"hosts": []}, "hosts"),
        ({"hosts": [f"h{i}.example.com" for i in range(11)]}, "hosts"),
        ({"hosts": ["*.example.com"]}, "exact lower-case host name"),
        ({"hosts": ["https://api.example.com"]}, "exact lower-case host name"),
        ({"hosts": ["api.example.com:443"]}, "exact lower-case host name"),
        ({"hosts": ["API.example.com"]}, "exact lower-case host name"),
        ({"hosts": ["127.0.0.1"]}, "exact lower-case host name"),
        ({"hosts": ["localhost"]}, "exact lower-case host name"),
        ({"hosts": ["a.example.com", "a.example.com"]}, "listed twice"),
        ({"hosts": ["a.example.com"], "secrets": [{"id": f"s{i}", "label": "x"} for i in range(6)]},
         "secrets"),
        ({"hosts": ["a.example.com"], "secrets": [{"id": "k", "label": "x"}, {"id": "k", "label": "y"}]},
         "listed twice"),
        ({"hosts": ["a.example.com"], "secrets": [{"id": "Key", "label": "x"}]}, "secrets"),
        ({"hosts": ["a.example.com"], "params": [{"id": f"p{i}", "label": "x"} for i in range(11)]},
         "params"),
        ({"hosts": ["a.example.com"], "params": [{"id": "p", "label": "x", "type": "json"}]}, "type"),
        ({"hosts": ["a.example.com"], "history_days": 3651}, "history_days"),
        ({"hosts": ["a.example.com"], "history_days": 0}, "history_days"),
    ],
)
def test_fetch_limits(fetch, expected):
    issues = _issues(_with(FETCH, fetch=fetch))
    assert any(expected in issue for issue in issues), issues


def test_unknown_keys_are_errors_with_did_you_mean():
    data = _with(BASE, timout_s=30, file={"extensions": ["csv"], "extension": ["x"]})
    issues = _issues(data)
    assert 'timout_s: unknown key (did you mean "timeout_s"?)' in issues
    assert 'file.extension: unknown key (did you mean "extensions"?)' in issues
    nested = _with(FETCH, fetch={**FETCH["fetch"], "secrets": [{"id": "k", "labl": "x"}]})
    assert any('fetch.secrets[0].labl: unknown key (did you mean "label"?)' in i for i in _issues(nested))


def test_bad_yaml_and_non_mapping():
    with pytest.raises(mf.ManifestError, match="not valid YAML"):
        mf.parse_manifest("a: [b")
    with pytest.raises(mf.ManifestError, match="mapping"):
        mf.parse_manifest("- a\n- b\n")
    with pytest.raises(mf.ManifestError, match="larger than"):
        mf.parse_manifest("a: " + "x" * (mf.MAX_MANIFEST_BYTES + 1))


# --------------------------------------------------------------------------- #
# Directory rules and hash
# --------------------------------------------------------------------------- #


def test_scan_and_hash_are_stable_and_detect_changes(tmp_path):
    root = write_connector(tmp_path / "c", extra={"lib/util.py": "X = 1\n", ".gitignore": "*.pyc\n"})
    files = mf.scan_dir(root)
    assert [f.path for f in files] == [".gitignore", "connector.yaml", "lib/util.py", "main.py"]
    first = mf.content_sha256(files)
    assert mf.content_sha256(reversed(files)) == first  # order-independent
    assert mf.content_sha256(mf.scan_dir(root)) == first
    expected_lines = sorted(f"{f.path}\0{f.sha256}\n" for f in files)
    import hashlib

    assert first == hashlib.sha256("".join(expected_lines).encode()).hexdigest()

    (root / "lib" / "util.py").write_text("X = 2\n", encoding="utf-8")
    assert mf.content_sha256(mf.scan_dir(root)) != first
    (root / "lib" / "util.py").write_text("X = 1\n", encoding="utf-8")
    assert mf.content_sha256(mf.scan_dir(root)) == first
    (root / "lib" / "new.py").write_text("", encoding="utf-8")
    assert mf.content_sha256(mf.scan_dir(root)) != first
    (root / "lib" / "new.py").unlink()
    (root / "lib" / "util.py").rename(root / "lib" / "renamed.py")
    assert mf.content_sha256(mf.scan_dir(root)) != first


def test_symlinks_hidden_files_and_limits_are_refused(tmp_path):
    root = write_connector(tmp_path / "c")
    (root / "link.py").symlink_to(root / "main.py")
    with pytest.raises(mf.ManifestError, match="symlinks are not allowed"):
        mf.scan_dir(root)
    (root / "link.py").unlink()

    (root / ".env").write_text("A=1", encoding="utf-8")
    with pytest.raises(mf.ManifestError, match="hidden files"):
        mf.scan_dir(root)
    (root / ".env").unlink()
    (root / ".git").mkdir()
    with pytest.raises(mf.ManifestError, match="hidden files"):
        mf.scan_dir(root)
    (root / ".git").rmdir()

    (root / "big.bin").write_bytes(b"0" * (mf.MAX_TOTAL_BYTES + 1))
    with pytest.raises(mf.ManifestError, match="MiB in total"):
        mf.scan_dir(root)
    (root / "big.bin").unlink()

    many = root / "many"
    many.mkdir()
    for i in range(mf.MAX_FILES):
        (many / f"f{i}.txt").write_text("x", encoding="utf-8")
    with pytest.raises(mf.ManifestError, match=f"more than {mf.MAX_FILES} files"):
        mf.scan_dir(root)


def test_fifo_and_missing_manifest_are_refused(tmp_path):
    root = tmp_path / "c"
    root.mkdir()
    (root / "main.py").write_text("", encoding="utf-8")
    with pytest.raises(mf.ManifestError, match="connector.yaml is missing"):
        mf.scan_dir(root)
    write_connector(root)
    os.mkfifo(root / "pipe")
    with pytest.raises(mf.ManifestError, match="only regular files"):
        mf.scan_dir(root)


def test_symlinked_root_is_refused(tmp_path):
    root = write_connector(tmp_path / "c")
    (tmp_path / "alias").symlink_to(root)
    with pytest.raises(mf.ManifestError, match="not a directory"):
        mf.scan_dir(tmp_path / "alias")


# --------------------------------------------------------------------------- #
# Interpreter resolution
# --------------------------------------------------------------------------- #


def test_search_path_is_fixed_plus_existing_home_dirs(tmp_path):
    assert mf.search_path(tmp_path) == list(mf.SYSTEM_SEARCH_PATH)
    (tmp_path / ".local" / "bin").mkdir(parents=True)
    assert mf.search_path(tmp_path) == [*mf.SYSTEM_SEARCH_PATH, str(tmp_path / ".local" / "bin")]


def test_interpreter_resolves_on_the_fixed_path_to_a_real_path(tmp_path, monkeypatch):
    bindir = tmp_path / "home" / ".local" / "bin"
    bindir.mkdir(parents=True)
    real = tmp_path / "opt" / "fakeruby" / "1.0" / "bin" / "ruby-1.0"
    real.parent.mkdir(parents=True)
    real.write_bytes(b"\xcf\xfa\xed\xfe fake binary")  # not a #! script
    real.chmod(0o755)
    (bindir / "ruby").symlink_to(real)
    monkeypatch.setattr(mf, "SYSTEM_SEARCH_PATH", ())
    resolved = mf.resolve_interpreter("ruby", tmp_path, home=tmp_path / "home")
    assert resolved == Path(os.path.realpath(real))
    assert mf.interpreter_prefix(resolved) == Path(os.path.realpath(real)).parent.parent
    with pytest.raises(mf.InterpreterError, match="was not found"):
        mf.resolve_interpreter("node", tmp_path, home=tmp_path / "home")
    # PATH from the environment is never used
    monkeypatch.setenv("PATH", str(bindir))
    with pytest.raises(mf.InterpreterError, match="was not found"):
        mf.resolve_interpreter("ruby", tmp_path, home=tmp_path / "elsewhere")


def test_version_manager_shims_are_not_searched_and_scripts_are_skipped(tmp_path, monkeypatch):
    """BE-C3: ``~/.pyenv/shims`` is not on the search path; a #! script found first (a shim or
    wrapper, which cannot run in the sandbox) is skipped for a real binary later on the path."""
    home = tmp_path / "home"
    (home / ".pyenv" / "shims").mkdir(parents=True)
    assert str(home / ".pyenv" / "shims") not in mf.search_path(home)
    first, second = tmp_path / "a", tmp_path / "b"
    for folder in (first, second):
        folder.mkdir()
    shim = first / "ruby"
    shim.write_text("#!/usr/bin/env bash\nexec pyenv exec ruby\n", encoding="utf-8")
    shim.chmod(0o755)
    monkeypatch.setattr(mf, "SYSTEM_SEARCH_PATH", (str(first),))
    with pytest.raises(mf.InterpreterError, match="only to scripts"):
        mf.resolve_interpreter("ruby", tmp_path, home=home)
    binary = second / "ruby"
    binary.write_bytes(b"\xcf\xfa\xed\xfe")
    binary.chmod(0o755)
    monkeypatch.setattr(mf, "SYSTEM_SEARCH_PATH", (str(first), str(second)))
    assert mf.resolve_interpreter("ruby", tmp_path, home=home) == Path(os.path.realpath(binary))


def test_relative_executable_inside_the_dir(tmp_path):
    root = write_connector(tmp_path / "c")
    tool = root / "bin" / "conv"
    tool.parent.mkdir()
    tool.write_text("#!/bin/sh\n", encoding="utf-8")
    with pytest.raises(mf.InterpreterError, match="not an executable"):
        mf.resolve_interpreter("./bin/conv", root)
    tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    assert mf.resolve_interpreter("./bin/conv", root) == Path(os.path.realpath(tool))
    with pytest.raises(mf.InterpreterError):
        mf.resolve_interpreter("./missing", root)


def test_xcrun_shim_resolves_to_the_developer_python(tmp_path, monkeypatch):
    dev = tmp_path / "Developer"
    real = dev / "Library" / "Frameworks" / "Python3.framework" / "Versions" / "3.9" / "bin" / "python3.9"
    real.parent.mkdir(parents=True)
    real.write_text("", encoding="utf-8")
    real.chmod(0o755)
    (dev / "usr" / "bin").mkdir(parents=True)
    (dev / "usr" / "bin" / "python3").symlink_to(real)
    shim = tmp_path / "usr-bin" / "python3"  # stands in for Apple's /usr/bin/python3 stub
    shim.parent.mkdir()
    shim.write_text("", encoding="utf-8")
    shim.chmod(0o755)
    monkeypatch.setattr(mf, "developer_dir", lambda: dev)
    monkeypatch.setattr(mf, "XCRUN_SHIMS", frozenset({os.path.realpath(shim)}))
    monkeypatch.setattr(mf.shutil, "which", lambda name, path=None: str(shim))
    assert mf.resolve_interpreter("python3", tmp_path) == Path(os.path.realpath(real))


def test_system_prefixes_are_not_widened():
    assert mf.interpreter_prefix(Path("/usr/bin/perl")) is None
    assert mf.interpreter_prefix(Path("/bin/sh")) is None
    assert mf.interpreter_prefix(Path("/opt/homebrew/bin/node")) is None
    framework = Path("/opt/homebrew/Cellar/python@3.13/3.13.1/Frameworks/Python.framework/Versions/3.13")
    assert mf.interpreter_prefix(framework / "bin" / "python3.13") == framework


@needs_python3
def test_load_dir_pins_the_interpreter_and_reports_problems(tmp_path):
    root = write_connector(tmp_path / "c")
    loaded = mf.load_dir(root)
    assert loaded.interpreter.is_absolute() and loaded.interpreter.exists()
    assert loaded.content_sha256 == mf.content_sha256(mf.scan_dir(root))
    (root / "connector.yaml").write_text(
        (root / "connector.yaml").read_text().replace("[python3, main.py]", "[./run.sh]"),
        encoding="utf-8",
    )
    with pytest.raises(mf.ManifestError, match=r"\./run\.sh is not a file"):
        mf.load_dir(root)
