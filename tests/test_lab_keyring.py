"""The bridge harness's file keyring (``parity/python/lab_keyring.py``, S31a spec 9.2): a keyring
backend over a 0600 JSON file inside the lab tree, read by ``sync_keys.gid_salt``. Synthetic only."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import keyring
import pytest

from cashu.core import sync_keys

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from parity.python import lab_keyring  # a namespace package under the repo root

VAULT = "0123456789abcdef0123456789abcdef"
SALT_HEX = bytes(range(32)).hex()


@pytest.fixture
def lab(tmp_path, monkeypatch):
    root = tmp_path / "cashu-lab"
    (root / "run" / "keys").mkdir(parents=True)
    monkeypatch.setattr(lab_keyring, "LAB_ROOT", root)
    path = root / "run" / "keys" / "keyring.json"
    monkeypatch.setenv(lab_keyring.ENV, str(path))
    previous = keyring.get_keyring()
    keyring.set_keyring(lab_keyring.FileKeyring())
    sync_keys.forget_cached_salts()
    yield path
    keyring.set_keyring(previous)
    sync_keys.forget_cached_salts()


def test_set_get_delete_in_the_exact_format_with_mode_0600(lab):
    assert keyring.get_password("cashu", "x") is None and not lab.exists()
    keyring.set_password("cashu", sync_keys.salt_entry_name(VAULT), SALT_HEX)
    assert oct(lab.stat().st_mode & 0o777) == "0o600"
    assert json.loads(lab.read_text()) == {
        "format": 1,
        "entries": {"cashu": {f"cashu.vault.{VAULT}.gidsalt": SALT_HEX}},
    }
    assert keyring.get_password("cashu", f"cashu.vault.{VAULT}.gidsalt") == SALT_HEX
    keyring.delete_password("cashu", f"cashu.vault.{VAULT}.gidsalt")
    assert json.loads(lab.read_text()) == {"format": 1, "entries": {}}
    with pytest.raises(keyring.errors.PasswordDeleteError):
        keyring.delete_password("cashu", "missing")
    assert [p.name for p in lab.parent.iterdir()] == ["keyring.json"]  # no temp file left


def test_gid_salt_reads_a_file_the_daemon_wrote(lab):
    """The TS daemon writes the file; Python reads the salt through keyring."""
    lab.write_text(json.dumps({"format": 1, "entries": {"cashu": {f"cashu.vault.{VAULT}.gidsalt": SALT_HEX}}}))
    lab.chmod(0o600)
    salt = sync_keys.gid_salt(VAULT)
    assert salt is not None and salt.expose() == bytes(range(32))
    assert sync_keys.det_gid(salt, "profile_modules", ["budget"])  # usable for DET gids


def test_refuses_a_path_outside_the_lab(lab, tmp_path, monkeypatch):
    monkeypatch.setenv(lab_keyring.ENV, str(tmp_path / "elsewhere.json"))
    with pytest.raises(lab_keyring.LabKeyringRefused):
        keyring.get_password("cashu", "x")
    escape = lab.parent / "link.json"
    escape.symlink_to(tmp_path / "elsewhere.json")  # resolved path is what counts
    monkeypatch.setenv(lab_keyring.ENV, str(escape))
    with pytest.raises(lab_keyring.LabKeyringRefused):
        keyring.set_password("cashu", "x", "y")
    assert not (tmp_path / "elsewhere.json").exists()
    monkeypatch.delenv(lab_keyring.ENV)
    with pytest.raises(lab_keyring.LabKeyringRefused):
        keyring.get_password("cashu", "x")


def test_the_lab_root_compares_case_insensitively(lab, monkeypatch):
    upper = str(lab).replace("cashu-lab", "CASHU-LAB")
    monkeypatch.setenv(lab_keyring.ENV, upper)
    if os.path.exists(os.path.dirname(upper)):  # a case-insensitive file system (APFS default)
        keyring.set_password("cashu", "x", "y")
        assert keyring.get_password("cashu", "x") == "y"


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o604])
def test_refuses_a_file_readable_by_others(lab, mode):
    lab.write_text(json.dumps({"format": 1, "entries": {}}))
    lab.chmod(mode)
    with pytest.raises(lab_keyring.LabKeyringRefused):
        keyring.get_password("cashu", "x")
    # not a KeyringError: gid_salt must not quietly treat a refused file as "no keychain"
    with pytest.raises(lab_keyring.LabKeyringRefused):
        sync_keys.gid_salt(VAULT)


@pytest.mark.parametrize(
    "doc",
    [{"format": 2, "entries": {}}, {"entries": {}}, {"format": 1, "entries": {"cashu": {"x": 1}}}, [], {"format": 1, "entries": {}, "x": 1}],
)
def test_refuses_another_format(lab, doc):
    lab.write_text(json.dumps(doc))
    lab.chmod(0o600)
    with pytest.raises(lab_keyring.LabKeyringRefused):
        keyring.get_password("cashu", "x")


def test_not_viable_for_auto_detection_without_the_file(monkeypatch):
    monkeypatch.delenv(lab_keyring.ENV, raising=False)
    assert not lab_keyring.FileKeyring.viable
