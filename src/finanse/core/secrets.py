"""Secrets in the OS keychain via ``keyring`` (macOS Keychain, Windows Credential
Manager, Secret Service on Linux).

``finanse secrets set|get|delete <name>`` manages them; settings read the keychain
first and fall back to environment variables (CI / development). Never log or
print a secret value: use ``mask()`` for a safe preview.
"""

from __future__ import annotations

import logging

SERVICE = "finanse"
ANTHROPIC = "anthropic"

# name -> what it is (shown in the CLI help)
KNOWN: dict[str, str] = {
    ANTHROPIC: "Anthropic API key for the `anthropic` categorization backend",
}

log = logging.getLogger(__name__)


class SecretsError(RuntimeError):
    """The keychain is unavailable or refused the operation."""


def _check(name: str) -> None:
    if name not in KNOWN:
        raise ValueError(f"unknown secret {name!r} (known: {', '.join(sorted(KNOWN))})")


def get_secret(name: str) -> str | None:
    """The stored value, or None when unset or when no keychain is available."""
    import keyring
    from keyring.errors import KeyringError

    _check(name)
    try:
        return keyring.get_password(SERVICE, name) or None
    except KeyringError as e:  # no backend / locked keychain: callers fall back to env
        log.debug("keychain unavailable for %s: %s", name, type(e).__name__)
        return None


def set_secret(name: str, value: str) -> None:
    import keyring
    from keyring.errors import KeyringError

    _check(name)
    if not value:
        raise ValueError("empty secret")
    try:
        keyring.set_password(SERVICE, name, value)
    except KeyringError as e:
        raise SecretsError(f"could not store {name!r} in the keychain: {type(e).__name__}") from None


def delete_secret(name: str) -> bool:
    """Remove the secret; False when it was not stored."""
    import keyring
    from keyring.errors import KeyringError, PasswordDeleteError

    _check(name)
    try:
        keyring.delete_password(SERVICE, name)
    except PasswordDeleteError:
        return False
    except KeyringError as e:
        raise SecretsError(f"could not delete {name!r}: {type(e).__name__}") from None
    return True


def backend_name() -> str:
    import keyring

    backend = keyring.get_keyring()
    return f"{type(backend).__module__}.{type(backend).__name__}"


def mask(value: str | None) -> str:
    """Safe preview: the first 3 and last 4 characters of a long value, else stars."""
    if not value:
        return "-"
    if len(value) < 16:
        return "*" * 8
    return f"{value[:3]}...{value[-4:]}"
