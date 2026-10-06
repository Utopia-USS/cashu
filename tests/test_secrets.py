"""Secrets in the OS keychain (`cashu secrets ...`), env fallback, no leaks.

An in-memory keyring backend replaces the real one for every test, so the
macOS Keychain / Windows Credential Manager is never touched."""

from __future__ import annotations

import logging

import keyring
import pytest
from keyring.backend import KeyringBackend
from keyring.errors import KeyringError, NoKeyringError, PasswordDeleteError
from typer.testing import CliRunner

from cashu.config import Settings
from cashu.core import secrets

FAKE_KEY = "sk-ant-test-0000000000000000000000000000"


class MemoryKeyring(KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        if self.store.pop((service, username), None) is None:
            raise PasswordDeleteError("not found")


class BrokenKeyring(KeyringBackend):
    priority = 1

    def get_password(self, service, username):
        raise NoKeyringError("no backend")

    def set_password(self, service, username, password):
        raise KeyringError("locked")

    def delete_password(self, service, username):
        raise KeyringError("locked")


@pytest.fixture(autouse=True)
def memory_keyring(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CASHU_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    previous = keyring.get_keyring()
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    yield backend
    keyring.set_keyring(previous)


def test_set_get_delete_roundtrip(memory_keyring):
    assert secrets.get_secret("anthropic") is None
    secrets.set_secret("anthropic", FAKE_KEY)
    assert memory_keyring.store == {("cashu", "anthropic"): FAKE_KEY}
    assert secrets.get_secret("anthropic") == FAKE_KEY
    assert secrets.delete_secret("anthropic") is True
    assert secrets.delete_secret("anthropic") is False
    assert secrets.get_secret("anthropic") is None


def test_unknown_names_and_empty_values_are_refused():
    with pytest.raises(ValueError, match="unknown secret"):
        secrets.get_secret("bank-password")
    with pytest.raises(ValueError):
        secrets.set_secret("anthropic", "")


def test_settings_prefer_keychain_then_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-global-env-key-000000")
    assert Settings(_env_file=None).resolved_api_key == "sk-global-env-key-000000"
    monkeypatch.setenv("CASHU_ANTHROPIC_API_KEY", "sk-cashu-env-key-00000")
    assert Settings(_env_file=None).resolved_api_key == "sk-cashu-env-key-00000"
    secrets.set_secret("anthropic", FAKE_KEY)
    assert Settings(_env_file=None).resolved_api_key == FAKE_KEY


def test_settings_never_show_the_env_secret(monkeypatch):
    monkeypatch.setenv("CASHU_ANTHROPIC_API_KEY", "sk-cashu-env-key-00000")
    s = Settings(_env_file=None)
    assert "sk-cashu-env-key" not in repr(s)
    assert "sk-cashu-env-key" not in str(s.model_dump())


def test_missing_keychain_falls_back_to_env_without_leaking(monkeypatch, caplog):
    keyring.set_keyring(BrokenKeyring())
    monkeypatch.setenv("CASHU_ANTHROPIC_API_KEY", "sk-cashu-env-key-00000")
    with caplog.at_level(logging.DEBUG):
        assert secrets.get_secret("anthropic") is None
        assert Settings(_env_file=None).resolved_api_key == "sk-cashu-env-key-00000"
    assert "sk-cashu-env-key" not in caplog.text
    with pytest.raises(secrets.SecretsError) as err:
        secrets.set_secret("anthropic", FAKE_KEY)
    assert FAKE_KEY not in str(err.value)


def test_mask():
    assert secrets.mask(None) == "-"
    assert secrets.mask("short") == "********"
    assert secrets.mask(FAKE_KEY) == "sk-...0000"
    assert FAKE_KEY not in secrets.mask(FAKE_KEY)


def test_cli_set_get_delete(memory_keyring):
    from cashu.cli import app

    runner = CliRunner()
    stored = runner.invoke(app, ["secrets", "set", "anthropic", "--stdin"], input=FAKE_KEY + "\n")
    assert stored.exit_code == 0, stored.output
    assert FAKE_KEY not in stored.output
    assert memory_keyring.store[("cashu", "anthropic")] == FAKE_KEY

    shown = runner.invoke(app, ["secrets", "get", "anthropic"])
    assert shown.exit_code == 0 and FAKE_KEY not in shown.output and "sk-...0000" in shown.output
    revealed = runner.invoke(app, ["secrets", "get", "anthropic", "--reveal"])
    assert revealed.stdout.strip() == FAKE_KEY

    deleted = runner.invoke(app, ["secrets", "delete", "anthropic"])
    assert deleted.exit_code == 0 and "deleted" in deleted.output
    missing = runner.invoke(app, ["secrets", "get", "anthropic"])
    assert missing.exit_code == 1 and "not in the keychain" in missing.output


def test_cli_prompt_hides_input(memory_keyring):
    from cashu.cli import app

    result = CliRunner().invoke(app, ["secrets", "set", "anthropic"], input=FAKE_KEY + "\n")
    assert result.exit_code == 0, result.output
    assert FAKE_KEY not in result.output  # hidden prompt does not echo
    assert memory_keyring.store[("cashu", "anthropic")] == FAKE_KEY


def test_cli_rejects_unknown_secret_names():
    from cashu.cli import app

    result = CliRunner().invoke(app, ["secrets", "set", "bank-password", "--stdin"], input="x\n")
    assert result.exit_code != 0
