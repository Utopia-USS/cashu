"""SEC-1: the suite-wide keyring guard. Nothing in a test reaches the developer's real Keychain, even
without asking for a ``memory_keyring`` fixture."""

from __future__ import annotations

import os
import subprocess
import sys

import keyring
import pytest

from cashu.core import secrets


def test_secrets_go_to_the_in_memory_keyring_without_any_fixture():
    from connector_support import MemoryKeyring

    assert isinstance(keyring.get_keyring(), MemoryKeyring)
    secrets.set_connector_secret(secrets.connector_secret_name("guard-test", "jan", 1, "api_key"), "x")
    assert keyring.get_keyring().store  # landed in memory


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS keychain backend")
def test_the_real_macos_backend_fails_loudly():
    from keyring.backends import macOS

    with pytest.raises(AssertionError, match="real OS keychain"):
        macOS.Keyring().get_password("cashu", "guard-test")


def test_subprocesses_get_the_failing_backend():
    assert os.environ["PYTHON_KEYRING_BACKEND"] == "keyring.backends.fail.Keyring"
    out = subprocess.run(
        [sys.executable, "-c", "import keyring; print(type(keyring.get_keyring()).__module__)"],
        capture_output=True, text=True, check=True,
    )
    assert out.stdout.strip() == "keyring.backends.fail"
